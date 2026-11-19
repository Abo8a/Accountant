import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelinePassportField, PipelineResponse } from '@passport/contracts';
import type { CabinetState } from '../../shared/api/cabinet';

// Доработка пробелов прямо в блоках паспорта (раздела «Пробелы» больше нет).

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  call: vi.fn(),
  refresh: vi.fn(async () => undefined),
}));
vi.mock('../../shared/state/cabinet', () => ({ useCabinetState: () => mocks.state, refreshCabinetState: mocks.refresh }));
vi.mock('../../shared/api/pipeline', () => ({ callPassportPipeline: mocks.call }));
vi.mock('../../shared/api/challenges', () => ({ fetchChallenges: async () => [] }));
vi.mock('../consultant/ConsultantWidget', () => ({ ConsultantWidget: () => null }));

import { LivePassport } from './LivePassport';

function field(section_id: number, field_key: string, value: string | null, review_status = 'reviewed'): PipelinePassportField {
  return { section_id, field_key, value, review_status, claims: [] };
}

function cabinet(passport: PipelinePassportField[], extra: Partial<CabinetState> = {}): CabinetState {
  return {
    plan_id: 'free',
    plan_expires_at: null,
    files_used: 0,
    files_limit: 5,
    founder: { full_name: 'Иванов Иван' },
    study_certificate: null,
    files: [],
    project_status: null,
    passport,
    block_audits: [],
    budget_audit: null,
    result: null,
    ...extra,
  };
}

const QUESTION: PipelineResponse = {
  status: 'NEED_USER_INPUT',
  step: 'GAP_FILLING',
  target_field: { section_id: 6, field_key: 'analogues_comparison' },
  question: 'С какими аналогами вы сравниваете продукт?',
  criteria: 'Не меньше двух аналогов',
  example: 'Аналог А, аналог Б…',
};

const PASSPORT = [
  field(2, 'team_members', 'Иван — разработчик'),
  field(4, 'direction', 'Н1'),
  field(4, 'tech_challenge', null),
  field(4, 'product_summary', 'Сервис для бухгалтерии'),
  field(6, 'analogues_comparison', null),
  field(6, 'novelty_hypothesis', 'Быстрее аналогов', 'needs_review'),
];

function renderAt(path = '/passport') {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <LivePassport />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.call.mockReset();
  mocks.call.mockResolvedValue({ status: 'NEED_USER_INPUT', step: 'GAP_FILLING' });
  mocks.state = cabinet(PASSPORT);
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('LivePassport — доработка в блоках', () => {
  it('открывает блок текущего вопроса пайплайна и показывает вопрос у пустого поля', () => {
    window.sessionStorage.setItem('buha.flow', JSON.stringify({ last: QUESTION }));
    mocks.state = cabinet(PASSPORT);
    renderAt();
    expect(screen.getByRole('heading', { level: 2, name: 'Аналоги и предполагаемые отличия' })).toBeInTheDocument();
    expect(screen.getByText('С какими аналогами вы сравниваете продукт?')).toBeInTheDocument();
  });

  it('пустое поле: «Заполнить» → ответ уходит с проверкой ИИ (submit_answer)', async () => {
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const card = screen.getByRole('heading', { level: 3, name: 'Аналоги и сравнение' }).closest('article')!;
    expect(within(card).getByText('Пока не заполнено.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    await user.type(within(card).getByRole('textbox'), 'Аналог А и аналог Б');
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({
        action: 'submit_answer',
        target_field: { section_id: 6, field_key: 'analogues_comparison' },
        text_input: 'Аналог А и аналог Б',
      }),
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it('отклонённый ответ: замечание под полем, черновик остаётся', async () => {
    mocks.call.mockImplementation(async (body: { action: string }) =>
      body.action === 'submit_answer'
        ? { status: 'ANSWER_REJECTED', step: 'ANSWER_VALIDATION', rejection_reason: 'Нужно минимум два аналога.' }
        : { status: 'NEED_USER_INPUT', step: 'GAP_FILLING' },
    );
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const card = screen.getByRole('heading', { level: 3, name: 'Аналоги и сравнение' }).closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    await user.type(within(card).getByRole('textbox'), 'Аналог А');
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }));
    expect(await within(card).findByText('Нужно минимум два аналога.')).toBeInTheDocument();
    expect(within(card).getByRole('textbox')).toHaveValue('Аналог А');
  });

  it('вопрос пайплайна, критерий и пример — в редакторе поля, о котором спрашивают', async () => {
    window.sessionStorage.setItem('buha.flow', JSON.stringify({ last: QUESTION }));
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const card = screen.getByRole('heading', { level: 3, name: 'Аналоги и сравнение' }).closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    expect(within(card).getByText('С какими аналогами вы сравниваете продукт?')).toBeInTheDocument();
    expect(within(card).getByText('Что проверяет фонд: Не меньше двух аналогов')).toBeInTheDocument();
    expect(within(card).getByText('Как обычно пишут: Аналог А, аналог Б…')).toBeInTheDocument();
    await user.type(within(card).getByRole('textbox'), 'А и Б');
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ action: 'submit_answer', previous_question: QUESTION.question })),
    );
  });

  it('поле с замечанием — тоже ответ с проверкой ИИ; заполненное без замечаний — правка (submit_form)', async () => {
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const needs = screen.getByRole('heading', { level: 3, name: 'Гипотеза отличия' }).closest('article')!;
    await user.click(within(needs).getByRole('button', { name: 'Править' }));
    await user.click(within(needs).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ action: 'submit_answer', text_input: 'Быстрее аналогов' })));

    await user.click(screen.getByRole('button', { name: /Команда/ }));
    const team = screen.getByRole('heading', { level: 3, name: 'Состав команды' }).closest('article')!;
    await user.click(within(team).getByRole('button', { name: 'Править' }));
    await user.click(within(team).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({ action: 'submit_form', form: [{ section_id: 2, field_key: 'team_members', value: 'Иван — разработчик' }] }),
    );
  });

  it('замечание аудита блока — над полями блока', () => {
    mocks.state = cabinet(PASSPORT, {
      block_audits: [{ section_id: 6, status: 'needs_review', remark: 'Один аналог — мало.', how_to_fix: 'Добавьте второй.', failed_fields: ['analogues_comparison'] }],
    });
    renderAt('/passport?block=6');
    expect(screen.getByText('Один аналог — мало. Добавьте второй.')).toBeInTheDocument();
  });

  it('смета — пункт под блоками; ссылка ?block=budget открывает её', () => {
    mocks.state = cabinet(PASSPORT, { budget_audit: { status: 'needs_review', remark: 'Превышен лимит 1-го этапа.', how_to_fix: null, violations: [] } });
    renderAt('/passport?block=budget');
    const nav = screen.getByRole('navigation', { name: 'Блоки паспорта' });
    expect(within(nav).getByRole('button', { name: 'Смета' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'Смета' })).toBeInTheDocument();
    expect(screen.getByText('Превышен лимит 1-го этапа.')).toBeInTheDocument();
  });

  it('без сохранённого шага спрашивает текущий шаг у пайплайна (без текста — бесплатно)', async () => {
    renderAt();
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith({ action: 'init_or_upload' }));
  });

  it('направление выбирается в блоке 4, у вызова своей кнопки нет', async () => {
    const user = userEvent.setup();
    renderAt('/passport?block=4');
    const direction = screen.getByRole('heading', { level: 3, name: 'Направление (Н1–Н7)' }).closest('article')!;
    const challenge = screen.getByRole('heading', { level: 3, name: 'Технологический вызов (№)' }).closest('article')!;
    expect(within(challenge).queryByRole('button')).not.toBeInTheDocument();
    await user.click(within(direction).getByRole('button', { name: 'Править' }));
    expect(within(direction).getByRole('button', { name: 'Отмена' })).toBeInTheDocument();
  });
});
