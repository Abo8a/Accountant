import { describe, expect, it } from 'vitest';
import {
  FREE_AI_CREDITS,
  PACK_AI_CREDITS,
  PLANS,
  SERVICES,
  formatRub,
  getPlan,
  packAction,
  planOrFree,
  pluralCredits,
  pluralDays,
} from './plans';

describe('тарифы (монетизация v2)', () => {
  it('продаются только бесплатный и «Пакет ИИ»', () => {
    expect(PLANS.map((p) => [p.id, p.price_rub, p.ai_credits, p.file_uploads_limit])).toEqual([
      ['free', 0, FREE_AI_CREDITS, 5],
      ['ai_pack', 499, PACK_AI_CREDITS, 10],
    ]);
    expect(FREE_AI_CREDITS).toBe(20);
    expect(PACK_AI_CREDITS).toBe(60);
    expect(getPlan('ai_pack').duration_days).toBe(30);
  });

  it('старые тарифы находятся по id, но не продаются', () => {
    expect(getPlan('premium')).toMatchObject({ name: 'Премиум', is_active: false });
    expect(planOrFree('pro').name).toBe('Профессиональный');
    expect(planOrFree('unknown').id).toBe('free');
  });

  it('услуги: 5% с потолком 50 000 ₽ и отчёт по этапу от 14 900 ₽', () => {
    expect(SERVICES.map((s) => [s.name, s.price, s.priceNote])).toEqual([
      ['Сопровождение после результата', '5%', 'от полученного финансирования, максимум 50 000 ₽'],
      ['Отчёт по этапу', 'от 14 900 ₽', 'за один этап'],
    ]);
  });
});

describe('packAction: карточка «Пакет ИИ» в кабинете', () => {
  it('без пакета — кнопка «Подключить» без суммы', () => {
    expect(packAction('free', 0)).toEqual({ kind: 'button', label: 'Подключить' });
    expect(packAction('premium', 10)).toEqual({ kind: 'button', label: 'Подключить' });
  });

  it('с пакетом — срок и «Автопродления нет»', () => {
    expect(packAction('ai_pack', 5)).toEqual({ kind: 'note', text: 'Пакет действует ещё 5 дней. Автопродления нет.' });
    expect(packAction('ai_pack', 1)).toEqual({ kind: 'note', text: 'Пакет действует ещё 1 день. Автопродления нет.' });
  });
});

describe('pluralCredits', () => {
  it.each([
    [1, 'кредит'],
    [2, 'кредита'],
    [5, 'кредитов'],
    [11, 'кредитов'],
    [20, 'кредитов'],
    [21, 'кредит'],
    [60, 'кредитов'],
  ])('%i → %s', (count, word) => {
    expect(pluralCredits(count)).toBe(word);
  });
});

describe('pluralDays: склонение «день»', () => {
  it.each([
    [1, 'день'],
    [2, 'дня'],
    [4, 'дня'],
    [5, 'дней'],
    [11, 'дней'],
    [12, 'дней'],
    [21, 'день'],
    [22, 'дня'],
    [23, 'дня'],
    [30, 'дней'],
    [111, 'дней'],
    [121, 'день'],
  ])('%i → %s', (count, word) => {
    expect(pluralDays(count)).toBe(word);
  });
});

describe('formatRub', () => {
  it('разряды пробелом, как в эталоне', () => {
    expect(formatRub(0)).toBe('0 ₽');
    expect(formatRub(499)).toBe('499 ₽');
    expect(formatRub(14900)).toBe('14 900 ₽');
  });
});
