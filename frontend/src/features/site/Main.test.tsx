import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Auth } from './Auth';
import { Main } from './Main';
import { Pricing } from './Pricing';

// Показывает текущий путь, чтобы проверять переходы по ссылкам.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSite(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<Main />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/auth" element={<Auth />} />
      </Routes>
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId('location').textContent;

describe('Main (лендинг)', () => {
  it('рендерит заголовок экрана из дизайна', () => {
    renderSite('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Сервис быстрого описания проекта для грантов' })).toBeInTheDocument();
  });

  it('первый экран и шаги говорят о паспорте по шаблону и требованиям фонда', () => {
    renderSite('/');
    expect(screen.getByText('Расскажите идею или загрузите презентацию. Буха соберёт паспорт проекта по шаблону и требованиям фонда — в том виде, в котором его подают на конкурс. Найдёт пробелы и покажет, что мешает допуску.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Строго по шаблону фонда' })).toBeInTheDocument();
    expect(screen.getByText('Паспорт проекта в DOCX и PDF, оформленный по шаблону и требованиям ФСИ, проверка на стоп-факторы и чек-лист документов.')).toBeInTheDocument();
    expect(screen.queryByText('Для команд, которые идут на «Студенческий стартап» ФСИ')).not.toBeInTheDocument();
    expect(screen.queryByText('Факт, план или гипотеза')).not.toBeInTheDocument();
  });

  it('рендерит ключевые заголовки секций дизайна', () => {
    renderSite('/');
    for (const name of [
      'Как это работает',
      'Эксперт фонда заметит приукрашивание. Буха — раньше',
      'Тарифы',
      'Вопросы',
      'Начните с того, что уже есть',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('heading', { name: '10 блоков паспорта' })).not.toBeInTheDocument();
  });

  it('CTA «Собрать паспорт бесплатно» есть дважды и ведёт на /auth', async () => {
    renderSite('/');
    const ctas = screen.getAllByRole('link', { name: 'Собрать паспорт бесплатно' });
    expect(ctas).toHaveLength(2);
    for (const cta of ctas) {
      expect(cta).toHaveAttribute('href', '/auth');
    }
    await userEvent.click(ctas[0]);
    expect(location()).toBe('/auth');
  });

  it('«Тарифы» в меню ведёт на /pricing', async () => {
    renderSite('/');
    const nav = screen.getByRole('navigation', { name: 'Основная навигация' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Тарифы' }));
    expect(location()).toBe('/pricing');
    expect(screen.getByRole('heading', { level: 1, name: 'Тарифы и цены' })).toBeInTheDocument();
  });

  it('«Войти» ведёт на /auth', async () => {
    renderSite('/');
    await userEvent.click(screen.getByRole('link', { name: 'Войти' }));
    expect(location()).toBe('/auth');
    expect(screen.getByRole('heading', { level: 1, name: 'Создайте аккаунт' })).toBeInTheDocument();
  });

  it('«Посмотреть тарифы» и «Подробнее о тарифах» ведут на /pricing', () => {
    renderSite('/');
    expect(screen.getByRole('link', { name: 'Посмотреть тарифы' })).toHaveAttribute('href', '/pricing');
    expect(screen.getByRole('link', { name: 'Подробнее о тарифах' })).toHaveAttribute('href', '/pricing');
  });

  it('тарифы: бесплатно и «Пакет ИИ», как на странице тарифов; без переключателя «Продление»', () => {
    renderSite('/');
    expect(screen.getByRole('heading', { level: 3, name: 'Бесплатно' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Пакет ИИ' })).toBeInTheDocument();
    expect(screen.getByText('0 ₽')).toBeInTheDocument();
    expect(screen.getByText('499 ₽')).toBeInTheDocument();
    expect(screen.getByText('20 ИИ-кредитов — один раз')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Начать бесплатно' })).toHaveAttribute('href', '/auth');
    expect(screen.getByRole('link', { name: 'Подключить пакет' })).toHaveAttribute('href', '/auth');
    expect(screen.queryByRole('group', { name: 'Период оплаты' })).not.toBeInTheDocument();
    expect(screen.queryByText('Профессиональный')).not.toBeInTheDocument();
  });

  it('услуги специалистов на лендинге: 5% с потолком 50 000 ₽ и отчёт по этапу', () => {
    renderSite('/');
    expect(screen.getByRole('heading', { level: 3, name: 'Услуги специалистов' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Сопровождение после результата' })).toBeInTheDocument();
    expect(screen.getByText('от полученного финансирования, максимум 50 000 ₽')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Отчёт по этапу' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Оставить заявку' })).toHaveLength(2);
  });

  it('блок «Эксперт фонда»: фрагмент паспорта с тремя цветами и три пункта', () => {
    renderSite('/');
    expect(screen.getByText('Блок 7 · Фрагмент паспорта')).toBeInTheDocument();
    for (const label of ['Подтверждено документом', 'Без документа', 'План или гипотеза']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    for (const name of ['Видно, что доказано, а что — слова', 'ИИ не дописывает достижения', 'Новизна — минимум два аналога']) {
      expect(screen.getByRole('heading', { level: 3, name })).toBeInTheDocument();
    }
    expect(screen.queryByText('Поправили текст — связи пересчитаются')).not.toBeInTheDocument();
  });

  it('шесть вопросов FAQ, каждый — раскрывающийся блок; про файлы, кредиты и процент — по новой модели', () => {
    renderSite('/');
    const items = document.querySelectorAll('details.main__faq-item');
    expect(items).toHaveLength(6);
    expect(screen.getByText('PDF, DOCX и PPTX, включая сканы. Бесплатно — до 5 файлов, с «Пакетом ИИ» — до 10.')).toBeInTheDocument();
    expect(screen.getByText('Что будет, когда закончатся ИИ-кредиты?')).toBeInTheDocument();
    expect(screen.getByText('Нужно ли платить процент после победы?')).toBeInTheDocument();
    expect(screen.queryByText(/«Профессиональный» и «Премиум»/)).not.toBeInTheDocument();
    expect(screen.getByText('Буха гарантирует победу в конкурсе?')).toBeInTheDocument();
    expect(screen.getByText('Это официальный сервис фонда?')).toBeInTheDocument();
  });

  it('ссылки «Вопросы» и «Как это работает» — якоря на секции главной', () => {
    renderSite('/');
    const nav = screen.getByRole('navigation', { name: 'Основная навигация' });
    expect(within(nav).getByRole('link', { name: 'Вопросы' })).toHaveAttribute('href', '/#faq');
    expect(within(nav).getByRole('link', { name: 'Как это работает' })).toHaveAttribute('href', '/#how');
    expect(document.getElementById('faq')).not.toBeNull();
    expect(document.getElementById('how')).not.toBeNull();
    expect(document.getElementById('passport')).not.toBeNull();
  });
});
