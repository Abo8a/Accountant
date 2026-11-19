import { beforeAll, describe, expect, it } from 'vitest';
import { buildPassportFields, extractPassport } from '../src/pipeline/passport';
import { FakeLlm } from '../src/llm/fake';
import { createTestDb, createUser, makeDeps, type TestDb } from './helpers';

// Происхождение утверждений паспорта: «с ваших слов» (user) и «Дописано ИИ» (ai), миграция 0014.

const USER_SENTENCE = 'Провели две фокус-группы, 24 участника.';
const AI_SENTENCE = 'Сервис монетизируется через подписку и партнёрские скидки.';
const VALUE = `${USER_SENTENCE} ${AI_SENTENCE}`;
const BRIEF = 'Мы делаем приложение для студентов. Провели две фокус-группы, 24 участника.';

const claim = (text: string) => ({
  claim_text: text,
  claim_type: 'client_statement' as const,
  claim_kind: 'sentence' as const,
  source_id: null,
  source_locator: null,
  confidence: 0.9,
});

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

async function originsOf(projectId: string, key: string): Promise<Record<string, string>> {
  const records = await db.store.getRecords(projectId);
  const field = buildPassportFields(records).find((f) => f.field_key === key)!;
  return Object.fromEntries(field.claims.map((c) => [c.claim_text, c.origin]));
}

describe('origin утверждений', { timeout: 60000 }, () => {
  it('сборка из брифа: слова студента — user, добавленное моделью — ai', async () => {
    const projectId = await db.store.ensureProject(await createUser(db.sql, { name: 'Анна' }));
    const llm = new FakeLlm({
      extract: () => ({
        fields: [{ section_id: 3, field_key: 'problem_description', value: VALUE, claims: [claim(USER_SENTENCE), claim(AI_SENTENCE)] }],
      }),
    });
    await extractPassport(makeDeps(db, llm), projectId, 'Студенческий стартап', BRIEF, []);

    expect(await originsOf(projectId, 'problem_description')).toEqual({ [USER_SENTENCE]: 'user', [AI_SENTENCE]: 'ai' });
  });

  it('привязка к документу студента — user, даже если слов в брифе нет', async () => {
    const userId = await createUser(db.sql, { name: 'Борис' });
    const projectId = await db.store.ensureProject(userId);
    const sourceId = await db.sql
      .query(
        `INSERT INTO project_sources (project_id, file_name, file_url, sha256_hash, extracted_text) VALUES ($1::uuid, 'doc.txt', 'local://doc.txt', 'h-origin', $2) RETURNING id`,
        [projectId, USER_SENTENCE],
      )
      .then((r) => r.rows[0].id as string);
    const sources = await db.store.listSources(projectId);
    const llm = new FakeLlm({
      extract: () => ({
        fields: [
          {
            section_id: 3,
            field_key: 'problem_description',
            value: USER_SENTENCE,
            claims: [{ ...claim(USER_SENTENCE), claim_type: 'fact' as const, source_id: sourceId, source_locator: { page: 1, quote: USER_SENTENCE } }],
          },
        ],
      }),
    });
    await extractPassport(makeDeps(db, llm), projectId, 'Студенческий стартап', '', sources);

    expect(await originsOf(projectId, 'problem_description')).toEqual({ [USER_SENTENCE]: 'user' });
  });

  it('повторная сборка: утверждение сохраняет прежнее происхождение, новый текст оценивается заново', async () => {
    const projectId = await db.store.ensureProject(await createUser(db.sql, { name: 'Вера' }));
    const first = new FakeLlm({
      extract: () => ({
        fields: [{ section_id: 3, field_key: 'problem_description', value: VALUE, claims: [claim(USER_SENTENCE), claim(AI_SENTENCE)] }],
      }),
    });
    await extractPassport(makeDeps(db, first), projectId, 'Студенческий стартап', BRIEF, []);

    // Студент сохраняет поле через форму: весь текст теперь «его», но прежняя метка ИИ у дописанного остаётся.
    const form = [{ section_id: 3, field_key: 'problem_description', value: `${VALUE} Пользователи ждут уведомлений.` }];
    const second = new FakeLlm({
      extract: () => ({
        fields: [
          {
            section_id: 3,
            field_key: 'problem_description',
            value: form[0]!.value,
            claims: [claim(USER_SENTENCE), claim(AI_SENTENCE), claim('Пользователи ждут уведомлений.')],
          },
        ],
      }),
    });
    await extractPassport(makeDeps(db, second), projectId, 'Студенческий стартап', '', [], form);

    expect(await originsOf(projectId, 'problem_description')).toEqual({
      [USER_SENTENCE]: 'user',
      [AI_SENTENCE]: 'ai',
      'Пользователи ждут уведомлений.': 'user',
    });
  });

  it('утверждения без origin в БД (до миграции) отдаются как слова студента', async () => {
    const projectId = await db.store.ensureProject(await createUser(db.sql, { name: 'Глеб' }));
    const recordId = await db.store.upsertField(projectId, 3, 'problem_description', USER_SENTENCE);
    await db.sql.query(`INSERT INTO project_claims (record_id, claim_text, claim_type) VALUES ($1::uuid, $2, 'hypothesis')`, [recordId, USER_SENTENCE]);

    expect(await originsOf(projectId, 'problem_description')).toEqual({ [USER_SENTENCE]: 'user' });
  });

  it('БД не принимает происхождение вне user / ai', async () => {
    const projectId = await db.store.ensureProject(await createUser(db.sql, { name: 'Дина' }));
    const recordId = await db.store.upsertField(projectId, 3, 'problem_description', USER_SENTENCE);
    await expect(
      db.sql.query(`INSERT INTO project_claims (record_id, claim_text, claim_type, origin) VALUES ($1::uuid, 'x', 'fact', 'robot')`, [recordId]),
    ).rejects.toThrow();
  });
});
