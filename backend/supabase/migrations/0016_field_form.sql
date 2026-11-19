-- Интерактивные анкеты паспорта: таблица, выбор «да/нет», список вместо сплошного текста.
-- ИИ переписывает ответ своими словами, поэтому из текста поля форму не восстановить — храним её рядом (jsonb).
-- Форма описывает текст поля только пока текст не меняли другим путём: любая смена value сбрасывает form_data,
-- а сохранение из формы записывает её заново уже после записи текста.
-- Файл добавочный (номер >= INCREMENTAL_FROM): выполняется на каждом деплое, поэтому идемпотентен.

ALTER TABLE project_passport_records
    ADD COLUMN IF NOT EXISTS form_data jsonb;

CREATE OR REPLACE FUNCTION public.reset_form_data_on_value_change()
RETURNS trigger AS $$
BEGIN
    IF OLD.value IS DISTINCT FROM NEW.value THEN
        NEW.form_data := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reset_form_data_on_value_change ON public.project_passport_records;
CREATE TRIGGER trg_reset_form_data_on_value_change
BEFORE UPDATE OF value ON public.project_passport_records
FOR EACH ROW EXECUTE FUNCTION public.reset_form_data_on_value_change();
