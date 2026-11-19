// Регрессии по сквозному прогону пути студента (19.11.2026): вечный цикл после разморозки, повтор принятого вопроса,
// направление без спроса, справка об обучении, замечания не на русском и со служебными кодами.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PipelineRequest } from '@passport/contracts';
import { PASSPORT_SECTIONS } from '@passport/contracts';
import { handlePipeline } from '../src/pipeline/handler';
import { FakeLlm } from '../src/llm/fake';
import { createPipelineServer } from '../src/server';
import { studentFacingRemark } from '../src/pipeline/remarks';
import { detectCertificateMime } from '../src/pipeline/state';
import { briefAndConfirm, confirmDirection, createTestDb, createUser, makeDeps, type TestDb } from './helpers';

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

const recordOf = async (userId: string, sectionId: number, fieldKey: string) => {
  const { rows } = await db.sql.query(
    `SELECT r.value, r.review_status::text AS review_status FROM project_passport_records r
       JOIN app_projects p ON p.id = r.project_id
      WHERE p.user_id = $1::uuid AND r.section_id = $2 AND r.field_key = $3`,
    [userId, sectionId, fieldKey],
  );
  return rows[0] as { value: string; review_status: string } | undefined;
};

describe('разморозка одобренного блока не зацикливает студента', { timeout: 240_000 }, () => {
  it('ответ в блоке 5 снимает одобрение с блока 2: о блоке 2 без замечаний не спрашивают, он перепроверяется вместе с блоком 5', async () => {
    const userId = await createUser(db.sql);
    const auditInputs: any[] = [];
    const llm = new FakeLlm({
      extract: fullExtraction,
      audit: (input: any) => {
        auditInputs.push(input);
        const primary = auditInputs.length === 1;
        return {
          fatal_stop_factors: [],
          block_audits: input.open_blocks.map((b: any) =>
            primary && b.section_id === 5
              ? {
                  section_id: 5,
                  status: 'needs_revision',
                  remark: 'В календарном плане нет предъявляемых результатов.',
                  how_to_fix: 'Добавьте результат к каждой работе.',
                  failed_fields: ['calendar_plan_stage_1', 'calendar_plan_stage_2'],
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
    expect(first).toMatchObject({ status: 'NEED_USER_INPUT', target_field: { section_id: 5, field_key: 'calendar_plan_stage_1' } });
    expect((await recordOf(userId, 2, 'team_members'))?.review_status).toBe('approved');

    // Первый ответ в блоке 5: блок 2 размораживается (карта зависимостей 5 → 2), но студента дальше спрашивают про блок 5
    const second = await handlePipeline(
      deps,
      req(userId, {
        action: 'submit_answer',
        target_field: { section_id: 5, field_key: 'calendar_plan_stage_1' },
        text_input: 'Месяц 1: интервью с 20 студентами — отчёт; месяц 2: прототип маршрутов — демонстрационная версия.',
      }),
    );
    expect((await recordOf(userId, 2, 'team_members'))?.review_status).toBe('needs_review');
    // Валидатор видит текущий текст поля: ответ на замечание дополняет поле, а не затирает принятые сведения
    const validation = llm.calls.filter((c) => c.task === 'validate_answer').at(-1);
    expect(String(validation?.input.current_value)).toContain('Значение поля calendar_plan_stage_1');
    expect(second).toMatchObject({ status: 'NEED_USER_INPUT', target_field: { section_id: 5, field_key: 'calendar_plan_stage_2' } });
    expect(auditInputs).toHaveLength(1);
    if (second.status !== 'NEED_USER_INPUT') return;
    expect(second.block_audits?.find((b) => b.section_id === 2)?.status).toBe('approved');

    // Второй ответ закрывает блок 5: ре-аудит блока 5 и размороженного блока 2 одним вызовом
    const third = await handlePipeline(
      deps,
      req(userId, {
        action: 'submit_answer',
        target_field: { section_id: 5, field_key: 'calendar_plan_stage_2' },
        text_input: 'Месяцы 3–12: пилот в двух вузах — протокол испытаний; доработка по итогам пилота — версия 1.0.',
      }),
    );
    expect(auditInputs).toHaveLength(2);
    expect(auditInputs[1].open_blocks.map((b: any) => b.section_id).sort()).toEqual([2, 5]);
    expect(third.status === 'NEED_USER_INPUT' && third.target_field?.section_id === 2).toBe(false);
    expect((await recordOf(userId, 2, 'team_members'))?.review_status).toBe('approved');
  });
});

describe('принятый ответ не возвращается вопросом', { timeout: 120_000 }, () => {
  it('утверждения модели, которых нет в тексте ответа, не сохраняются и не снимают одобрение с поля', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({
      extract: () => ({ fields: fullExtraction().fields.map((f) => (f.section_id === 2 && f.field_key === 'team_members' ? { ...f, value: null } : f)) }),
      validate_answer: (input: any) => {
        const answer = String(input.answer).replace(/<[^>]+>/g, '').trim();
        return {
          is_valid: true,
          rejection_reason: null,
          formatted_value: answer,
          claims: [
            { claim_text: answer.slice(0, 40), claim_type: 'client_statement', claim_kind: 'sentence', source_id: null, source_locator: null, confidence: 0.9 },
            // Пересказ, которого нет в тексте поля (в живом прогоне такие давали orphaned → needs_review → повтор вопроса)
            { claim_text: 'Команда из трёх опытных разработчиков', claim_type: 'client_statement', claim_kind: 'sentence', source_id: null, source_locator: null, confidence: 0.9 },
          ],
        };
      },
    });
    const deps = makeDeps(db, llm);
    const first = await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    expect(first).toMatchObject({ target_field: { section_id: 2, field_key: 'team_members' } });

    const next = await handlePipeline(
      deps,
      req(userId, {
        action: 'submit_answer',
        target_field: { section_id: 2, field_key: 'team_members' },
        text_input: 'Иван Петров — руководитель и бэкенд; Мария Соколова — мобильная разработка и дизайн интерфейса.',
      }),
    );
    expect(next.status === 'NEED_USER_INPUT' && next.target_field?.field_key === 'team_members').toBe(false);
    expect((await recordOf(userId, 2, 'team_members'))?.review_status).not.toBe('needs_review');
    const { rows } = await db.sql.query(
      `SELECT c.verification_status::text AS s FROM project_claims c
         JOIN project_passport_records r ON r.id = c.record_id JOIN app_projects p ON p.id = r.project_id
        WHERE p.user_id = $1::uuid AND r.section_id = 2 AND r.field_key = 'team_members'`,
      [userId],
    );
    expect(rows.map((r) => r.s)).not.toContain('orphaned');
  });
});

describe('направление и вызов выбирает студент', { timeout: 120_000 }, () => {
  it('после брифа — вопрос о направлении с предложением, до аудита; предложение не пишется в паспорт', async () => {
    const userId = await createUser(db.sql);
    const llm = new FakeLlm({ extract: fullExtraction });
    const deps = makeDeps(db, llm);
    const res = await handlePipeline(deps, req(userId, { text_input: BRIEF }));
    expect(res).toMatchObject({
      status: 'NEED_USER_INPUT',
      target_field: { section_id: 4, field_key: 'direction' },
      suggestion: { direction: 'Н1', tech_challenge: '1' },
    });
    if (res.status !== 'NEED_USER_INPUT') return;
    expect(res.question).toContain('Н1');
    expect(res.question).toContain('№ 1');
    expect(res.question).toMatch(/Подходят ли/);
    expect(llm.calls.some((c) => c.task === 'audit')).toBe(false);
    expect((await recordOf(userId, 4, 'direction'))?.value ?? null).toBeNull();
    expect((await recordOf(userId, 4, 'tech_challenge'))?.value ?? null).toBeNull();

    // Студент выбирает другое направление без вызова: запись без вызова модели сборки, дальше — аудит
    const extractCalls = llm.calls.filter((c) => c.task === 'extract').length;
    const next = await confirmDirection(deps, req(userId), res, { direction: 'Н2', tech_challenge: null });
    expect(llm.calls.filter((c) => c.task === 'extract').length).toBe(extractCalls);
    expect(llm.calls.some((c) => c.task === 'audit')).toBe(true);
    expect(next.status === 'NEED_USER_INPUT' && next.target_field?.field_key === 'direction').toBe(false);
    expect((await recordOf(userId, 4, 'direction'))?.value).toBe('Н2');
    expect((await recordOf(userId, 4, 'tech_challenge'))?.value ?? null).toBeNull();
  });

  it('промпт сборки не просит вписывать вызов в текст технологии', async () => {
    const { SYSTEM_PROMPTS } = await import('../src/llm/prompts');
    expect(SYSTEM_PROMPTS.extract).not.toContain('Проект соотносится с технологическим вызовом');
    expect(SYSTEM_PROMPTS.extract).toContain('ПРЕДЛОЖЕНИЕ');
  });
});

describe('справка об обучении: обязательна для подачи, но не блокирует паспорт', { timeout: 120_000 }, () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createPipelineServer(makeDeps(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('формат определяется по сигнатуре файла', () => {
    expect(detectCertificateMime(Buffer.from('%PDF-1.7 ...'))).toBe('application/pdf');
    expect(detectCertificateMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectCertificateMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(detectCertificateMime(Buffer.from('MZ\x90\x00'))).toBeNull();
  });

  it('загрузка через API видна в состоянии кабинета; не-PDF и не-изображение отклоняется', async () => {
    const userId = await createUser(db.sql);
    const empty = await (await fetch(`${base}/pipeline/state`, { headers: { 'x-user-id': userId } })).json();
    expect(empty).toMatchObject({ status: 'OK', plan_id: 'free', study_certificate: null, passport: [] });

    const bad = await fetch(`${base}/pipeline/study-certificate`, {
      method: 'POST',
      headers: { 'x-user-id': userId, 'x-file-name': encodeURIComponent('virus.exe') },
      body: Buffer.from('MZ\x90\x00 not a document'),
    });
    expect(bad.status).toBe(422);

    const ok = await fetch(`${base}/pipeline/study-certificate`, {
      method: 'POST',
      headers: { 'x-user-id': userId, 'x-file-name': encodeURIComponent('Справка МГТУ.pdf') },
      body: Buffer.from('%PDF-1.4 справка'),
    });
    expect(ok.status).toBe(200);
    const state = (await (await fetch(`${base}/pipeline/state`, { headers: { 'x-user-id': userId } })).json()) as { study_certificate: unknown };
    expect(state.study_certificate).toMatchObject({ file_name: 'Справка МГТУ.pdf' });
  });

  it('без справки — только предупреждение; итог и готовность к выгрузке те же, что со справкой', async () => {
    const run = async (withCertificate: boolean) => {
      const userId = await createUser(db.sql);
      if (withCertificate) {
        await db.store.saveStudyCertificate(userId, { file_name: 's.pdf', mime_type: 'application/pdf', sha256_hash: 'x', content: Buffer.from('%PDF') });
      }
      const llm = new FakeLlm({
        extract: fullExtraction,
        novelty: () => ({ analogues_count: 2, analogues_list: ['А', 'Б'], has_measurable_comparison: true, missing_details_question: null }),
      });
      const deps = makeDeps(db, llm);
      const budget = [
        { stage: 1 as const, category: 'other' as const, title: 'Регистрация ООО', quantity: 1, unit_price: 20000, amount: 20000, justification: 'Регистрация' },
        { stage: 2 as const, category: 'salary' as const, title: 'Зарплата', quantity: 8, unit_price: 100000, amount: 800000, justification: 'Разработка' },
        { stage: 2 as const, category: 'equipment' as const, title: 'Ноутбук', quantity: 1, unit_price: 130000, amount: 130000, justification: 'Разработка' },
        { stage: 2 as const, category: 'other' as const, title: 'Хостинг', quantity: 1, unit_price: 50000, amount: 50000, justification: 'Сервер' },
      ];
      await handlePipeline(deps, req(userId, { action: 'submit_form', budget_items: budget }));
      return briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    };
    const without = await run(false);
    expect(without.status).toBe('COMPLETED');
    if (without.status !== 'COMPLETED') return;
    expect(without.warnings.join(' ')).toContain('Справка об обучении в вузе не загружена');
    expect(without.checklist.join(' ')).toContain('официальном бланке вуза');

    const withCert = await run(true);
    if (withCert.status !== 'COMPLETED') throw new Error('expected COMPLETED');
    expect(withCert.warnings.join(' ')).not.toContain('Справка об обучении');
    // Справка — предупреждение для подачи, а не блокер паспорта: итог и выгрузка от неё не зависят.
    expect(without.eligibility_status).toBe(withCert.eligibility_status);
    expect(without.export_ready).toBe(withCert.export_ready);
    expect(withCert.checklist.join(' ')).toContain('Проверить загруженную справку');
  });
});

describe('замечания для студента', () => {
  it('без служебных идентификаторов и разумной длины', () => {
    const raw =
      'Не указаны роли участников (kb_07_team_roles, cmp_12). По правилу из rag_context в поле team_members нужны роль и опыт. ' +
      'Допишите роль каждого участника.';
    const clean = studentFacingRemark(raw)!;
    expect(clean).not.toMatch(/kb_|cmp_|rag_context|team_members/);
    expect(clean).toContain('Допишите роль каждого участника.');
    expect(studentFacingRemark('Длинное замечание. '.repeat(80))!.length).toBeLessThanOrEqual(600);
  });

  it('ответ валидатора не на русском: повтор, затем нейтральная подсказка вместо иероглифов', async () => {
    const userId = await createUser(db.sql);
    let validations = 0;
    const llm = new FakeLlm({
      extract: () => ({ fields: fullExtraction().fields.map((f) => (f.section_id === 2 && f.field_key === 'team_members' ? { ...f, value: null } : f)) }),
      validate_answer: () => {
        validations++;
        return { is_valid: false, rejection_reason: '回答不完整，请补充团队成员的角色。', formatted_value: null, claims: [] };
      },
    });
    const deps = makeDeps(db, llm);
    await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    const res = await handlePipeline(
      deps,
      req(userId, { action: 'submit_answer', target_field: { section_id: 2, field_key: 'team_members' }, text_input: 'Иван и Мария, оба студенты.' }),
    );
    expect(validations).toBe(2);
    expect(res).toMatchObject({ status: 'ANSWER_REJECTED' });
    if (res.status !== 'ANSWER_REJECTED') return;
    expect(res.rejection_reason).not.toMatch(/[一-鿿]/);
    expect(res.rejection_reason).toContain('Опишите подробнее');
  }, 120_000);
});
