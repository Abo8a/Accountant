// Регрессии по живому аудиту LLM (docs/reports/LLM-RAG-audit-2026-11-18.md, раздел 4):
// формат ответа аудита от реальных моделей, вердикт новизны, анти-фрод на точечных ответах, RAG без тихого отката.
import { beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRequest } from '@passport/contracts';
import { PASSPORT_SECTIONS } from '@passport/contracts';
import { handlePipeline } from '../src/pipeline/handler';
import { auditPassport } from '../src/pipeline/audit';
import { FakeLlm } from '../src/llm/fake';
import { auditOutputSchema, normalizeFatalStopFactors, noveltyVerdict, validateSchema } from '../src/llm/schemas';
import { getRagDb } from '../src/rag/db';
import { LLM_TIMEOUT_MS } from '../src/llm';
import { createTestDb, createUser, makeDeps, type TestDb } from './helpers';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await db.sql.query('UPDATE app_settings SET guard_threshold_block = 0.05, guard_threshold_warn = 0.1 WHERE id = 1');
});

describe('схема аудита: ответы реальных моделей', () => {
  it('записи «проверено — не обнаружено» (detected:false) не считаются стоп-факторами', () => {
    // Дословная форма ответа deepseek-v4.1-flash для гражданского проекта (живой прогон 18.11.2026)
    const out = auditOutputSchema.parse({
      fatal_stop_factors: [
        { code: 'MILITARY_OR_DUAL_USE', detected: false, reason: 'Признаков нет.', how_to_fix: null },
        { code: 'NO_TECH_BASIS', detected: false, reason: 'Основа есть.', how_to_fix: null },
      ],
      block_audits: [],
      novelty_audit: null,
      budget_audit: null,
    });
    expect(out.fatal_stop_factors).toEqual([]);
  });

  it('ключ factor вместо code и объект вместо массива разбираются, а не роняют пайплайн', () => {
    const viaFactor = auditOutputSchema.parse({
      fatal_stop_factors: [
        { factor: 'MILITARY_OR_DUAL_USE', detected: false, reason: 'нет' },
        { factor: 'NO_TECH_BASIS', detected: true, reason: 'Кофейня без технологии', how_to_fix: 'Переформулировать' },
      ],
      block_audits: [],
    });
    expect(viaFactor.fatal_stop_factors.map((f) => f.code)).toEqual(['NO_TECH_BASIS']);

    expect(normalizeFatalStopFactors({ code: 'MILITARY_OR_DUAL_USE', reason: 'Боевой дрон' })).toHaveLength(1);
    expect(normalizeFatalStopFactors({ MILITARY_OR_DUAL_USE: { detected: false }, NO_TECH_BASIS: { detected: true, reason: 'нет основы' } }))
      .toEqual([{ code: 'NO_TECH_BASIS', detected: true, reason: 'нет основы' }]);
    expect(normalizeFatalStopFactors({})).toEqual([]);
  });

  it('неизвестный код отбрасывается, а не превращается в NO_TECH_BASIS', () => {
    expect(normalizeFatalStopFactors([{ code: 'NONE', reason: 'стоп-факторов нет' }])).toEqual([]);
  });

  it('novelty_audit без счёта аналогов — вердикт неизвестен, а не «0 аналогов, не пройдено»', () => {
    const parsed = auditOutputSchema.parse({ block_audits: [], novelty_audit: { status: 'approved', remark: null } });
    expect(noveltyVerdict(parsed.novelty_audit, 2)).toEqual({ known: false });

    const full = auditOutputSchema.parse({
      block_audits: [],
      novelty_audit: { analogues_count: 3, has_measurable_comparison: true, passed: true },
    });
    expect(noveltyVerdict(full.novelty_audit, 2)).toMatchObject({ known: true, passed: true, analogues_count: 3 });

    const weak = auditOutputSchema.parse({
      block_audits: [],
      novelty_audit: { analogues_count: 1, has_measurable_comparison: true, passed: true, how_to_fix: 'Назовите второй аналог' },
    });
    expect(noveltyVerdict(weak.novelty_audit, 2)).toMatchObject({ known: true, passed: false, question: 'Назовите второй аналог' });
  });
});

describe('схема ответа валидатора', () => {
  it('нестандартный claim_kind от модели не роняет принятый ответ', () => {
    // Дословно из живого прогона: принятый ответ превращался в INTERNAL из-за claim_kind вне списка
    const out = validateSchema.parse({
      is_valid: true,
      rejection_reason: null,
      formatted_value: 'Нет, никаких обязательств нет.',
      claims: [{ claim_text: 'Нет, никаких обязательств нет.', claim_type: 'client_statement', claim_kind: 'absence_of_open_obligations', source_id: null, source_locator: null, confidence: 0.85 }],
    });
    expect(out.claims[0].claim_kind).toBeNull();
  });
});

describe('аудит: блок 6 и ложные стоп-факторы', { timeout: 30000 }, () => {
  it('блок 6, одобренный моделью, одобряется, даже если novelty_audit пришёл без счёта аналогов', async () => {
    const userId = await createUser(db.sql);
    const projectId = await db.store.ensureProject(userId);
    await db.store.upsertField(projectId, 6, 'analogues_comparison', 'Cognex In-Sight D900 от 1,5 млн руб.; ручной ВИК 2–3 мин на 1 м шва.');
    await db.store.upsertField(projectId, 6, 'novelty_hypothesis', 'Полнота обнаружения не ниже 0,85 при стоимости до 300 тыс. руб.');
    await db.store.upsertField(projectId, 6, 'verification_protocol', 'Сравнение с заключением специалиста ВИК II уровня на 300 образцах.');

    const llm = new FakeLlm({
      audit: () => ({
        // так ответил kimi-k3 на живом прогоне: блок 6 одобрен, novelty_audit — без счёта аналогов
        fatal_stop_factors: [{ code: 'MILITARY_OR_DUAL_USE', detected: false, reason: 'Гражданский проект.' }],
        block_audits: [{ section_id: 6, status: 'approved', remark: null, how_to_fix: null, failed_fields: [] }],
        novelty_audit: { status: 'approved', remark: null, how_to_fix: null },
        budget_audit: { status: 'not_provided', remark: null, how_to_fix: null },
      }),
    });
    const report = await auditPassport(makeDeps(db, llm), projectId);

    expect(report.fatal_stop_factors).toEqual([]);
    expect(report.block_audits.find((b) => b.section_id === 6)).toMatchObject({ status: 'approved' });
    expect(report.block_audits.find((b) => b.section_id === 3)?.remark ?? '').not.toContain('Фатальный стоп-фактор');
  });
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

const fullExtraction = () => ({
  fields: PASSPORT_SECTIONS.flatMap((s) =>
    s.fields.map((f) => ({
      section_id: s.id,
      field_key: f,
      value: f === 'direction' ? 'Н1' : f === 'tech_challenge' ? '1' : `Значение поля ${f} для проекта: сервис помощи студентам с поиском попутчиков.`,
      claims: [],
    })),
  ),
});

const OFF_TOPIC = 'Кулинарный рецепт пирога с яблоками и корицей';
const OFF_TOPIC_LONG =
  'Кулинарный рецепт пирога с яблоками и корицей: замесить песочное тесто на сливочном масле, выложить в форму, ' +
  'добавить нарезанные яблоки с сахаром и корицей, выпекать сорок минут при температуре сто восемьдесят градусов.';

// Сквозные сценарии: RAG-поиск внутри пайплайна идёт в локальную базу знаний и API эмбеддингов (20–30 с на сценарий).
describe('анти-фрод на точечных ответах', { timeout: 120000 }, () => {
  it('ответ по блоку вне якоря (10) не сверяется с якорем и не блокируется', async () => {
    // Честные ответы по блокам 7–10 на qwen3-embedding-8b дают сходство 0.26–0.48 — по тексту они не похожи на якорь
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, new FakeLlm({ extract: fullExtraction }));
    await handlePipeline(deps, req(userId, { text_input: BRIEF }));
    const res = await handlePipeline(
      deps,
      req(userId, { action: 'submit_answer', target_field: { section_id: 10, field_key: 'active_obligations' }, text_input: OFF_TOPIC }),
    );
    expect(res.status).not.toBe('BLOCKED_PROJECT_SWAP');
  });

  it('развёрнутый ответ по блоку якоря (3) по-прежнему сверяется и блокируется при подмене', async () => {
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, new FakeLlm({ extract: fullExtraction }));
    await handlePipeline(deps, req(userId, { text_input: BRIEF }));
    const res = await handlePipeline(
      deps,
      req(userId, { action: 'submit_answer', target_field: { section_id: 3, field_key: 'problem_description' }, text_input: OFF_TOPIC_LONG }),
    );
    expect(res).toMatchObject({ status: 'BLOCKED_PROJECT_SWAP' });
  });

  it('короткий ответ по блоку якоря не сверяется с якорем (мало текста — ложные блокировки), его проверяет валидатор', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({ extract: fullExtraction });
    const deps = makeDeps(db, llm);
    await handlePipeline(deps, req(userId, { text_input: BRIEF }));
    const res = await handlePipeline(
      deps,
      req(userId, { action: 'submit_answer', target_field: { section_id: 3, field_key: 'problem_description' }, text_input: OFF_TOPIC }),
    );
    expect(res.status).not.toBe('BLOCKED_PROJECT_SWAP');
    const validation = llm.calls.filter((c) => c.task === 'validate_answer').at(-1);
    expect(validation?.input).toMatchObject({ project_summary: expect.any(String) });
  });

  it('форма с полями вне блоков 3–4 не блокируется', async () => {
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, new FakeLlm({ extract: fullExtraction }));
    await handlePipeline(deps, req(userId, { text_input: BRIEF }));
    const res = await handlePipeline(
      deps,
      req(userId, { action: 'submit_form', form: [{ section_id: 8, field_key: 'legal_entity_info', value: OFF_TOPIC }] }),
    );
    expect(res.status).not.toBe('BLOCKED_PROJECT_SWAP');
  });
});

describe('инфраструктура вызовов', () => {
  it('таймаут вызова модели больше замеренного времени полной сборки и аудита (до ~222 с)', () => {
    expect(LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
  });

  it('RAG: недоступный Postgres даёт ошибку, а не тихий откат на пустой локальный PGlite', async () => {
    await expect(getRagDb('postgres://user:pass@127.0.0.1:1/none')).rejects.toThrow(/PostgreSQL недоступен/);
  });
});
