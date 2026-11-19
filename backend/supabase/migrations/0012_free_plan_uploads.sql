-- Политика тарификации: на бесплатном тарифе («Базовый») можно загружать документы — до 5 файлов.
-- Загруженные файлы всегда разбираются, поэтому для free включается и ai_parsing (без него бэкенд отвечает PLAN_UPGRADE_REQUIRED).
--
-- Seed тарифов вставляет строки с ON CONFLICT DO NOTHING и уже созданную базу не меняет, поэтому здесь — разовое обновление.
-- Добавочные миграции (номер >= INCREMENTAL_FROM) выполняются на каждом деплое, поэтому изменение защищено отметкой
-- в app_data_migrations: оно применится один раз и не перезапишет то, что админ потом поменяет в тарифах.
-- На чистой базе тарифов в момент миграции ещё нет (их создаёт seed уже с новыми значениями): UPDATE затронет 0 строк.

CREATE TABLE IF NOT EXISTS app_data_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_data_migrations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM app_data_migrations WHERE name = '0012_free_plan_uploads') THEN
        UPDATE billing_plans
           SET file_uploads_limit = 5,
               features = features || '{"ai_parsing": true}'::jsonb
         WHERE id = 'free'
           AND file_uploads_limit = 0
           AND COALESCE((features ->> 'ai_parsing')::boolean, false) = false;

        INSERT INTO app_data_migrations (name) VALUES ('0012_free_plan_uploads');
    END IF;
END $$;
