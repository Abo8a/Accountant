-- Справка об обучении в вузе (блок 1). Студент загружает её при регистрации; без неё фонд не примет заявку,
-- но паспорт собирается и без справки: её отсутствие — предупреждение в итоге, а не блокировка.
-- Миграция идемпотентна: на уже развёрнутой базе её применяет migrate-cli (добавочные миграции, см. INCREMENTAL_FROM).

CREATE TABLE IF NOT EXISTS app_user_documents (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES app_profiles(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('study_certificate')),
    file_name    text NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
    mime_type    text NOT NULL,
    size_bytes   integer NOT NULL CHECK (size_bytes > 0),
    sha256_hash  text NOT NULL,
    content      bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, kind)
);

ALTER TABLE app_user_documents ENABLE ROW LEVEL SECURITY;
