// Проверка SQL-логики ТЗ (триггеры и функции) на реальном движке Postgres (PGlite).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { SUPABASE_DIR } from '../src/config';
import { createTestDb, createUser, type TestDb } from './helpers';

describe('миграции и триггеры ТЗ v1.8', () => {
  let db: TestDb;
  let userId: string;
  let projectId: string;
  let recordId: string;

  beforeAll(async () => {
    db = await createTestDb();
    userId = await createUser(db.sql, { name: 'Тест' });
    const p = await db.sql.query(
      `INSERT INTO app_projects (user_id, brief_text, anchor_status) VALUES ($1::uuid, 'бриф', 'pending') RETURNING id`,
      [userId],
    );
    projectId = p.rows[0].id;
    const r = await db.sql.query(
      `INSERT INTO project_passport_records (project_id, section_id, field_key, value)
       VALUES ($1::uuid, 3, 'problem_description', 'Привет мир, это тест') RETURNING id`,
      [projectId],
    );
    recordId = r.rows[0].id;
  });

  it('профиль создаётся триггером handle_new_user с ролью user', async () => {
    const { rows } = await db.sql.query('SELECT role, is_banned, founder_data FROM app_profiles WHERE id = $1::uuid', [userId]);
    expect(rows[0].role).toBe('user');
    expect(rows[0].is_banned).toBe(false);
    expect(rows[0].founder_data.name).toBe('Тест');
  });

  it('seed тарифов (монетизация v2): бесплатный — 20 кредитов, «Пакет ИИ» — 499 ₽ и 60 кредитов, старые подписки не продаются', async () => {
    const { rows } = await db.sql.query(
      `SELECT id, price_rub, file_uploads_limit, ai_credits, is_active, features FROM billing_plans ORDER BY price_rub`,
    );
    expect(rows.map((r) => [r.id, r.price_rub, r.file_uploads_limit, r.ai_credits, r.is_active])).toEqual([
      ['free', 0, 5, 20, true],
      ['ai_pack', 499, 10, 60, true],
      ['pro', 990, 10, 0, false],
      ['premium', 4990, 50, 0, false],
    ]);
    expect(rows[0].features).toEqual({ ai_parsing: true, novelty_check: true, consultant: true });
  });

  it('миграция 0012: переводит старый free (0 файлов) на 5 один раз и не перезаписывает правки админа', async () => {
    const migration = readFileSync(join(SUPABASE_DIR, 'migrations', '0012_free_plan_uploads.sql'), 'utf8');
    const free = async () =>
      (await db.sql.query(`SELECT file_uploads_limit AS n, features FROM billing_plans WHERE id = 'free'`)).rows[0];
    try {
      // Развёрнутая база до изменения: free без загрузки, отметки о миграции нет.
      await db.sql.query(
        `UPDATE billing_plans SET file_uploads_limit = 0, features = features || '{"ai_parsing": false}'::jsonb WHERE id = 'free'`,
      );
      await db.sql.query(`DELETE FROM app_data_migrations WHERE name = '0012_free_plan_uploads'`);

      await db.sql.exec(migration);
      expect(await free()).toMatchObject({ n: 5, features: { ai_parsing: true } });

      // Админ снова выключил загрузку; следующий деплой повторно прогоняет миграцию — она ничего не меняет.
      await db.sql.query(
        `UPDATE billing_plans SET file_uploads_limit = 0, features = features || '{"ai_parsing": false}'::jsonb WHERE id = 'free'`,
      );
      await db.sql.exec(migration);
      expect(await free()).toMatchObject({ n: 0, features: { ai_parsing: false } });
    } finally {
      await db.sql.query(
        `UPDATE billing_plans SET file_uploads_limit = 5, features = features || '{"ai_parsing": true}'::jsonb WHERE id = 'free'`,
      );
    }
  });

  it('singleton app_settings: нельзя создать вторую строку', async () => {
    await expect(db.sql.query('INSERT INTO app_settings (id) VALUES (2)')).rejects.toThrow();
  });

  it('span пересчитывается триггером 0-based при правке value (Баг №2)', async () => {
    const claim = 'мир, это тест';
    await db.sql.query(
      `INSERT INTO project_claims (record_id, claim_text, claim_type) VALUES ($1::uuid, $2, 'hypothesis')`,
      [recordId, claim],
    );
    const value = 'Начало. Привет мир, это тест';
    await db.sql.query(`UPDATE project_passport_records SET value = $2 WHERE id = $1::uuid`, [recordId, value]);
    const { rows } = await db.sql.query(`SELECT span_start, span_end FROM project_claims WHERE record_id = $1::uuid`, [recordId]);
    expect(rows[0].span_start).toBe(value.indexOf(claim));
    expect(rows[0].span_end).toBe(value.indexOf(claim) + claim.length);
  });

  it('правка текста: claim не найден → orphaned, запись needs_review', async () => {
    await db.sql.query(`UPDATE project_passport_records SET value = 'Совсем другой текст' WHERE id = $1::uuid`, [recordId]);
    const claims = await db.sql.query(`SELECT span_start, verification_status FROM project_claims WHERE record_id = $1::uuid`, [recordId]);
    expect(claims.rows[0].span_start).toBeNull();
    expect(claims.rows[0].verification_status).toBe('orphaned');
    const rec = await db.sql.query(`SELECT review_status FROM project_passport_records WHERE id = $1::uuid`, [recordId]);
    expect(rec.rows[0].review_status).toBe('needs_review');
  });

  it('правка approved-записи сбрасывает согласование (Баг №3)', async () => {
    await db.sql.query(`DELETE FROM project_claims WHERE record_id = $1::uuid`, [recordId]);
    await db.sql.query(`UPDATE project_passport_records SET review_status = 'approved' WHERE id = $1::uuid`, [recordId]);
    await db.sql.query(`UPDATE project_passport_records SET value = 'Ещё одна правка' WHERE id = $1::uuid`, [recordId]);
    const rec = await db.sql.query(`SELECT review_status FROM project_passport_records WHERE id = $1::uuid`, [recordId]);
    expect(rec.rows[0].review_status).toBe('ai_generated');
  });

  it('статус ai_generated для непроверенных claims', async () => {
    await db.sql.query(`DELETE FROM project_claims WHERE record_id = $1::uuid`, [recordId]);
    await db.sql.query(
      `INSERT INTO project_claims (record_id, claim_text, claim_type) VALUES ($1::uuid, 'Ещё одна правка', 'fact')`,
      [recordId],
    );
    const rec = await db.sql.query(`SELECT review_status FROM project_passport_records WHERE id = $1::uuid`, [recordId]);
    expect(rec.rows[0].review_status).toBe('ai_generated');
  });
});
