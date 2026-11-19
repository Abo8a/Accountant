import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createDemoAdminBillingService } from '../../shared/data/adminBilling';
import { AdminBilling } from './AdminBilling';

function renderBilling() {
  const service = createDemoAdminBillingService();
  const savePlans = vi.spyOn(service, 'savePlans');
  render(<AdminBilling service={service} />);
  return { service, savePlans, user: userEvent.setup() };
}

describe('AdminBilling', () => {
  it('рендерит заголовок экрана и переключатель разделов из дизайна', () => {
    renderBilling();
    expect(screen.getByRole('heading', { level: 1, name: 'Платежи и тарифы' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Платежи' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Тарифы' })).toHaveAttribute('aria-selected', 'false');
  });

  it('сводка без данных сервиса: все три плейсхолдера показывают «—», а не демо-значения', async () => {
    renderBilling();
    const revenue = await screen.findByText('Выручка за месяц');
    expect(revenue.parentElement).toHaveTextContent(/^Выручка за месяц—$/);
    expect(screen.getByText('Активных подписок').parentElement).toHaveTextContent(/^Активных подписок—$/);
    expect(screen.getByText('Ожидают подтверждения').parentElement).toHaveTextContent(/^Ожидают подтверждения—$/);
  });

  it('когда сервис отдал значения сводки, экран показывает их (подключение на G5)', async () => {
    const demo = createDemoAdminBillingService();
    const service = {
      ...demo,
      getSummary: async () => ({ revenueMonthRub: 1234, activeSubscriptions: 7, pendingCount: 3 }),
    };
    render(<AdminBilling service={service} />);
    await waitFor(() => expect(screen.getByText('Выручка за месяц').parentElement).toHaveTextContent('1 234 ₽'));
    expect(screen.getByText('Активных подписок').parentElement).toHaveTextContent(/^Активных подписок7$/);
    expect(screen.getByText('Ожидают подтверждения').parentElement).toHaveTextContent(/^Ожидают подтверждения3$/);
  });

  it('показывает строки платежей из сервиса', async () => {
    renderBilling();
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(6));

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'ID платежа' })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(6);
    expect(within(table).getAllByText('Мария Ли')).toHaveLength(2);
    expect(within(table).getByText('4 990 ₽')).toBeInTheDocument();
    expect(within(table).getByText('2f9a…c41e')).toBeInTheDocument();
    expect(screen.getByText('Повторное уведомление ЮKassa с тем же ID не создаёт второй платёж.')).toBeInTheDocument();
  });

  it('фильтр платежей по статусу оставляет строки выбранного статуса и возвращается к «Все»', async () => {
    const { user } = renderBilling();
    const table = await screen.findByRole('table');

    await user.click(screen.getByRole('button', { name: 'Ошибка' }));
    expect(screen.getByRole('button', { name: 'Ошибка' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Анна Смирнова')).toBeInTheDocument();
    expect(within(table).queryByText('Мария Ли')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Все' }));
    expect(within(table).getAllByRole('row')).toHaveLength(6);
  });

  it('вкладка «Тарифы»: бесплатный и «Пакет ИИ» с ценой, файлами и ИИ-кредитами', async () => {
    const { user } = renderBilling();
    await user.click(screen.getByRole('tab', { name: 'Тарифы' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Бесплатный' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Пакет ИИ' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Премиум' })).not.toBeInTheDocument();

    const values = (name: string) => screen.getAllByRole('spinbutton', { name }).map((input) => (input as HTMLInputElement).value);
    expect(values('Цена, ₽')).toEqual(['0', '499']);
    expect(values('Лимит файлов')).toEqual(['5', '10']);
    expect(values('ИИ-кредиты')).toEqual(['20', '60']);
    const consultant = screen.getAllByRole('checkbox', { name: 'Консультант' });
    expect(consultant.map((input) => (input as HTMLInputElement).checked)).toEqual([true, true]);
  });

  it('изменение тарифа и «Сохранить тарифы» отправляет новые значения в сервис', async () => {
    const { user, savePlans } = renderBilling();
    await user.click(screen.getByRole('tab', { name: 'Тарифы' }));
    await screen.findByRole('heading', { level: 2, name: 'Пакет ИИ' });

    const packCredits = screen.getAllByRole('spinbutton', { name: 'ИИ-кредиты' })[1];
    await user.clear(packCredits);
    await user.type(packCredits, '80');
    await user.click(screen.getByRole('button', { name: 'Сохранить тарифы' }));

    expect(savePlans).toHaveBeenCalledTimes(1);
    const saved = savePlans.mock.calls[0][0];
    expect(saved.find((plan) => plan.id === 'ai_pack')).toMatchObject({ ai_credits: 80, price_rub: 499 });
    expect(saved.find((plan) => plan.id === 'free')?.ai_credits).toBe(20);
    expect(await screen.findByText('Сохранено. Уже оплаченные подписки не меняются.')).toBeInTheDocument();
  });

  it('после правки тарифа статус снова показывает подсказку до сохранения', async () => {
    const { user } = renderBilling();
    await user.click(screen.getByRole('tab', { name: 'Тарифы' }));
    await screen.findByRole('heading', { level: 2, name: 'Пакет ИИ' });

    await user.click(screen.getByRole('button', { name: 'Сохранить тарифы' }));
    expect(await screen.findByText('Сохранено. Уже оплаченные подписки не меняются.')).toBeInTheDocument();

    await user.click(screen.getAllByRole('checkbox', { name: 'Проверка новизны' })[0]);
    expect(screen.getByText('Новые цены применятся к следующим оплатам.')).toBeInTheDocument();
  });

  it('флаги функций тарифа переключаются', async () => {
    const { user } = renderBilling();
    await user.click(screen.getByRole('tab', { name: 'Тарифы' }));
    await screen.findByRole('heading', { level: 2, name: 'Пакет ИИ' });

    const consultant = screen.getAllByRole('checkbox', { name: 'Консультант' })[1];
    await user.click(consultant);
    expect(consultant).not.toBeChecked();
  });
});
