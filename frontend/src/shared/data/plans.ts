// Тарифы «Буха» (монетизация v2). Источник значений — backend/supabase/seed/0001_settings_and_plans.sql (billing_plans)
// и миграция 0013_ai_credits.sql. Поля description в seed нет: тексты ниже временные, подменяются данными админки.
//
// Продаются два тарифа: бесплатный (20 ИИ-кредитов один раз) и «Пакет ИИ» (499 ₽ за 30 дней, 60 кредитов, без автопродления).
// «Профессиональный» и «Премиум» больше не продаются; их id остаются для старых подписок и платежей.

export type ActivePlanId = 'free' | 'ai_pack';
export type LegacyPlanId = 'pro' | 'premium';
export type PlanId = ActivePlanId | LegacyPlanId;

export interface PlanFeatures {
  ai_parsing: boolean;
  novelty_check: boolean;
  consultant: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  price_rub: number;
  duration_days: number;
  file_uploads_limit: number;
  renewal_discount_percent: number;
  /** ИИ-кредиты тарифа: у бесплатного — один раз, у пакета — на срок подписки. */
  ai_credits: number;
  /** false — тариф больше не продаётся (старые подписки). */
  is_active: boolean;
  features: PlanFeatures;
  /** временный текст, подменяется данными админки */
  description: string;
}

const ALL_FEATURES: PlanFeatures = { ai_parsing: true, novelty_check: true, consultant: true };

/** Бесплатные ИИ-кредиты: выдаются один раз, не обновляются каждый месяц. */
export const FREE_AI_CREDITS = 20;
/** Кредиты «Пакета ИИ» на 30 дней. */
export const PACK_AI_CREDITS = 60;

/** Тарифы, которые продаются сейчас. */
export const PLANS: readonly Plan[] = [
  {
    id: 'free',
    name: 'Бесплатный',
    price_rub: 0,
    duration_days: 0,
    file_uploads_limit: 5,
    renewal_discount_percent: 0,
    ai_credits: FREE_AI_CREDITS,
    is_active: true,
    features: { ...ALL_FEATURES },
    // временный текст, подменяется данными админки
    description: 'Паспорт, материалы, ручное редактирование и экспорт. До 5 файлов и 20 ИИ-кредитов один раз.',
  },
  {
    id: 'ai_pack',
    name: 'Пакет ИИ',
    price_rub: 499,
    duration_days: 30,
    file_uploads_limit: 10,
    renewal_discount_percent: 0,
    ai_credits: PACK_AI_CREDITS,
    is_active: true,
    features: { ...ALL_FEATURES },
    // временный текст, подменяется данными админки
    description: '60 ИИ-кредитов на 30 дней и до 10 файлов. Без автопродления.',
  },
];

/** Старые тарифы: не продаются, нужны, чтобы показать название у действующих подписок и в истории платежей. */
export const LEGACY_PLANS: readonly Plan[] = [
  {
    id: 'pro',
    name: 'Профессиональный',
    price_rub: 990,
    duration_days: 30,
    file_uploads_limit: 10,
    renewal_discount_percent: 15,
    ai_credits: 0,
    is_active: false,
    features: { ai_parsing: true, novelty_check: true, consultant: false },
    description: 'Тариф больше не продаётся. Действует до конца оплаченного срока.',
  },
  {
    id: 'premium',
    name: 'Премиум',
    price_rub: 4990,
    duration_days: 30,
    file_uploads_limit: 50,
    renewal_discount_percent: 10,
    ai_credits: 0,
    is_active: false,
    features: { ...ALL_FEATURES },
    description: 'Тариф больше не продаётся. Действует до конца оплаченного срока.',
  },
];

export function getPlan(id: PlanId): Plan {
  const plan = PLANS.find((p) => p.id === id) ?? LEGACY_PLANS.find((p) => p.id === id);
  if (!plan) throw new Error(`Неизвестный тариф: ${id}`);
  return plan;
}

/** Тариф по id с сервера; незнакомый id показываем как бесплатный, а не роняем экран. */
export function planOrFree(id: string | null | undefined): Plan {
  return PLANS.find((p) => p.id === id) ?? LEGACY_PLANS.find((p) => p.id === id) ?? PLANS[0]!;
}

/** Склонение слова «день» по числу: 1 день, 2 дня, 5 дней, 23 дня. */
export function pluralDays(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'дня';
  return 'дней';
}

/** Склонение слова «кредит»: 1 кредит, 2 кредита, 5 кредитов. */
export function pluralCredits(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'кредит';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'кредита';
  return 'кредитов';
}

/** Как считаются кредиты (значения по умолчанию app_settings.ai_credit_costs) — для страницы тарифов и кабинета. */
export const CREDITS_EXPLAINED =
  'ИИ-кредит — единица работы ИИ: шаг с ИИ или сообщение консультанту — 1 кредит, разбор одного файла — 2 кредита. ' +
  'Технические ошибки кредиты не списывают. Ручное редактирование, материалы и экспорт работают и без кредитов.';

/** Действие карточки «Пакет ИИ» в кабинете: кнопка или поясняющий текст. */
export type PlanCardAction = { kind: 'note'; text: string } | { kind: 'button'; label: string };

/**
 * Кнопка карточки «Пакет ИИ» по текущему тарифу. Автопродления нет: пакет подключают заново, когда нужен.
 * daysLeft — оставшиеся дни действующего пакета.
 */
export function packAction(currentPlanId: PlanId, daysLeft: number): PlanCardAction {
  if (currentPlanId === 'ai_pack') {
    return { kind: 'note', text: `Пакет действует ещё ${daysLeft} ${pluralDays(daysLeft)}. Автопродления нет.` };
  }
  return { kind: 'button', label: 'Подключить' };
}

/** Услуги специалистов: цена и условия — рядом с решением (PDF «Новая модель 2.0»). */
export interface ServiceOffer {
  id: 'after_result' | 'stage_report';
  name: string;
  price: string;
  priceNote: string;
  description: string;
  items: readonly string[];
}

export const SERVICES: readonly ServiceOffer[] = [
  {
    id: 'after_result',
    name: 'Сопровождение после результата',
    price: '5%',
    priceNote: 'от полученного финансирования, максимум 50 000 ₽',
    description: 'Согласованный объём сопровождения заявки по отдельному договору',
    items: [
      '0 ₽ до результата',
      'Оплата — только после фактического поступления денег',
      'Не из средств гранта: из собственных средств или от другого плательщика',
      'Сумма, потолок и условия — в договоре до начала работы',
    ],
  },
  {
    id: 'stage_report',
    name: 'Отчёт по этапу',
    price: 'от 14 900 ₽',
    priceNote: 'за один этап',
    description: 'Когда грант получен и нужно отчитаться по этапу',
    items: [
      'Разбор договора: обязательства, сроки, подтверждения',
      'До 30 первичных документов',
      'Согласованный отчётный пакет одного этапа',
      'Один сводный круг правок',
      'Точная цена — после оценки объёма',
    ],
  },
];

/** Куда ведёт «Оставить заявку» на услугу: форма обращения. */
export const SERVICE_REQUEST_PATH = '/support';

/** Цена в рублях с пробелом между разрядами: 0 ₽, 499 ₽, 14 900 ₽. */
export function formatRub(amount: number): string {
  return `${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
}
