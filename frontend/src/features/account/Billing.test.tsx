import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Billing, type BillingProps } from './Billing';

// Монетизация v2: бесплатный тариф (20 ИИ-кредитов один раз), «Пакет ИИ» (499 ₽ / 30 дней / 60 кредитов, без автопродления)
// и услуги специалистов (5% с потолком 50 000 ₽, отчёт по этапу от 14 900 ₽).
// Флаги: по умолчанию как в flags.ts (HIDE_PAYMENT_GATEWAY = TRUE). Тесты окна оплаты переключают флаг в FALSE,
// чтобы проверить код, который спрятан, но сохранён до подключения шлюза.
const flagState = vi.hoisted(() => ({ FLAGS: { HIDE_PAYMENT_GATEWAY: true, ALL_FEATURES_ENABLED: true } }));
vi.mock('../../shared/config/flags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/config/flags')>();
  return { ...actual, FLAGS: flagState.FLAGS };
});

function renderBilling(props: BillingProps = {}) {
  return render(
    <MemoryRouter>
      <Billing {...props} />
    </MemoryRouter>,
  );
}

function dialog(name = 'Оплата пакета') {
  return screen.getByRole('dialog', { name });
}

// Значения «Тариф / Период / ИИ-кредиты / К оплате» внутри диалога оплаты: пары dt → dd.
function summaryValue(label: string) {
  const term = within(dialog()).getByText(label, { selector: 'dt' });
  return term.nextElementSibling;
}

// Карточка в секциях «Больше работы ИИ» и «Услуги специалистов» по заголовку уровня 3.
function cardOf(name: string) {
  return screen.getByRole('heading', { level: 3, name }).closest('.billing__plan') as HTMLElement;
}

describe('Billing: флаг HIDE_PAYMENT_GATEWAY = TRUE (по умолчанию)', () => {
  beforeEach(() => {
    flagState.FLAGS.HIDE_PAYMENT_GATEWAY = true;
  });

  it('по умолчанию текущий тариф — бесплатный: остаток кредитов из 20, выдаются один раз', () => {
    renderBilling();
    expect(screen.getByRole('heading', { level: 1, name: 'Тариф и оплата' })).toBeInTheDocument();
    expect(screen.getByText('Текущий тариф')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Бесплатный' })).toBeInTheDocument();
    expect(screen.getByText('Бесплатные ИИ-кредиты: осталось 14 из 20. Выдаются один раз.')).toBeInTheDocument();
    expect(screen.getByText('ИИ-кредиты')).toBeInTheDocument();
    expect(screen.getByText('14')).toBeInTheDocument();
  });

  it('объясняет, как считаются кредиты, и что ручная работа доступна без них', () => {
    renderBilling();
    expect(screen.getByText(/шаг с ИИ или сообщение консультанту — 1 кредит, разбор одного файла — 2 кредита/)).toBeInTheDocument();
    expect(screen.getByText(/Технические ошибки кредиты не списывают/)).toBeInTheDocument();
    expect(screen.getByText(/Ручное редактирование, материалы и экспорт работают и без кредитов/)).toBeInTheDocument();
  });

  it('«Пакет ИИ»: 499 ₽ за 30 дней, кнопка «Подключить» без суммы', () => {
    renderBilling();
    const pack = cardOf('Пакет ИИ');
    expect(within(pack).getByText('60 ИИ-кредитов на 30 дней и до 10 файлов. Без автопродления.')).toBeInTheDocument();
    expect(within(pack).getByText('499 ₽', { exact: false })).toBeInTheDocument();
    expect(within(pack).getByText('за 30 дней')).toBeInTheDocument();
    expect(within(pack).getByRole('button', { name: 'Подключить' })).toBeInTheDocument();
  });

  it('старых тарифов «Профессиональный» и «Премиум» в продаже нет', () => {
    renderBilling();
    expect(screen.queryByText('Профессиональный')).not.toBeInTheDocument();
    expect(screen.queryByText('Премиум')).not.toBeInTheDocument();
    expect(screen.queryByText(/Скидка/)).not.toBeInTheDocument();
  });

  it('услуги специалистов: 5% с потолком 50 000 ₽ и отчёт по этапу от 14 900 ₽, заявка — через форму обращения', () => {
    renderBilling();
    expect(screen.getByRole('heading', { level: 2, name: 'Услуги специалистов' })).toBeInTheDocument();
    const after = cardOf('Сопровождение после результата');
    expect(within(after).getByText('5%', { exact: false })).toBeInTheDocument();
    expect(within(after).getByText('от полученного финансирования, максимум 50 000 ₽')).toBeInTheDocument();
    const report = cardOf('Отчёт по этапу');
    expect(within(report).getByText('от 14 900 ₽', { exact: false })).toBeInTheDocument();
    for (const card of [after, report]) {
      expect(within(card).getByRole('link', { name: 'Оставить заявку' })).toHaveAttribute('href', '/support');
    }
    expect(screen.getByText(/Отказ от них не закрывает доступ к паспорту и материалам/)).toBeInTheDocument();
  });

  it('текущий «Пакет ИИ»: срок, «Автопродления нет», платные кредиты отдельно; кнопки покупки нет', () => {
    renderBilling({ currentPlan: 'ai_pack', credits: { balance: 75, paidBalance: 55 } });
    expect(screen.getByRole('heading', { level: 2, name: 'Пакет ИИ' })).toBeInTheDocument();
    expect(screen.getByText('Действует до 1 декабря 2026 · осталось 23 дня. Автопродления нет.')).toBeInTheDocument();
    expect(screen.getByText('из них 55 кредитов пакета')).toBeInTheDocument();
    expect(within(cardOf('Пакет ИИ')).getByText('Пакет действует ещё 23 дня. Автопродления нет.')).toBeInTheDocument();
    expect(within(cardOf('Пакет ИИ')).queryByRole('button')).not.toBeInTheDocument();
  });

  it('старая подписка («Премиум») показывается по названию до конца срока', () => {
    renderBilling({ currentPlan: 'premium' });
    expect(screen.getByRole('heading', { level: 2, name: 'Премиум' })).toBeInTheDocument();
    expect(screen.getByText('Действует до 1 декабря 2026 · осталось 23 дня.')).toBeInTheDocument();
    expect(within(cardOf('Пакет ИИ')).getByRole('button', { name: 'Подключить' })).toBeInTheDocument();
  });

  it('история платежей: демо-строка без колонки скидки', () => {
    renderBilling();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Дата', 'Тариф', 'Сумма', 'Статус', 'Чек']);
    expect(within(table).getByText('1 ноября 2026')).toBeInTheDocument();
    expect(within(table).getByText('Оплачен')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(2);
  });

  it('кнопка «Тарифы» открывает окно тарифов, «Закрыть» его закрывает', async () => {
    renderBilling();
    await userEvent.click(screen.getByRole('button', { name: 'Тарифы' }));
    expect(screen.getByRole('dialog', { name: 'Тарифы' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('«Подключить» без шлюза открывает окно тарифов; окна оплаты и прототипных кнопок нет', async () => {
    renderBilling();
    await userEvent.click(within(cardOf('Пакет ИИ')).getByRole('button', { name: 'Подключить' }));
    expect(screen.getByRole('dialog', { name: 'Тарифы' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Оплата пакета' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ошибка' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Перейти к оплате' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Billing: окно оплаты (флаг HIDE_PAYMENT_GATEWAY = FALSE)', () => {
  beforeEach(() => {
    flagState.FLAGS.HIDE_PAYMENT_GATEWAY = false;
  });

  afterEach(() => {
    flagState.FLAGS.HIDE_PAYMENT_GATEWAY = true;
  });

  it('«Подключить» открывает подтверждение: пакет, 30 дней, 60 кредитов, 499 ₽, без автопродления', async () => {
    renderBilling();
    await userEvent.click(within(cardOf('Пакет ИИ')).getByRole('button', { name: 'Подключить' }));

    expect(within(dialog()).getByRole('heading', { level: 2, name: 'Оплата пакета' })).toBeInTheDocument();
    expect(summaryValue('Тариф')).toHaveTextContent('Пакет ИИ');
    expect(summaryValue('Период')).toHaveTextContent('30 дней');
    expect(summaryValue('ИИ-кредиты')).toHaveTextContent('60');
    expect(summaryValue('К оплате')).toHaveTextContent('499 ₽');
    expect(screen.getByText(/Автопродления нет\. Чек придёт на ivan@university\.ru\./)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('успех: баннер «Оплата прошла», строка истории «Оплачен»; «Закрыть» убирает баннер', async () => {
    renderBilling();
    await userEvent.click(within(cardOf('Пакет ИИ')).getByRole('button', { name: 'Подключить' }));
    await userEvent.click(screen.getByRole('button', { name: 'Перейти к оплате' }));

    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Оплата прошла. Пакет ИИ действует до 31 декабря 2026.');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getAllByText('Оплачен')).toHaveLength(2);

    await userEvent.click(within(banner).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByText('Оплата прошла.', { exact: false })).not.toBeInTheDocument();
  });

  it('ошибка: alert «Деньги не списаны»; «Повторить» открывает оплату снова', async () => {
    renderBilling();
    await userEvent.click(within(cardOf('Пакет ИИ')).getByRole('button', { name: 'Подключить' }));
    await userEvent.click(within(dialog()).getByRole('button', { name: 'ошибка' }));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Платёж не прошёл. Деньги не списаны. Попробуйте другую карту или СБП.');
    await userEvent.click(within(alert).getByRole('button', { name: 'Повторить' }));
    expect(dialog()).toBeInTheDocument();
  });

  it('ожидание: статусный баннер; «Скрыть» убирает его', async () => {
    renderBilling();
    await userEvent.click(within(cardOf('Пакет ИИ')).getByRole('button', { name: 'Подключить' }));
    await userEvent.click(within(dialog()).getByRole('button', { name: 'ожидание' }));
    const banner = screen.getByRole('status');
    expect(within(screen.getByRole('table')).getByText('Ожидает')).toBeInTheDocument();
    await userEvent.click(within(banner).getByRole('button', { name: 'Скрыть' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
