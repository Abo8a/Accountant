// Тестовая БД: PGlite (Postgres в процессе) + pgvector. Те же миграции, что для Supabase.
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { randomUUID } from 'node:crypto';
import { applyMigrations } from '../src/db/migrate';
import { fromPglite, type SqlClient } from '../src/db/sql';
import { PassportStore } from '../src/db/store';
import { loadKbManifest } from '../src/kb/manifest';
import { FakeLlm } from '../src/llm/fake';
import { DEFAULT_MANIFEST_PATH, SUPABASE_DIR } from '../src/config';
import type { DocumentParser, ParsedDocument } from '../src/parser/client';
import type { PipelineDeps } from '../src/pipeline/deps';
import { handlePipeline } from '../src/pipeline/handler';
import type { PipelineRequest, PipelineResponse } from '@passport/contracts';

export interface TestDb {
  pg: PGlite;
  sql: SqlClient;
  store: PassportStore;
}

/** Supabase-окружение: схема auth, роли anon/authenticated, затем миграции и seed. */
export async function createTestDb(opts: { devSeed?: boolean } = {}): Promise<TestDb> {
  const pg = await PGlite.create({ extensions: { vector } });
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, raw_user_meta_data jsonb);
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  // pgcrypto недоступен в PGlite; gen_random_uuid() — встроенная функция PostgreSQL 13+, поэтому пропускаем расширение
  const base = fromPglite(pg);
  const sql: SqlClient = {
    query: base.query,
    exec: (text) => base.exec(text.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;/g, '')),
  };
  await applyMigrations(sql, SUPABASE_DIR, { devSeed: opts.devSeed });
  return { pg, sql, store: new PassportStore(sql) };
}

/** Создаёт пользователя через auth.users (триггер создаёт профиль). */
export async function createUser(
  sql: SqlClient,
  opts: { name?: string; status?: string; plan?: 'pro' | 'premium' | 'free' } = {},
): Promise<string> {
  const id = randomUUID();
  await sql.query('INSERT INTO auth.users (id, raw_user_meta_data) VALUES ($1::uuid, $2::jsonb)', [
    id,
    JSON.stringify({ name: opts.name ?? 'Иван Иванов', status: opts.status ?? 'student' }),
  ]);
  if (opts.plan && opts.plan !== 'free') {
    await sql.query(
      `INSERT INTO billing_subscriptions (user_id, plan_id, expires_at) VALUES ($1::uuid, $2, now() + interval '30 days')`,
      [id, opts.plan],
    );
  }
  return id;
}

/** Парсер-заглушка: отдаёт заранее заданный документ по file_url. */
export class FakeParser implements DocumentParser {
  constructor(private readonly docs: Record<string, ParsedDocument>) {}
  async parse(file: { file_name: string; file_url: string }): Promise<ParsedDocument> {
    const doc = this.docs[file.file_url];
    if (!doc) throw new Error(`no fake document for ${file.file_url}`);
    return doc;
  }
}

export function makeDeps(db: TestDb, llm = new FakeLlm(), parser: DocumentParser = new FakeParser({})): PipelineDeps {
  return {
    store: db.store,
    llm,
    parser,
    kb: loadKbManifest(DEFAULT_MANIFEST_PATH),
    logger: { error: () => {}, warn: () => {}, info: () => {} },
  };
}

/**
 * Бриф и подтверждение направления, как на экране «Направление проекта»: направление и вызов выбирает студент,
 * предложение сборки он принимает как есть (или передаёт своё). Возвращает ответ после подтверждения.
 */
export async function briefAndConfirm(
  deps: PipelineDeps,
  request: PipelineRequest,
  choice?: { direction: string; tech_challenge?: string | null },
): Promise<PipelineResponse> {
  const first = await handlePipeline(deps, request);
  if (first.status !== 'NEED_USER_INPUT' || first.target_field?.field_key !== 'direction') return first;
  return confirmDirection(deps, request, first, choice);
}

/** Отправляет выбор направления (и вызова) в ответ на вопрос о направлении. */
export async function confirmDirection(
  deps: PipelineDeps,
  request: PipelineRequest,
  question: PipelineResponse,
  choice?: { direction: string; tech_challenge?: string | null },
): Promise<PipelineResponse> {
  const suggestion = question.status === 'NEED_USER_INPUT' ? question.suggestion : undefined;
  const direction = choice?.direction ?? suggestion?.direction ?? 'Н1';
  const challenge = choice ? choice.tech_challenge ?? null : suggestion?.tech_challenge ?? null;
  return handlePipeline(deps, {
    user_id: request.user_id,
    program: request.program,
    eligibility: request.eligibility,
    skipped_fields: request.skipped_fields,
    action: 'submit_form',
    form: [
      { section_id: 4, field_key: 'direction', value: direction },
      ...(challenge ? [{ section_id: 4, field_key: 'tech_challenge', value: challenge }] : []),
    ],
  });
}
