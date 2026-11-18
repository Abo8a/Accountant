// Регрессии P1 по живому аудиту LLM (docs/reports/LLM-RAG-audit-2026-11-18.md, раздел 5):
// заглушки и сочинительство сборки, ранний отказ по стоп-фактору, точечный ре-аудит вместо полного на каждый ответ.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRequest } from '@passport/contracts';
import { PASSPORT_SECTIONS } from '@passport/contracts';
import { handlePipeline } from '../src/pipeline/handler';
import { stripMetaStubs } from '../src/pipeline/passport';
import { FakeLlm } from '../src/llm/fake';
import { resolveLlmParams } from '../src/llm/openai';
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

const req = (userId: string, extra: Partial<PipelineRequest> = {}): PipelineRequest => ({
  user_id: userId,
  action: 'init_or_upload',
  program: 'Студенческий стартап',
  eligibility: PASSING,
  ...extra,
});

const fieldValue = (sectionId: number, f: string) =>
  f === 'direction' ? 'Н1' : f === 'tech_challenge' ? '1' : `Значение поля ${f} для проекта: сервис помощи студентам с поиском попутчиков.`;

const fullExtraction = (override: Record<string, string | null> = {}) => () => ({
  fields: PASSPORT_SECTIONS.flatMap((s) =>
    s.fields.map((f) => ({
      section_id: s.id,
      field_key: f,
      value: `${s.id}/${f}` in override ? override[`${s.id}/${f}`] : fieldValue(s.id, f),
      claims: [],
    })),
  ),
});

describe('сборка: служебные заглушки вместо сведений', () => {
  it('предложения-заглушки вырезаются, а поле только из заглушки становится пустым', () => {
    // Дословно из живого прогона extract (18.11.2026)
    expect(stripMetaStubs('Сведения об открытых договорах или обязательствах, конфликтующих с новым грантом, не предоставлены.')).toBeNull();
    expect(stripMetaStubs('Сведения о ранее полученных грантах ФСИ, статусе резидента Сколково или другой поддержке не предоставлены.')).toBeNull();
    expect(
      stripMetaStubs(
        'Планируемая модель — B2B-продажа комплекса малым предприятиям. Ориентир цены — около 300 тыс. ₽ за комплекс. Дополнительно может рассматриваться сопровождение; условия требуют проверки.',
      ),
    ).toBe('Планируемая модель — B2B-продажа комплекса малым предприятиям. Ориентир цены — около 300 тыс. ₽ за комплекс.');
  });

  it('содержательный ответ и явное отсутствие со слов студента не трогаются', () => {
    expect(stripMetaStubs('Грантов ФСИ и другой поддержки не получали.')).toBe('Грантов ФСИ и другой поддержки не получали.');
    expect(stripMetaStubs('ООО пока не создано, будет зарегистрировано после подписания договора.')).toBe(
      'ООО пока не создано, будет зарегистрировано после подписания договора.',
    );
  });

  it('поле, которое модель заполнила заглушкой, остаётся пробелом, и студента о нём спрашивают', async () => {
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, new FakeLlm({ extract: fullExtraction({ '2/team_members': 'Сведения о составе команды не предоставлены.' }) }));
    const res = await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    expect(res).toMatchObject({ status: 'NEED_USER_INPUT', target_field: { section_id: 2, field_key: 'team_members' } });
    if (res.status !== 'NEED_USER_INPUT') return;
    expect(res.passport?.find((f) => f.section_id === 2 && f.field_key === 'team_members')?.value ?? null).toBeNull();
  }, 120_000);
});

describe('ранний отказ по стоп-фактору (до сборки паспорта)', () => {
  it('проверка идёт на канале DeepSeek с коротким рассуждением', () => {
    expect(resolveLlmParams('screen')).toEqual({ reasoningEffort: 'low', temperature: 0.1 });
  });

  it('военная тема в брифе: паспорт не собирается, студента просят описать проект заново', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({
      screen: () => ({
        fatal_stop_factors: [{ code: 'MILITARY_OR_DUAL_USE', reason: 'Система наведения для ударного БПЛА.', how_to_fix: 'Опишите гражданское применение.' }],
      }),
    });
    const res = await handlePipeline(makeDeps(db, llm), req(userId, { text_input: 'Система наведения ударного БПЛА на цель по видео.' }));
    expect(res).toMatchObject({ status: 'WAITING_FOR_INITIAL_BRIEF', step: 'INITIAL_BRIEF' });
    if (res.status !== 'WAITING_FOR_INITIAL_BRIEF') return;
    expect(res.fatal_stop_factors?.[0].code).toBe('MILITARY_OR_DUAL_USE');
    expect(res.rejection_reason).toContain('ударного БПЛА');
    expect(llm.calls.map((c) => c.task)).toEqual(['screen']);
  });

  it('записи «не обнаружено» и сбой проверки не останавливают студента', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({
      screen: () => ({ fatal_stop_factors: [{ code: 'NO_TECH_BASIS', detected: false, reason: 'Основа есть.' }] }),
      extract: fullExtraction(),
    });
    const res = await handlePipeline(makeDeps(db, llm), req(userId, { text_input: BRIEF }));
    expect(res.status).not.toBe('WAITING_FOR_INITIAL_BRIEF');
    expect(llm.calls.some((c) => c.task === 'extract')).toBe(true);

    const userId2 = await createUser(db.sql);
    const failing = new FakeLlm({ screen: () => { throw new Error('timeout'); }, extract: fullExtraction() });
    const res2 = await handlePipeline(makeDeps(db, failing), req(userId2, { text_input: BRIEF }));
    expect(res2.status).not.toBe('ERROR');
    expect(failing.calls.some((c) => c.task === 'extract')).toBe(true);
  }, 120_000);
});

describe('точечный ре-аудит (6.1) вместо полного аудита на каждый ответ', { timeout: 240_000 }, () => {
  it('блок перепроверяется один раз, когда студент ответил на все его замечания; остальные блоки модель не переоценивает', async () => {
    const userId = await createUser(db.sql);
    const auditInputs: any[] = [];
    const llm = new FakeLlm({
      extract: fullExtraction(),
      audit: (input: any) => {
        auditInputs.push(input);
        const primary = auditInputs.length === 1;
        return {
          fatal_stop_factors: [],
          block_audits: input.open_blocks.map((b: any) =>
            primary && (b.section_id === 3 || b.section_id === 7)
              ? {
                  section_id: b.section_id,
                  status: 'needs_revision',
                  remark: `Замечание первичного аудита к блоку ${b.section_id}.`,
                  how_to_fix: 'Уточните.',
                  failed_fields: PASSPORT_SECTIONS.find((s) => s.id === b.section_id)!.fields.slice(0, 2),
                }
              : { section_id: b.section_id, status: 'approved', remark: null, how_to_fix: null, failed_fields: [] },
          ),
          novelty_audit: { analogues_count: 2, analogues_list: ['А', 'Б'], has_measurable_comparison: true, passed: true },
          budget_audit: { status: 'not_provided', remark: null, how_to_fix: null },
        };
      },
    });
    const deps = makeDeps(db, llm);

    const first = await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    expect(auditInputs).toHaveLength(1);
    expect(first).toMatchObject({ status: 'NEED_USER_INPUT', target_field: { section_id: 3, field_key: 'problem_description' } });

    // Ответ на первое из двух замечаний блока 3: блок ещё не доработан — аудит не вызывается
    const second = await handlePipeline(
      deps,
      req(userId, {
        action: 'submit_answer',
        target_field: { section_id: 3, field_key: 'problem_description' },
        text_input: 'Студенты тратят до часа в день на поиск попутчиков по маршруту и расписанию занятий в чатах.',
      }),
    );
    expect(auditInputs).toHaveLength(1);
    expect(second).toMatchObject({ status: 'NEED_USER_INPUT', target_field: { section_id: 3, field_key: 'target_audience' } });
    if (second.status !== 'NEED_USER_INPUT') return;
    expect(second.rejection_reason).toBe('Замечание первичного аудита к блоку 3.');

    // Второй ответ закрывает блок 3: ре-аудит блока 3 и размороженного им связанного блока 4 (карта зависимостей: 3 → 4, 7);
    // блок 7 ждёт правок студента — он лишь контекст и с прежним вердиктом
    const third = await handlePipeline(
      deps,
      req(userId, {
        action: 'submit_answer',
        target_field: { section_id: 3, field_key: 'target_audience' },
        text_input: 'Студенты очной формы, которые ищут попутчиков по маршруту и расписанию занятий из пригородов.',
      }),
    );
    expect(auditInputs).toHaveLength(2);
    expect(auditInputs[1].mode).toBe('delta_reaudit');
    expect(auditInputs[1].open_blocks.map((b: any) => b.section_id)).toEqual([3, 4]);
    expect(auditInputs[1].pending_blocks.map((b: any) => b.section_id)).toEqual([7]);
    expect(third).toMatchObject({ status: 'NEED_USER_INPUT', target_field: { section_id: 7 } });
    if (third.status !== 'NEED_USER_INPUT') return;
    expect(third.block_audits?.find((b) => b.section_id === 3)?.status).toBe('approved');
    expect(third.block_audits?.find((b) => b.section_id === 7)?.remark).toBe('Замечание первичного аудита к блоку 7.');
  });

  it('при стоп-факторе первым спрашивается затронутый блок, а не следующий по порядку', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({
      extract: fullExtraction(),
      audit: (input: any) => ({
        fatal_stop_factors: [{ code: 'NO_TECH_BASIS', reason: 'Кофейня без технологии.', how_to_fix: 'Опишите разработку.', affected_sections: [3, 4] }],
        block_audits: input.open_blocks.map((b: any) =>
          b.section_id === 2
            ? { section_id: 2, status: 'needs_revision', remark: 'Нет ролей.', how_to_fix: 'Добавьте роли.', failed_fields: ['team_members'] }
            : { section_id: b.section_id, status: 'approved', remark: null, how_to_fix: null, failed_fields: [] },
        ),
        budget_audit: { status: 'not_provided', remark: null, how_to_fix: null },
      }),
    });
    const res = await briefAndConfirm(makeDeps(db, llm), req(userId, { text_input: BRIEF }));
    expect(res).toMatchObject({ status: 'NEED_USER_INPUT', target_field: { section_id: 3 } });
    if (res.status !== 'NEED_USER_INPUT') return;
    expect(res.fatal_stop_factors?.[0].code).toBe('NO_TECH_BASIS');
    expect(res.rejection_reason ?? '').toContain('Кофейня без технологии');
  });
});
