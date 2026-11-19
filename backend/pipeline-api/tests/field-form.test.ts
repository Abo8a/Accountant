// Интерактивные анкеты: форма поля (field_form) хранится рядом с текстом и отдаётся в состоянии кабинета (миграция 0016).
import { beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRequest } from '@passport/contracts';
import { PASSPORT_SECTIONS } from '@passport/contracts';
import { handlePipeline } from '../src/pipeline/handler';
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

const req = (userId: string, extra: Partial<PipelineRequest> = {}): PipelineRequest => ({
  user_id: userId,
  action: 'init_or_upload',
  program: 'Студенческий стартап',
  eligibility: PASSING,
  ...extra,
});

/** Команда не заполнена — по ней будет вопрос; остальные поля есть. */
const extraction = () => ({
  fields: PASSPORT_SECTIONS.flatMap((s) =>
    s.fields.map((f) => ({
      section_id: s.id,
      field_key: f,
      value:
        s.id === 2 && f === 'team_members'
          ? null
          : f === 'direction'
            ? 'Н1'
            : f === 'tech_challenge'
              ? '1'
              : `Значение поля ${f} для проекта: сервис помощи студентам с поиском попутчиков.`,
      claims: [],
    })),
  ),
});

const TEAM = { rows: [{ name: 'Иван Иванов', role: 'разработка, backend' }, { name: 'Мария Петрова', role: 'продукт и интервью' }] };
const TEAM_TEXT = 'В команде 2 человека: Иван Иванов (разработка, backend), Мария Петрова (продукт и интервью).';
const TF = { section_id: 2, field_key: 'team_members' };

async function formOf(userId: string, sectionId: number, fieldKey: string): Promise<unknown> {
  const { rows } = await db.sql.query(
    `SELECT r.form_data FROM project_passport_records r JOIN app_projects p ON p.id = r.project_id
      WHERE p.user_id = $1::uuid AND r.section_id = $2 AND r.field_key = $3`,
    [userId, sectionId, fieldKey],
  );
  return rows[0]?.form_data ?? null;
}

function llm(valid = true) {
  return new FakeLlm({
    extract: extraction,
    validate_answer: (input: any) => {
      const answer = String(input.answer).replace(/<[^>]+>/g, '').trim();
      // ИИ переписывает ответ своими словами — форма из текста не восстанавливается, поэтому хранится отдельно
      return valid
        ? { is_valid: true, rejection_reason: null, formatted_value: `Команда: ${answer}`, claims: [] }
        : { is_valid: false, rejection_reason: 'Укажите роль каждого участника.', formatted_value: null, claims: [] };
    },
  });
}

describe('форма поля рядом с текстом', { timeout: 300_000 }, () => {
  it('принятый ответ из формы: форма сохраняется и приходит в состоянии кабинета вместе с переписанным текстом', async () => {
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, llm());
    await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    await handlePipeline(deps, req(userId, { action: 'submit_answer', target_field: TF, text_input: TEAM_TEXT, field_form: { ...TF, data: TEAM } }));
    expect(await formOf(userId, 2, 'team_members')).toEqual(TEAM);

    const ctx = (await db.store.loadContext(userId))!;
    const state = await loadCabinetState(deps, ctx);
    const team = state.passport.find((f) => f.section_id === 2 && f.field_key === 'team_members')!;
    expect(team.value).toBe(`Команда: ${TEAM_TEXT}`);
    expect(team.form_data).toEqual(TEAM);
    expect(state.passport.find((f) => f.field_key === 'problem_description')?.form_data).toBeUndefined();
  });

  it('отклонённый ответ: форма не сохраняется', async () => {
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, llm(false));
    await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    const res = await handlePipeline(deps, req(userId, { action: 'submit_answer', target_field: TF, text_input: TEAM_TEXT, field_form: { ...TF, data: TEAM } }));
    expect(res.status).toBe('ANSWER_REJECTED');
    expect(await formOf(userId, 2, 'team_members')).toBeNull();
  });

  it('форма другого поля, чем то, на которое отвечают, не сохраняется', async () => {
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, llm());
    await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    await handlePipeline(
      deps,
      req(userId, { action: 'submit_answer', target_field: TF, text_input: TEAM_TEXT, field_form: { section_id: 3, field_key: 'problem_description', data: TEAM } }),
    );
    expect(await formOf(userId, 3, 'problem_description')).toBeNull();
  });

  it('текст поля поменяли другим путём — форма сбрасывается (триггер 0016)', async () => {
    const userId = await createUser(db.sql);
    const deps = makeDeps(db, llm());
    await briefAndConfirm(deps, req(userId, { text_input: BRIEF }));
    await handlePipeline(deps, req(userId, { action: 'submit_answer', target_field: TF, text_input: TEAM_TEXT, field_form: { ...TF, data: TEAM } }));
    await db.sql.query(
      `UPDATE project_passport_records r SET value = 'Новый текст команды' FROM app_projects p
        WHERE p.id = r.project_id AND p.user_id = $1::uuid AND r.section_id = 2 AND r.field_key = 'team_members'`,
      [userId],
    );
    expect(await formOf(userId, 2, 'team_members')).toBeNull();
  });

  it('валидация запроса: форма — объект ограниченного размера', () => {
    const base = { user_id: '00000000-0000-4000-8000-000000000001', action: 'submit_answer', target_field: TF };
    expect(pipelineRequestSchema.safeParse({ ...base, field_form: { ...TF, data: TEAM } }).success).toBe(true);
    expect(pipelineRequestSchema.safeParse({ ...base, field_form: { ...TF, data: 'текст' } }).success).toBe(false);
    expect(pipelineRequestSchema.safeParse({ ...base, field_form: { ...TF, data: { text: 'а'.repeat(60_000) } } }).success).toBe(false);
  });
});
