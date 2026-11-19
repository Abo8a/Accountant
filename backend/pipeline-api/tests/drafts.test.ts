// «Сохранить» без моделей (save_draft) и «Проверить» по всем сохранённым правкам разом (review_edits).
import { beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRequest } from '@passport/contracts';
import { PASSPORT_SECTIONS } from '@passport/contracts';
import { handlePipeline, isAiAction } from '../src/pipeline/handler';
import { loadCabinetState } from '../src/pipeline/state';
import { FakeLlm } from '../src/llm/fake';
import { pipelineRequestSchema } from '../src/pipeline/validation';
import { briefAndConfirm, createTestDb, createUser, makeDeps, type TestDb } from './helpers';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await db.sql.query('UPDATE app_settings SET guard_threshold_block = 0.05, guard_threshold_warn = 0.1 WHERE id = 1');
});

const BRIEF =
  'Сервис помощи студентам с поиском попутчиков по маршруту и расписанию занятий. ' +
  'Студенты тратят много времени на поиск попутчиков в чатах.';

const PASSING = {
  is_student_or_postgraduate: true,
  has_open_fsi_contracts_or_applications: false,
  has_prior_student_startup_grant: false,
  ready_to_open_llc_after_win: true,
};

const VALID_BUDGET = [
  { stage: 1 as const, category: 'other' as const, title: 'Консультации', quantity: 1, unit_price: 20000, amount: 20000, justification: 'Консультации' },
  { stage: 2 as const, category: 'contractor' as const, title: 'Разработка интерфейса', quantity: 1, unit_price: 250000, amount: 250000, justification: 'Подрядчик' },
  { stage: 2 as const, category: 'equipment' as const, title: 'Ноутбук', quantity: 2, unit_price: 100000, amount: 200000, justification: 'Техника' },
  { stage: 2 as const, category: 'salary' as const, title: 'Зарплата разработчика', quantity: 10, unit_price: 50000, amount: 500000, justification: 'Разработка' },
  { stage: 2 as const, category: 'other' as const, title: 'Хостинг и сервисы', quantity: 1, unit_price: 30000, amount: 30000, justification: 'Инфраструктура' },
];

const req = (userId: string, extra: Partial<PipelineRequest> = {}): PipelineRequest => ({
  user_id: userId,
  action: 'init_or_upload',
  program: 'Студенческий стартап',
  eligibility: PASSING,
  ...extra,
});

const fullExtraction = () => ({
  fields: PASSPORT_SECTIONS.flatMap((s) =>
    s.fields.map((f) => {
      const value = f === 'direction' ? 'Н1' : f === 'tech_challenge' ? '1' : `Значение поля ${f} для проекта: сервис помощи студентам с поиском попутчиков.`;
      return { section_id: s.id, field_key: f, value, claims: [] };
    }),
  ),
});

const recordOf = async (userId: string, sectionId: number, fieldKey: string) => {
  const { rows } = await db.sql.query(
    `SELECT r.value, r.review_status::text AS review_status, r.form_data FROM project_passport_records r
       JOIN app_projects p ON p.id = r.project_id
      WHERE p.user_id = $1::uuid AND r.section_id = $2 AND r.field_key = $3`,
    [userId, sectionId, fieldKey],
  );
  return rows[0] as { value: string; review_status: string; form_data: unknown } | undefined;
};

async function project(userId: string, llm: FakeLlm) {
  const deps = makeDeps(db, llm);
  await handlePipeline(deps, req(userId, { action: 'submit_form', budget_items: VALID_BUDGET }));
  const res = await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
  expect(res.status).toBe('COMPLETED');
  return deps;
}

const newLlm = () =>
  new FakeLlm({
    extract: fullExtraction,
    novelty: () => ({ analogues_count: 2, analogues_list: ['А', 'Б'], has_measurable_comparison: true, missing_details_question: null }),
  });

const tasks = (llm: FakeLlm) => llm.calls.map((c) => c.task);

const TEAM_TEXT = 'Иван Иванов — разработка, Мария Петрова — продукт и интервью со студентами сервиса попутчиков.';
const MARKET_TEXT = 'Студенты очных программ вузов Самары — около 40 000 человек по данным статистики вузов региона.';

describe('«Сохранить» без проверки моделью', { timeout: 300_000 }, () => {
  it('поле пишется дословно, модели не вызываются, правка ждёт проверки', async () => {
    const userId = await createUser(db.sql);
    const llm = newLlm();
    const deps = await project(userId, llm);
    const before = llm.calls.length;

    const res = await handlePipeline(
      deps,
      req(userId, {
        action: 'save_draft',
        form: [{ section_id: 2, field_key: 'team_members', value: TEAM_TEXT }],
        field_form: { section_id: 2, field_key: 'team_members', data: { rows: [{ name: 'Иван Иванов' }] } },
      }),
    );
    expect(res).toEqual({ status: 'SAVED', pending_review: ['2/team_members'] });
    expect(llm.calls.length).toBe(before);

    const rec = await recordOf(userId, 2, 'team_members');
    expect(rec?.value).toBe(TEAM_TEXT);
    expect(['approved', 'needs_review']).not.toContain(rec?.review_status); // ещё не проверено
    expect(rec?.form_data).toEqual({ rows: [{ name: 'Иван Иванов' }] });

    const state = await loadCabinetState(deps, (await db.store.loadContext(userId))!);
    expect(state.pending_review).toEqual(['2/team_members']);
    const team = state.passport.find((f) => f.field_key === 'team_members')!;
    expect(team.claims).toHaveLength(1);
    expect(team.claims[0]).toMatchObject({ claim_text: TEAM_TEXT, origin: 'user' });
  });

  it('смета и направление тоже сохраняются без моделей; повторное сохранение копит список', async () => {
    const userId = await createUser(db.sql);
    const llm = newLlm();
    const deps = await project(userId, llm);
    const before = llm.calls.length;

    await handlePipeline(deps, req(userId, { action: 'save_draft', form: [{ section_id: 7, field_key: 'market_overview', value: MARKET_TEXT }] }));
    await handlePipeline(deps, req(userId, { action: 'save_draft', form: [{ section_id: 4, field_key: 'direction', value: 'Н2' }] }));
    const res = await handlePipeline(deps, req(userId, { action: 'save_draft', budget_items: VALID_BUDGET.slice(0, 4) }));
    expect(res).toEqual({ status: 'SAVED', pending_review: ['7/market_overview', '4/direction', 'budget'] });
    expect(llm.calls.length).toBe(before);
    expect((await recordOf(userId, 4, 'direction'))?.value).toBe('Н2');
    expect((await recordOf(userId, 4, 'tech_challenge'))?.value ?? '').toBe(''); // вызов Н1 снят вместе со сменой направления
  });

  it('неверное значение — ошибка, ничего не сохраняется', async () => {
    const userId = await createUser(db.sql);
    const deps = await project(userId, newLlm());
    const res = await handlePipeline(deps, req(userId, { action: 'save_draft', form: [{ section_id: 4, field_key: 'direction', value: 'Н9' }] }));
    expect(res).toMatchObject({ status: 'ERROR', code: 'INVALID_FIELD_VALUE' });
    const state = await loadCabinetState(deps, (await db.store.loadContext(userId))!);
    expect(state.pending_review).toEqual([]);
  });

  it('сохранение бесплатно, «Проверить» — ИИ-действие', () => {
    expect(isAiAction({ user_id: 'u', program: 'p', action: 'save_draft' })).toBe(false);
    expect(isAiAction({ user_id: 'u', program: 'p', action: 'review_edits' })).toBe(true);
    const base = { user_id: '00000000-0000-4000-8000-000000000001' };
    expect(pipelineRequestSchema.safeParse({ ...base, action: 'save_draft' }).success).toBe(true);
    expect(pipelineRequestSchema.safeParse({ ...base, action: 'review_edits' }).success).toBe(true);
  });
});

describe('«Проверить» — все правки разом', { timeout: 300_000 }, () => {
  it('один вызов упаковки на все поля, затем аудит; форма анкеты остаётся, список правок очищается', async () => {
    const userId = await createUser(db.sql);
    const llm = newLlm();
    const deps = await project(userId, llm);
    const form = { rows: [{ name: 'Иван Иванов' }] };
    await handlePipeline(
      deps,
      req(userId, {
        action: 'save_draft',
        form: [{ section_id: 2, field_key: 'team_members', value: TEAM_TEXT }],
        field_form: { section_id: 2, field_key: 'team_members', data: form },
      }),
    );
    await handlePipeline(deps, req(userId, { action: 'save_draft', form: [{ section_id: 7, field_key: 'market_overview', value: MARKET_TEXT }] }));

    const before = llm.calls.length;
    const res = await handlePipeline(deps, req(userId, { action: 'review_edits' }));
    expect(res.status).not.toBe('ERROR');
    const made = tasks(llm).slice(before);
    // Одна упаковка на обе правки — не по вызову на каждое поле
    expect(made.filter((t) => t === 'extract')).toHaveLength(1);
    const extractInput = llm.calls[before + made.indexOf('extract')]!.input;
    expect(extractInput.fields.map((f: any) => `${f.section_id}/${f.field_key}`).sort()).toEqual(['2/team_members', '7/market_overview']);
    // Аудит изменённых блоков — один раз на всю проверку
    expect(made.filter((t) => t === 'audit')).toHaveLength(1);

    expect((await recordOf(userId, 2, 'team_members'))?.form_data).toEqual(form);
    const state = await loadCabinetState(deps, (await db.store.loadContext(userId))!);
    expect(state.pending_review).toEqual([]);
    expect(state.block_audits.length).toBeGreaterThan(0);
  });

  it('без правок «Проверить» не вызывает упаковку', async () => {
    const userId = await createUser(db.sql);
    const llm = newLlm();
    const deps = await project(userId, llm);
    const before = llm.calls.length;
    const res = await handlePipeline(deps, req(userId, { action: 'review_edits' }));
    expect(res.status).not.toBe('ERROR');
    expect(tasks(llm).slice(before)).not.toContain('extract');
  });

  it('без паспорта — понятная ошибка', async () => {
    const userId = await createUser(db.sql);
    const res = await handlePipeline(makeDeps(db, newLlm()), req(userId, { action: 'review_edits' }));
    expect(res).toMatchObject({ status: 'ERROR', code: 'INVALID_FIELD_VALUE' });
  });

  it('в состоянии кабинета есть подсказки ко всем полям, с примером заполнения', async () => {
    const userId = await createUser(db.sql);
    const deps = await project(userId, newLlm());
    const state = await loadCabinetState(deps, (await db.store.loadContext(userId))!);
    const total = PASSPORT_SECTIONS.reduce((n, s) => n + s.fields.length, 0);
    expect(Object.keys(state.field_hints)).toHaveLength(total);
    expect(state.field_hints['2/team_members']?.example).toContain('В команде 3 человека');
    expect(state.field_hints['2/team_members']?.criteria).toBeTruthy();
  });
});
