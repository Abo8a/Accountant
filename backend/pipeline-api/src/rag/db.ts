import pg from 'pg';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { config, PIPELINE_API_DIR } from '../config';
import { fromPgPool, fromPglite, type SqlClient } from '../db/sql';

const { Pool } = pg;

export interface RagDbInstance {
  sql: SqlClient;
  isPglite: boolean;
  close: () => Promise<void>;
}

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS rag_knowledge_cards (
    card_id TEXT PRIMARY KEY,
    source_doc TEXT NOT NULL CHECK (source_doc IN (
        'StudStartup_Knowledge_Base_v2',
        'Студ_стартап_сравнение_7_и_8',
        'Примеры_КП_нов_Стс_7',
        'TechLead8'
    )),
    source_page TEXT NOT NULL,
    title TEXT NOT NULL,
    authority_status TEXT NOT NULL CHECK (authority_status IN (
        'verified_8',
        'needs_verification_8',
        'methodology',
        'example'
    )),
    retrieval_mode TEXT NOT NULL CHECK (retrieval_mode IN ('pinned', 'search')),
    pipeline_steps TEXT[] NOT NULL,
    target_blocks TEXT[] NOT NULL,
    direction TEXT NOT NULL DEFAULT 'all' CHECK (direction IN ('all', 'Н1', 'Н2', 'Н3', 'Н4', 'Н5', 'Н6', 'Н7')),
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    search_tsv tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('russian', coalesce(content, '')), 'B')
    ) STORED,
    embedding vector(4096),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rag_cards_search_tsv ON rag_knowledge_cards USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS idx_rag_cards_steps ON rag_knowledge_cards USING GIN (pipeline_steps);
CREATE INDEX IF NOT EXISTS idx_rag_cards_blocks ON rag_knowledge_cards USING GIN (target_blocks);
CREATE INDEX IF NOT EXISTS idx_rag_cards_mode ON rag_knowledge_cards (retrieval_mode);
CREATE INDEX IF NOT EXISTS idx_rag_cards_direction ON rag_knowledge_cards (direction);
CREATE INDEX IF NOT EXISTS idx_rag_cards_source_doc ON rag_knowledge_cards (source_doc);
`;

/** Время на подключение к Postgres. Раньше 500 мс: при кратком подтормаживании БД процесс уходил в пустой PGlite. */
const PG_CONNECT_TIMEOUT_MS = 5_000;

let sharedPglite: PGlite | null = null;
let pgliteInitPromise: Promise<PGlite> | null = null;

async function getOrCreateSharedPglite(): Promise<PGlite> {
  if (sharedPglite && !(sharedPglite as any).closed) {
    return sharedPglite;
  }
  if (!pgliteInitPromise) {
    pgliteInitPromise = (async () => {
      const dataDir = resolve(PIPELINE_API_DIR, 'data', 'pgdata');
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }
      const instance = new PGlite(dataDir, { extensions: { vector } });
      await instance.exec('CREATE EXTENSION IF NOT EXISTS vector;');
      const sql = fromPglite(instance);
      await sql.exec(MIGRATION_SQL);
      sharedPglite = instance;
      return instance;
    })();
  }
  return pgliteInitPromise;
}

/**
 * База знаний RAG. Если задан Postgres (SUPABASE_DB_URL / DATABASE_URL) — только он: при ошибке подключения
 * бросаем исключение (вызывающие логируют и продолжают без RAG). Раньше первая же ошибка навсегда переключала
 * процесс на локальный PGlite, который в контейнере пуст, и RAG молча пропадал до перезапуска.
 * PGlite (backend/pipeline-api/data/pgdata) — только для локальной разработки без Postgres.
 */
export async function getRagDb(overrideUrl?: string): Promise<RagDbInstance> {
  const dbUrl = overrideUrl || config.databaseUrl;

  if (dbUrl) {
    const pool = new Pool({
      connectionString: dbUrl,
      connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    });
    try {
      const testClient = await pool.connect();
      testClient.release();

      const sql = fromPgPool(pool);
      await sql.exec(MIGRATION_SQL);

      return {
        sql,
        isPglite: false,
        close: async () => {
          await pool.end();
        },
      };
    } catch (err: any) {
      await pool.end().catch(() => {});
      throw new Error(`[ragDb] PostgreSQL недоступен: ${err?.message || err}`);
    }
  }

  // Локальная разработка без Postgres: PGlite в backend/pipeline-api/data/pgdata
  const pglite = await getOrCreateSharedPglite();
  const sql = fromPglite(pglite);

  return {
    sql,
    isPglite: true,
    close: async () => {
      // Shared PGlite instance remains open for the process lifecycle to prevent filesystem lock churn
    },
  };
}
