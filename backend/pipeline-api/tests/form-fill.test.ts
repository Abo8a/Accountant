// ИИ раскладывает текст полей (из брифа и документов) по анкетам: «да/нет», таблицы, отметки.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRequest } from '@passport/contracts';
import { FIELD_FORM_SHAPES, PASSPORT_SECTIONS, sanitizeFieldForm } from '@passport/contracts';
import { handlePipeline } from '../src/pipeline/handler';
import { loadCabinetState } from '../src/pipeline/state';
import { FakeLlm } from '../src/llm/fake';
import { briefAndConfirm, createTestDb, createUser, makeDeps, type TestDb } from './helpers';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await db.sql.query('UPDATE app_settings SET guard_threshold_block = 0.05, guard_threshold_warn = 0.1 WHERE id = 1');
});

const PASSING = {
  is_student_or_postgraduate: true,
  has_open_fsi_contracts_or_applications: false,
  has_prior_student_startup_grant: false,
  ready_to_open_llc_after_win: true,
};

const req = (userId: string, extra: Partial<PipelineRequest> = {}): PipelineRequest => ({
  user_id: userId,
  action: 'init_or_upload',
  program: 'Студенческий стартап',
  eligibility: PASSING,
  text_input: 'Сервис помощи студентам с поиском попутчиков по маршруту и расписанию занятий. Студенты тратят много времени на поиск попутчиков в чатах.',
  ...extra,
});

const TEXTS: Record<string, string> = {
  team_members: 'Иван Иванов отвечает за разработку, Мария Петрова — за продукт и интервью.',
  active_obligations: 'Есть договор НИОКР с вузом до декабря 2026 года на разработку модуля расписания.',
  previous_grants_and_statuses: 'Ранее грантов и статусов команда не получала, поддержки не было.',
  ip_rights_and_authors: 'Авторы кода — Иван Иванов и Мария Петрова, права у авторов до регистрации ООО.',
};

const extraction = () => ({
  fields: PASSPORT_SECTIONS.flatMap((s) =>
    s.fields.map((f) => ({
      section_id: s.id,
      field_key: f,
      value: f === 'direction' ? 'Н1' : f === 'tech_challenge' ? '1' : (TEXTS[f] ?? `Значение поля ${f}: сервис помощи студентам с поиском попутчиков.`),
      claims: [],
    })),
  ),
});

/** Модель раскладывает 4 поля; у грантов — выдуманный вариант выбора (не из списка), его анкета не сохраняется. */
const fillForms = (input: any) => ({
  forms: [
    { section_id: 2, field_key: 'team_members', data: { rows: [{ name: 'Иван Иванов', role: 'разработка', extra: 'x' }, { name: 'Мария Петрова', role: 'продукт и интервью' }] } },
    { section_id: 10, field_key: 'active_obligations', data: { choice: 'Есть', text: 'договор НИОКР с вузом до декабря 2026' } },
    { section_id: 10, field_key: 'previous_grants_and_statuses', data: { choice: 'Скорее нет' } },
    { section_id: 9, field_key: 'ip_rights_and_authors', data: { flags: ['Иван Иванов', 'Мария Петрова', 'Чужой'], inputs: { owner: 'авторы до регистрации ООО' } } },
  ].filter((f) => input.fields.some((x: any) => x.field_key === f.field_key)),
});

async function formsOf(userId: string) {
  const deps = makeDeps(db, new FakeLlm());
  const state = await loadCabinetState(deps, (await db.store.loadContext(userId))!);
  return Object.fromEntries(state.passport.filter((f) => f.form_data).map((f) => [`${f.section_id}/${f.field_key}`, f.form_data]));
}

describe('анкеты из текста, собранного ИИ', { timeout: 300_000 }, () => {
  it('после брифа поля с анкетой получают заполненную анкету; выбор не из списка не сохраняется', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({ extract: extraction, fill_forms: fillForms });
    await briefAndConfirm(makeDeps(db, llm), req(userId));

    const call = llm.calls.find((c) => c.task === 'fill_forms')!;
    expect(call).toBeDefined();
    const keys = call.input.fields.map((f: any) => `${f.section_id}/${f.field_key}`);
    expect(keys).toContain('10/active_obligations');
    expect(keys).not.toContain('3/problem_description'); // у поля нет анкеты
    expect(call.input.fields.find((f: any) => f.field_key === 'active_obligations').shape).toEqual(FIELD_FORM_SHAPES['10/active_obligations']);

    const forms = await formsOf(userId);
    expect(forms['10/active_obligations']).toEqual({ choice: 'Есть', flags: [], inputs: {}, rows: [], text: 'договор НИОКР с вузом до декабря 2026' });
    expect(forms['2/team_members']).toMatchObject({ rows: [{ name: 'Иван Иванов', role: 'разработка' }, { name: 'Мария Петрова', role: 'продукт и интервью' }] });
    expect((forms['2/team_members'] as any).rows[0]).not.toHaveProperty('extra');
    // Авторы — только имена из команды
    expect(forms['9/ip_rights_and_authors']).toMatchObject({ flags: ['Иван Иванов', 'Мария Петрова'], inputs: { owner: 'авторы до регистрации ООО', others: '' } });
    expect(forms['10/previous_grants_and_statuses']).toBeUndefined();
  });

  it('сбой модели на раскладке не ломает сборку паспорта', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({
      extract: extraction,
      fill_forms: () => {
        throw new Error('модель недоступна');
      },
    });
    const res = await briefAndConfirm(makeDeps(db, llm), req(userId));
    expect(res.status).not.toBe('ERROR');
    expect(await formsOf(userId)).toEqual({});
  });

  it('«Проверить» раскладывает по анкетам уже собранный паспорт, анкету студента не трогает', async () => {
    const userId = await createUser(db.sql);
    // Паспорт собран без раскладки (как до этого изменения)
    const old = new FakeLlm({ extract: extraction });
    const deps = makeDeps(db, old);
    await briefAndConfirm(deps, req(userId));
    expect(await formsOf(userId)).toEqual({});

    const own = { choice: 'Нет', flags: [], inputs: {}, rows: [], text: '' };
    await handlePipeline(
      deps,
      req(userId, {
        action: 'save_draft',
        text_input: undefined,
        form: [{ section_id: 10, field_key: 'active_obligations', value: 'Открытых договоров и обязательств нет.' }],
        field_form: { section_id: 10, field_key: 'active_obligations', data: own },
      }),
    );

    const llm = new FakeLlm({ extract: extraction, fill_forms: fillForms });
    await handlePipeline(makeDeps(db, llm), req(userId, { action: 'review_edits', text_input: undefined }));
    const forms = await formsOf(userId);
    expect(forms['10/active_obligations']).toEqual(own);
    expect(forms['2/team_members']).toBeDefined();
  });

  it('sanitizeFieldForm: только известные колонки и варианты из списка', () => {
    const shape = FIELD_FORM_SHAPES['10/previous_grants_and_statuses']!;
    expect(sanitizeFieldForm(shape, { choice: 'Получали', rows: [{ kind: 'Грант ФСИ', name: 'УМНИК', year: '2025' }, { kind: 'Выдумано', year: '2024' }] })).toEqual({
      choice: 'Получали',
      flags: [],
      inputs: {},
      rows: [
        { kind: 'Грант ФСИ', name: 'УМНИК', year: '2025' },
        { kind: '', name: '', year: '2024' },
      ],
      text: '',
    });
    expect(sanitizeFieldForm(shape, { choice: 'может быть' })).toBeNull();
    expect(sanitizeFieldForm(shape, null)).toBeNull();
    expect(sanitizeFieldForm(FIELD_FORM_SHAPES['4/core_features']!, { rows: [] })).toBeNull();
  });
});
