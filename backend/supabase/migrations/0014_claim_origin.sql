-- Происхождение утверждения паспорта: 'user' — слова студента (его текст, ответы, документы), 'ai' — дописано моделью.
-- Нужно подчёркиваниям в паспорте («С ваших слов» / «Дописано ИИ»). Утверждения, созданные до миграции, считаются словами студента:
-- пересчитать задним числом нечем, а завышать долю ИИ в уже принятых текстах нельзя.
-- Файл добавочный (номер >= INCREMENTAL_FROM): выполняется на каждом деплое, поэтому идемпотентен.

ALTER TABLE project_claims
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'user';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_claims_origin_check') THEN
        ALTER TABLE project_claims
            ADD CONSTRAINT project_claims_origin_check CHECK (origin IN ('user', 'ai'));
    END IF;
END $$;
