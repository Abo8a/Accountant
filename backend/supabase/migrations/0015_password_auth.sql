-- Пароли: регистрация = почта + код из письма + пароль, дальнейший вход = почта + пароль (без кода).
-- Хеш лежит в отдельной таблице, а не в app_profiles: у app_profiles есть клиентская политика SELECT,
-- а хеш пароля клиенту отдавать нельзя. RLS включён без политик — читает только бэкенд (service_role).

CREATE TABLE IF NOT EXISTS auth_passwords (
    user_id        uuid PRIMARY KEY REFERENCES app_profiles(id) ON DELETE CASCADE,
    password_hash  text NOT NULL,
    updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE auth_passwords ENABLE ROW LEVEL SECURITY;

-- Неудачные попытки входа по паролю: после лимита за окно вход по этой почте временно блокируется.
CREATE TABLE IF NOT EXISTS auth_login_failures (
    id          bigserial PRIMARY KEY,
    email       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_login_failures_email_idx ON auth_login_failures (email, created_at DESC);
ALTER TABLE auth_login_failures ENABLE ROW LEVEL SECURITY;
