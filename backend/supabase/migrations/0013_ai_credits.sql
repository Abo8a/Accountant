-- Монетизация v2: ИИ-кредиты вместо подписок «Профессиональный» и «Премиум».
--   Бесплатно — 20 кредитов один раз (не обновляются каждый месяц).
--   «Пакет ИИ» — 499 ₽ за 30 дней, 60 кредитов, без автопродления.
-- Кредиты хранятся «пачками» (billing_credit_grants): у каждой своя сумма, израсходованное и срок.
-- Списание — после успешного ИИ-действия, сначала из пачки с ближайшим сроком (пакет), бесплатная — последней.
-- Технические ошибки не списывают кредиты: списывает пайплайн только при успешном ответе.
--
-- Файл добавочный (номер >= INCREMENTAL_FROM): выполняется на каждом деплое, поэтому всё идемпотентно,
-- а разовые изменения данных защищены отметкой в app_data_migrations.

ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS ai_credits int NOT NULL DEFAULT 0;
ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Стоимость действий в кредитах. Точные значения настраиваются после замеров расходов.
--   ai_step — один шаг с ИИ (бриф, ответ на вопрос с разбором), file — разбор одного загруженного файла,
--   consultant_message — одно сообщение консультанту.
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS ai_credit_costs jsonb NOT NULL
    DEFAULT '{"ai_step": 1, "file": 2, "consultant_message": 1}'::jsonb;

CREATE TABLE IF NOT EXISTS billing_credit_grants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    source          varchar NOT NULL CHECK (source IN ('free', 'plan', 'manual')),
    subscription_id uuid REFERENCES billing_subscriptions(id) ON DELETE SET NULL,
    amount          int NOT NULL CHECK (amount >= 0),
    used            int NOT NULL DEFAULT 0 CHECK (used >= 0 AND used <= amount),
    expires_at      timestamp with time zone,              -- NULL — бессрочно (бесплатные)
    created_at      timestamp with time zone DEFAULT now()
);

-- Бесплатные кредиты выдаются один раз на пользователя.
CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_grants_free ON billing_credit_grants (user_id) WHERE source = 'free';
CREATE INDEX IF NOT EXISTS idx_credit_grants_user ON billing_credit_grants (user_id);

-- Журнал списаний: для замеров расходов и отчётов админки.
CREATE TABLE IF NOT EXISTS billing_credit_usage (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    action     varchar NOT NULL,
    credits    int NOT NULL CHECK (credits > 0),
    created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_usage_user ON billing_credit_usage (user_id, created_at);

ALTER TABLE billing_credit_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_usage ENABLE ROW LEVEL SECURITY;

-- Бесплатные кредиты новому пользователю. Сумма — из тарифа free (до seed тарифа нет — тогда 20).
CREATE OR REPLACE FUNCTION public.grant_free_credits()
RETURNS trigger AS $$
BEGIN
    INSERT INTO public.billing_credit_grants (user_id, source, amount)
    VALUES (NEW.id, 'free', COALESCE((SELECT ai_credits FROM public.billing_plans WHERE id = 'free'), 20))
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_grant_free_credits ON app_profiles;
CREATE TRIGGER trg_grant_free_credits
AFTER INSERT ON app_profiles
FOR EACH ROW EXECUTE FUNCTION public.grant_free_credits();

-- Платный пакет: кредиты тарифа выдаются при оформлении подписки и сгорают вместе с ней.
CREATE OR REPLACE FUNCTION public.grant_plan_credits()
RETURNS trigger AS $$
DECLARE
    credits int;
BEGIN
    SELECT ai_credits INTO credits FROM public.billing_plans WHERE id = NEW.plan_id;
    IF COALESCE(credits, 0) > 0 THEN
        INSERT INTO public.billing_credit_grants (user_id, source, subscription_id, amount, expires_at)
        VALUES (NEW.user_id, 'plan', NEW.id, credits, NEW.expires_at);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_grant_plan_credits ON billing_subscriptions;
CREATE TRIGGER trg_grant_plan_credits
AFTER INSERT ON billing_subscriptions
FOR EACH ROW EXECUTE FUNCTION public.grant_plan_credits();

-- Остаток кредитов: действующие пачки (бессрочные и с неистёкшим сроком).
CREATE OR REPLACE FUNCTION public.ai_credits_balance(p_user uuid)
RETURNS int AS $$
    SELECT COALESCE(SUM(amount - used), 0)::int
      FROM public.billing_credit_grants
     WHERE user_id = p_user AND (expires_at IS NULL OR expires_at > now());
$$ LANGUAGE sql STABLE;

-- Списание: сначала пачки с ближайшим сроком, бессрочные — последними. Не уходит в минус:
-- если кредитов меньше, чем стоит действие, списывается остаток. Возвращает фактически списанное.
CREATE OR REPLACE FUNCTION public.spend_ai_credits(p_user uuid, p_amount int, p_action varchar)
RETURNS int AS $$
DECLARE
    g record;
    left_to_spend int := GREATEST(p_amount, 0);
    take int;
    spent int := 0;
BEGIN
    IF left_to_spend = 0 THEN
        RETURN 0;
    END IF;
    FOR g IN
        SELECT id, amount - used AS available
          FROM public.billing_credit_grants
         WHERE user_id = p_user AND used < amount AND (expires_at IS NULL OR expires_at > now())
         ORDER BY expires_at ASC NULLS LAST, created_at ASC
         FOR UPDATE
    LOOP
        EXIT WHEN left_to_spend = 0;
        take := LEAST(g.available, left_to_spend);
        UPDATE public.billing_credit_grants SET used = used + take WHERE id = g.id;
        left_to_spend := left_to_spend - take;
        spent := spent + take;
    END LOOP;
    IF spent > 0 THEN
        INSERT INTO public.billing_credit_usage (user_id, action, credits) VALUES (p_user, p_action, spent);
    END IF;
    RETURN spent;
END;
$$ LANGUAGE plpgsql;

-- Разовый перевод уже развёрнутой базы на новую модель.
-- На чистой базе тарифов ещё нет (их создаёт seed уже с новыми значениями): UPDATE затронет 0 строк.
CREATE TABLE IF NOT EXISTS app_data_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM app_data_migrations WHERE name = '0013_ai_credits') THEN
        -- Бесплатный тариф: все функции, ограничение — кредитами.
        UPDATE billing_plans
           SET name = 'Бесплатный',
               ai_credits = 20,
               features = '{"ai_parsing": true, "novelty_check": true, "consultant": true}'::jsonb
         WHERE id = 'free';

        -- Старые подписки больше не продаются; уже оформленные действуют до конца срока.
        UPDATE billing_plans SET is_active = false WHERE id IN ('pro', 'premium');

        IF EXISTS (SELECT 1 FROM billing_plans WHERE id = 'free') THEN
            INSERT INTO billing_plans (id, name, price_rub, duration_days, file_uploads_limit, renewal_discount_percent, features, ai_credits, is_active)
            VALUES ('ai_pack', 'Пакет ИИ', 499, 30, 10, 0,
                    '{"ai_parsing": true, "novelty_check": true, "consultant": true}'::jsonb, 60, true)
            ON CONFLICT (id) DO NOTHING;
        END IF;

        -- Бесплатные кредиты уже зарегистрированным пользователям.
        INSERT INTO billing_credit_grants (user_id, source, amount)
        SELECT p.id, 'free', 20 FROM app_profiles p
        ON CONFLICT DO NOTHING;

        INSERT INTO app_data_migrations (name) VALUES ('0013_ai_credits');
    END IF;
END $$;
