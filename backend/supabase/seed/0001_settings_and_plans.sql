-- ТЗ v1.8, раздел 3.4 (п. 3). Идемпотентные seed-данные для любой среды.

INSERT INTO app_settings (id, guard_threshold_block, guard_threshold_warn, embedding_model)
VALUES (1, 0.5, 0.75, 'qwen3-embedding-8b')
ON CONFLICT (id) DO UPDATE SET embedding_model = EXCLUDED.embedding_model;

-- Монетизация v2 (миграция 0013): бесплатный тариф с 20 ИИ-кредитами один раз и «Пакет ИИ» 499 ₽ / 30 дней / 60 кредитов.
-- «Профессиональный» и «Премиум» больше не продаются (is_active = false), строки нужны для старых подписок и платежей.
INSERT INTO billing_plans (id, name, price_rub, duration_days, file_uploads_limit, renewal_discount_percent, features, ai_credits, is_active)
VALUES
  ('free',    'Бесплатный',        0,    30,  5,  0,  '{"ai_parsing": true,  "novelty_check": true,  "consultant": true}'::jsonb, 20, true),
  ('ai_pack', 'Пакет ИИ',          499,  30,  10, 0,  '{"ai_parsing": true,  "novelty_check": true,  "consultant": true}'::jsonb, 60, true),
  ('pro',     'Профессиональный',  990,  30,  10, 15, '{"ai_parsing": true,  "novelty_check": true,  "consultant": false}'::jsonb, 0, false),
  ('premium', 'Премиум',           4990, 30,  50, 10, '{"ai_parsing": true,  "novelty_check": true,  "consultant": true}'::jsonb, 0, false)
ON CONFLICT (id) DO NOTHING;
