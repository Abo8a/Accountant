import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Auth } from './Auth';
import { Pricing } from './Pricing';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderPricing() {
  return render(
    <MemoryRouter initialEntries={['/pricing']}>
      <LocationProbe />
      <Routes>
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/auth" element={<Auth />} />
      </Routes>
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId('location').textContent;

describe('Pricing (тарифы)', () => {
  it('рендерит заголовок экрана из дизайна', () => {
    renderPricing();
    expect(screen.getByRole('heading', { level: 1, name: 'Тарифы и цены' })).toBeInTheDocument();
  });

  it('два тарифа: бесплатно с 20 ИИ-кредитами один раз и «Пакет ИИ» за 499 ₽ на 30 дней', () => {
    renderPricing();
    expect(screen.getByRole('heading', { level: 2, name: 'Бесплатно' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Пакет ИИ' })).toBeInTheDocument();
    expect(screen.getByText('0 ₽')).toBeInTheDocument();
    expect(screen.getByText('499 ₽')).toBeInTheDocument();
    expect(screen.getByText('20 ИИ-кредитов — один раз')).toBeInTheDocument();
    expect(screen.getByText('60 ИИ-кредитов на 30 дней')).toBeInTheDocument();
    expect(screen.getByText('Без автопродления')).toBeInTheDocument();
    expect(screen.getByText('После окончания паспорт и тексты остаются у вас')).toBeInTheDocument();
  });

  it('старых подписок, скидок и переключателя «Продление» нет', () => {
    renderPricing();
    for (const text of ['Профессиональный', 'Премиум', '990 ₽', '4 990 ₽', 'Продление']) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('group', { name: 'Период оплаты' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Скидка/)).not.toBeInTheDocument();
  });

  it('объясняет, сколько стоит работа ИИ в кредитах', () => {
    renderPricing();
    expect(screen.getByText(/шаг с ИИ или сообщение консультанту — 1 кредит, разбор одного файла — 2 кредита/)).toBeInTheDocument();
    expect(screen.getByText(/Технические ошибки кредиты не списывают/)).toBeInTheDocument();
  });

  it('«Начать бесплатно» и «Подключить пакет» ведут на /auth', async () => {
    renderPricing();
    expect(screen.getByRole('link', { name: 'Начать бесплатно' })).toHaveAttribute('href', '/auth');
    expect(screen.getByRole('link', { name: 'Подключить пакет' })).toHaveAttribute('href', '/auth');

    await userEvent.click(screen.getByRole('link', { name: 'Подключить пакет' }));
    expect(location()).toBe('/auth');
    expect(screen.getByRole('heading', { level: 1, name: 'Создайте аккаунт' })).toBeInTheDocument();
  });

  it('таблица сравнения: 10 строк и две колонки тарифов; файлы 5 / 10, кредиты 20 один раз / 60 на 30 дней', () => {
    renderPricing();
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['Возможность', 'Бесплатно', 'Пакет ИИ']);
    expect(within(table).getAllByRole('rowheader')).toHaveLength(10);
    const cellsOf = (feature: string) =>
      within(within(table).getByRole('rowheader', { name: feature }).closest('tr') as HTMLElement)
        .getAllByRole('cell')
        .map((td) => td.textContent);
    expect(cellsOf('Файлов в проекте')).toEqual(['5', '10']);
    expect(cellsOf('ИИ-кредиты')).toEqual(['20 один раз', '60 на 30 дней']);
    expect(cellsOf('Проверка научно-технической новизны')).toEqual(['Да', 'Да']);
    expect(cellsOf('Консультант')).toEqual(['Да', 'Да']);
    expect(cellsOf('Автопродление')).toEqual(['—', 'Нет']);
  });

  it('услуги специалистов: 5% с потолком 50 000 ₽ и отчёт по этапу от 14 900 ₽', () => {
    renderPricing();
    expect(screen.getByRole('heading', { level: 2, name: 'Услуги специалистов' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Сопровождение после результата' })).toBeInTheDocument();
    expect(screen.getByText('5%')).toBeInTheDocument();
    expect(screen.getByText('от полученного финансирования, максимум 50 000 ₽')).toBeInTheDocument();
    expect(screen.getByText('Не из средств гранта: из собственных средств или от другого плательщика')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Отчёт по этапу' })).toBeInTheDocument();
    expect(screen.getByText('от 14 900 ₽')).toBeInTheDocument();
    const requests = screen.getAllByRole('link', { name: 'Оставить заявку' });
    expect(requests).toHaveLength(2);
    for (const link of requests) expect(link).toHaveAttribute('href', '/support');
  });

  it('партнёрских потоков и студии на странице нет', () => {
    renderPricing();
    expect(screen.queryByText(/Студия/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Партнёрский поток/)).not.toBeInTheDocument();
  });

  it('страница без подвала, как в эталоне', () => {
    renderPricing();
    expect(screen.queryByText('© 2026 Буха. Независимый сервис, не связан с ФСИ.')).not.toBeInTheDocument();
  });

  it('без подзаголовка и нижних карточек про оплату, срок и проект', () => {
    renderPricing();
    expect(screen.queryByText('Начните бесплатно. Платный доступ нужен, чтобы Буха разобрала ваши документы и проверила новизну.')).not.toBeInTheDocument();
    for (const name of ['Оплата через ЮKassa', '30 дней доступа', 'Один аккаунт — один проект']) {
      expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
    }
  });
});
