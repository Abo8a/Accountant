// Монетизация v2: ИИ-кредиты. Бесплатные 20 — один раз, «Пакет ИИ» — 60 на 30 дней,
// списание после успешного ИИ-действия; ошибки и ручные правки кредиты не тратят.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PipelineRequest } from '@passport/contracts';
import { SUPABASE_DIR } from '../src/config';
import { FakeLlm } from '../src/llm/fake';
import type { LlmClient, LlmTask } from '../src/llm/types';
import { handlePipeline } from '../src/pipeline/handler';
import { handleConsultantChat } from '../src/chat/service';
import { createTestDb, createUser, makeDeps, type TestDb } from './helpers';

const BRIEF = 'Мобильное приложение для поиска попутчиков среди студентов университета, с проверкой профилей и рейтингом.';

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

/** Обёртка над FakeLlm: считает вызовы модели или подменяет их ошибкой. */
function wrapLlm(opts: { fail?: boolean } = {}): LlmClient & { calls: number } {
  const inner = new FakeLlm();
  const client = {
    calls: 0,
    get model() {
      return inner.model;
    },
    async complete(task: LlmTask, input: unknown) {
      client.calls += 1;
      if (opts.fail) throw new Error('модель недоступна');
      return inner.complete(task, input);
    },
    embed: (text: string) => inner.embed(text),
  };
  return client;
}

describe('ИИ-кредиты', () => {
  let db: TestDb;
  const balance = async (userId: string) =>
    Number((await db.sql.query(`SELECT public.ai_credits_balance($1::uuid) AS n`, [userId])).rows[0].n);
  const setFreeLeft = (userId: string, left: number) =>
    db.sql.query(`UPDATE billing_credit_grants SET used = amount - $2::int WHERE user_id = $1::uuid AND source = 'free'`, [
      userId,
      left,
    ]);
  const buyPack = (userId: string, expires = "now() + interval '30 days'") =>
    db.sql.query(`INSERT INTO billing_subscriptions (user_id, plan_id, expires_at) VALUES ($1::uuid, 'ai_pack', ${expires})`, [userId]);

  beforeAll(async () => {
    db = await createTestDb();
  });

  it('новый пользователь получает 20 бесплатных кредитов один раз, бессрочно', async () => {
    const userId = await createUser(db.sql);
    expect(await balance(userId)).toBe(20);
    const { rows } = await db.sql.query(`SELECT source, amount, expires_at FROM billing_credit_grants WHERE user_id = $1::uuid`, [
      userId,
    ]);
    expect(rows).toEqual([{ source: 'free', amount: 20, expires_at: null }]);
  });

  it('«Пакет ИИ»: подписка добавляет 60 кредитов со сроком подписки', async () => {
    const userId = await createUser(db.sql);
    await buyPack(userId);
    expect(await balance(userId)).toBe(80);
    const ctx = await db.store.loadContext(userId);
    expect(ctx?.planId).toBe('ai_pack');
    expect(ctx?.aiCredits).toMatchObject({ balance: 80, paid_balance: 60, costs: { ai_step: 1, file: 2, consultant_message: 1 } });
    expect(ctx?.aiCredits.paid_expires_at).not.toBeNull();
  });

  it('списание: сначала платные со сроком, затем бесплатные; в минус не уходит; журнал пишется', async () => {
    const userId = await createUser(db.sql);
    await buyPack(userId);
    expect(await db.store.spendAiCredits(userId, 65, 'test')).toBe(65);
    const { rows } = await db.sql.query(`SELECT source, used FROM billing_credit_grants WHERE user_id = $1::uuid ORDER BY source`, [
      userId,
    ]);
    expect(rows).toEqual([
      { source: 'free', used: 5 },
      { source: 'plan', used: 60 },
    ]);
    expect(await db.store.spendAiCredits(userId, 100, 'test')).toBe(15);
    expect(await balance(userId)).toBe(0);
    const usage = await db.sql.query(`SELECT SUM(credits)::int AS n FROM billing_credit_usage WHERE user_id = $1::uuid`, [userId]);
    expect(usage.rows[0].n).toBe(80);
  });

  it('истёкший пакет не учитывается в остатке', async () => {
    const userId = await createUser(db.sql);
    await buyPack(userId, "now() - interval '1 day'");
    expect(await balance(userId)).toBe(20);
  });

  it('ИИ-шаг пайплайна списывает 1 кредит после успешного ответа', async () => {
    const userId = await createUser(db.sql);
    const res = await handlePipeline(makeDeps(db), req(userId, { text_input: BRIEF }));
    expect(res.status).not.toBe('ERROR');
    expect(await balance(userId)).toBe(19);
  });

  it('без кредитов ИИ-действие не начинается: AI_CREDITS_EXHAUSTED, модель не вызывается', async () => {
    const userId = await createUser(db.sql);
    await setFreeLeft(userId, 0);
    const llm = wrapLlm();
    const res = await handlePipeline(makeDeps(db, llm as never), req(userId, { text_input: BRIEF }));
    expect(res).toMatchObject({ status: 'ERROR', code: 'AI_CREDITS_EXHAUSTED' });
    expect((res as { message: string }).message).toContain('Ручное редактирование, материалы и экспорт остаются доступны');
    expect(llm.calls).toBe(0);
  });

  it('файлы дороже: при остатке меньше стоимости загрузка не начинается', async () => {
    const userId = await createUser(db.sql);
    await setFreeLeft(userId, 2);
    const file = { file_name: 'deck.pdf', file_url: 'file:///deck.pdf', sha256_hash: 'x' };
    const res = await handlePipeline(makeDeps(db), req(userId, { files: [file] }));
    expect(res).toMatchObject({ status: 'ERROR', code: 'AI_CREDITS_EXHAUSTED' });
    expect(await balance(userId)).toBe(2);
  });

  it('ручные правки формы доступны без кредитов и ничего не списывают', async () => {
    const userId = await createUser(db.sql);
    await setFreeLeft(userId, 0);
    const res = await handlePipeline(
      makeDeps(db),
      req(userId, {
        action: 'submit_form',
        form: [{ section_id: 3, field_key: 'problem_description', value: 'Студентам сложно найти попутчиков.' }],
      }),
    );
    expect(res).not.toMatchObject({ code: 'AI_CREDITS_EXHAUSTED' });
    expect(await balance(userId)).toBe(0);
  });

  it('техническая ошибка модели кредиты не списывает', async () => {
    const userId = await createUser(db.sql);
    const res = await handlePipeline(makeDeps(db, wrapLlm({ fail: true }) as never), req(userId, { text_input: BRIEF }));
    expect(res).toMatchObject({ status: 'ERROR' });
    expect(await balance(userId)).toBe(20);
  });

  it('консультант: сообщение стоит 1 кредит; без кредитов — AI_CREDITS_EXHAUSTED', async () => {
    const userId = await createUser(db.sql);
    await handleConsultantChat(makeDeps(db), { user_id: userId, message: 'Как описать проблему?' } as never);
    expect(await balance(userId)).toBe(19);

    await setFreeLeft(userId, 0);
    await expect(handleConsultantChat(makeDeps(db), { user_id: userId, message: 'Ещё вопрос' } as never)).rejects.toMatchObject({
      code: 'AI_CREDITS_EXHAUSTED',
    });
  });

  it('миграция 0013 на развёрнутой базе: тарифы обновляются один раз, старым пользователям — 20 кредитов', async () => {
    const migration = readFileSync(join(SUPABASE_DIR, 'migrations', '0013_ai_credits.sql'), 'utf8');
    const userId = await createUser(db.sql);
    // Как было до миграции: у пользователя нет кредитов, тарифы в старом виде.
    await db.sql.query(`DELETE FROM billing_credit_grants WHERE user_id = $1::uuid`, [userId]);
    await db.sql.query(`DELETE FROM app_data_migrations WHERE name = '0013_ai_credits'`);
    await db.sql.query(`UPDATE billing_plans SET name = 'Базовый', ai_credits = 0 WHERE id = 'free'`);
    await db.sql.query(`UPDATE billing_plans SET is_active = true WHERE id IN ('pro', 'premium')`);

    await db.sql.exec(migration);
    const plans = await db.sql.query(`SELECT id, name, ai_credits, is_active FROM billing_plans ORDER BY id`);
    expect(plans.rows).toEqual(
      expect.arrayContaining([
        { id: 'free', name: 'Бесплатный', ai_credits: 20, is_active: true },
        { id: 'pro', name: 'Профессиональный', ai_credits: 0, is_active: false },
        { id: 'ai_pack', name: 'Пакет ИИ', ai_credits: 60, is_active: true },
      ]),
    );
    expect(await balance(userId)).toBe(20);

    // Повторный деплой: админ поменял бесплатный лимит — миграция его не перезаписывает.
    await db.sql.query(`UPDATE billing_plans SET ai_credits = 30 WHERE id = 'free'`);
    await db.sql.exec(migration);
    expect((await db.sql.query(`SELECT ai_credits FROM billing_plans WHERE id = 'free'`)).rows[0].ai_credits).toBe(30);
    await db.sql.query(`UPDATE billing_plans SET ai_credits = 20 WHERE id = 'free'`);
  });
});
