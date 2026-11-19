import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PlansModal } from './PlansModal';

describe('PlansModal', () => {
  it('показывает тарифы, которые продаются: бесплатный и «Пакет ИИ», и как считаются кредиты', () => {
    render(<PlansModal onClose={() => {}} />);

    const dialog = screen.getByRole('dialog', { name: 'Тарифы' });
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Тарифы' })).toBeInTheDocument();

    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByRole('heading', { level: 3, name: 'Бесплатный' })).toBeInTheDocument();
    expect(items[0]).toHaveTextContent('0 ₽');
    expect(items[0]).not.toHaveTextContent('за');
    expect(items[0]).toHaveTextContent('До 5 файлов и 20 ИИ-кредитов один раз.');

    expect(within(items[1]).getByRole('heading', { level: 3, name: 'Пакет ИИ' })).toBeInTheDocument();
    expect(items[1]).toHaveTextContent('499 ₽ за 30 дней');
    expect(items[1]).toHaveTextContent('60 ИИ-кредитов на 30 дней и до 10 файлов. Без автопродления.');

    expect(within(dialog).getByText(/Технические ошибки кредиты не списывают/)).toBeInTheDocument();
  });

  it('при открытии фокус внутри окна', () => {
    render(<PlansModal onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'Тарифы' })).toHaveFocus();
  });

  it('закрывается по крестику', async () => {
    const onClose = vi.fn();
    render(<PlansModal onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('закрывается по Esc', async () => {
    const onClose = vi.fn();
    render(<PlansModal onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('закрывается по клику на подложку, но не по клику внутри окна', async () => {
    const onClose = vi.fn();
    const { container } = render(<PlansModal onClose={onClose} />);

    await userEvent.click(screen.getByRole('heading', { level: 3, name: 'Пакет ИИ' }));
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(container.querySelector('.plans-modal__overlay') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
