import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlClient } from './sql';

export interface MigrateOptions {
  /** Включить seed-файлы с префиксом 9 (тестовые данные). */
  devSeed?: boolean;
}

/**
 * Применяет migrations/*.sql, затем seed/*.sql (по порядку имён).
 * Миграции НЕ идемпотентны: повторный запуск на той же БД упадёт — используйте чистую БД
 * или Supabase CLI для инкрементальных изменений.
 */
export async function applyMigrations(sql: SqlClient, supabaseDir: string, opts: MigrateOptions = {}) {
  const list = (sub: string) =>
    readdirSync(join(supabaseDir, sub))
      .filter((f) => f.endsWith('.sql'))
      .sort();

  const migrations = list('migrations');
  for (const file of migrations) {
    await sql.exec(readFileSync(join(supabaseDir, 'migrations', file), 'utf8'));
  }

  const seeds = list('seed').filter((f) => opts.devSeed || !f.startsWith('9'));
  for (const file of seeds) {
    await sql.exec(readFileSync(join(supabaseDir, 'seed', file), 'utf8'));
  }

  return { migrations, seeds };
}

/** Номер первой добавочной миграции: с неё файлы идемпотентны (IF NOT EXISTS) и применяются и на уже развёрнутой базе. */
export const INCREMENTAL_FROM = 11;

/** Применяет добавочные миграции (номер >= INCREMENTAL_FROM) к базе, где основная схема уже создана. */
export async function applyIncrementalMigrations(sql: SqlClient, supabaseDir: string): Promise<string[]> {
  const files = readdirSync(join(supabaseDir, 'migrations'))
    .filter((f) => f.endsWith('.sql') && Number.parseInt(f, 10) >= INCREMENTAL_FROM)
    .sort();
  for (const file of files) {
    await sql.exec(readFileSync(join(supabaseDir, 'migrations', file), 'utf8'));
  }
  return files;
}
