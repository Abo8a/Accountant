import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { PipelineCompleted } from '@passport/contracts';
import { Result, todoFromCompleted } from './Result';

function renderResult() {
  return render(
    <MemoryRouter>
      <Result />
    </MemoryRouter>,
  );
}

const todoList = () => screen.getByRole('region', { name: 'Что сделать перед подачей' });
const pickVariant = (name: string) => userEvent.click(within(screen.getByRole('group', { name: 'Вариант статуса для прототипа' })).getByRole('button', { name }));

describe('Result', () => {
  it('рендерит заголовок экрана из дизайна', () => {
    renderResult();
    expect(screen.getByRole('heading', { level: 1, name: 'Итог' })).toBeInTheDocument();
  });

  it('по умолчанию — «Нужно уточнить»: один список из шести пунктов, отсортированный по блокам', () => {
    renderResult();
    expect(screen.getByRole('heading', { level: 2, name: 'Нужно уточнить' })).toBeInTheDocument();
    const links = within(todoList()).getAllByRole('link').map((a) => a.textContent);
    expect(links).toEqual(['Блок 1', 'Блок 6', 'Блок 7', 'Блок 9', 'Блок 10', 'Смета']);
    expect(within(todoList()).getAllByText('Нужно доработать')).toHaveLength(3);
    expect(screen.getByText('Сделано 1 из 6')).toBeInTheDocument();
    for (const name of ['Стоп-факторы', 'Предупреждения']) {
      expect(screen.queryByRole('heading', { name })).not.toBeInTheDocument();
    }
  });

  it('вариант «Стоп»: стоп-факторы в общем списке с меткой', async () => {
    renderResult();
    await pickVariant('Стоп');
    expect(screen.getByRole('heading', { level: 2, name: 'Есть стоп-факторы' })).toBeInTheDocument();
    expect(within(todoList()).getAllByText('Стоп-фактор')).toHaveLength(3);
    expect(screen.getByText('Уменьшить расходы 1-го этапа: сейчас 25 000 ₽, лимит — 20 000 ₽')).toBeInTheDocument();
  });

  it('вариант «Тема»: один стоп-фактор с объяснением, как исправить', async () => {
    renderResult();
    await pickVariant('Тема');
    expect(screen.getByRole('heading', { level: 2, name: 'Тема не подходит программе' })).toBeInTheDocument();
    expect(screen.getByText('Нет научно-технической основы: проект описывает перепродажу и сервис без собственной разработки')).toBeInTheDocument();
    expect(screen.getByText(/ФСИ поддерживает только технологические проекты/)).toBeInTheDocument();
  });

  it('вариант «Допуск»: список пуст, «Всё готово», скачивание доступно', async () => {
    renderResult();
    await pickVariant('Допуск');
    expect(screen.getByText('Всё готово: стоп-факторов нет, блоки и смета одобрены аудитом')).toBeInTheDocument();
    expect(screen.getByText('Все блоки и смета одобрены аудитом')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скачать DOCX' })).toBeEnabled();
  });

  it('отметка пункта зачёркивает его и увеличивает счётчик', async () => {
    renderResult();
    const box = screen.getByRole('checkbox', { name: 'Приложить материалы двух фокус-групп и подтверждение выручки 10 000 ₽' });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByText('Сделано 2 из 6')).toBeInTheDocument();
  });

  it('подтверждённость паспорта — три цвета', () => {
    renderResult();
    for (const name of ['Подтверждено документом', 'Без документа', 'Планы и гипотезы']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.queryByText('Со слов команды')).not.toBeInTheDocument();
  });

  it('пока список не закрыт, скачивание недоступно и есть пояснение', () => {
    renderResult();
    expect(screen.getByText('Скачать можно, когда будут закрыты все пункты списка «Что сделать перед подачей».')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скачать DOCX' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Скачать PDF' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Согласовать паспорт' })).not.toBeInTheDocument();
  });

  it('«Проверить заново» ведёт на сборку, пункты смета — на пробелы', () => {
    renderResult();
    expect(screen.getByRole('link', { name: 'Проверить заново' })).toHaveAttribute('href', '/generating');
    expect(within(todoList()).getByRole('link', { name: 'Смета' })).toHaveAttribute('href', '/gaps');
    expect(within(todoList()).getByRole('link', { name: 'Блок 1' })).toHaveAttribute('href', '/passport');
  });
});

describe('todoFromCompleted (живой режим)', () => {
  const base: PipelineCompleted = {
    status: 'COMPLETED',
    export_ready: false,
    not_approved: ['Блок 6'],
    eligibility_status: 'NEEDS_CLARIFICATION',
    summary: '',
    checklist: ['Справка об обучении'],
    warnings: ['3 факта без документов'],
    passport: [],
  };

  it('собирает стоп-факторы, неодобренные блоки, смету и документы в один список по блокам', () => {
    const items = todoFromCompleted({
      ...base,
      fatal_stop_factors: [{ code: 'NO_TECH_BASIS', reason: 'Нет научно-технической основы', how_to_fix: 'Опишите разработку', affected_sections: [6, 4] }],
      block_audits: [
        { section_id: 6, status: 'needs_review', remark: 'Один аналог из двух', how_to_fix: 'Добавьте второй аналог', failed_fields: [] },
        { section_id: 2, status: 'approved', remark: null, how_to_fix: null, failed_fields: [] },
      ],
      budget_audit: { status: 'needs_review', remark: null, how_to_fix: null, violations: [] },
    });
    expect(items.map((i) => [i.block, i.kind ?? null, i.text])).toEqual([
      ['Блоки 4, 6', 'stop', 'Нет научно-технической основы'],
      ['Блок 6', 'audit', 'Один аналог из двух'],
      ['Паспорт', null, '3 факта без документов'],
      ['Паспорт', null, 'Справка об обучении'],
      ['Смета', 'audit', 'Исправить смету по замечаниям аудита'],
    ]);
    expect(items[0].fix).toBe('Опишите разработку');
  });

  it('одобренная смета и блоки в список не попадают', () => {
    const items = todoFromCompleted({
      ...base,
      checklist: [],
      warnings: [],
      block_audits: [{ section_id: 3, status: 'approved', remark: null, how_to_fix: null, failed_fields: [] }],
      budget_audit: { status: 'approved', remark: null, how_to_fix: null, violations: [] },
    });
    expect(items).toEqual([]);
  });
});
