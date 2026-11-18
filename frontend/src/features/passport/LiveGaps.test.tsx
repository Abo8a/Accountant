import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResponse } from '@passport/contracts';
import { callPassportPipeline } from '../../shared/api/pipeline';
import { LiveGaps } from './LiveGaps';

vi.mock('../../shared/api/pipeline', () => ({ callPassportPipeline: vi.fn() }));
const mockPipeline = vi.mocked(callPassportPipeline);

const GAP: PipelineResponse = {
  status: 'NEED_USER_INPUT',
  step: 'GAP_FILLING',
  target_field: { section_id: 3, field_key: 'target_audience' },
  question: 'Кто целевые пользователи?',
  example: 'Студенты очных программ вузов Самары.',
  rejection_reason: null,
} satisfies PipelineResponse;

function renderGaps(initial: PipelineResponse | undefined, onDone = vi.fn()) {
  render(
    <MemoryRouter>
      <LiveGaps initial={initial} onDone={onDone} />
    </MemoryRouter>,
  );
  return onDone;
}

describe('LiveGaps (живые пробелы)', () => {
  beforeEach(() => {
    mockPipeline.mockReset();
  });

  it('без ответа в этой вкладке спрашивает текущий шаг у пайплайна; проекта нет — просит начать с брифа', async () => {
    mockPipeline.mockResolvedValue({ status: 'WAITING_FOR_INITIAL_BRIEF', step: 'INITIAL_BRIEF', question: 'Опишите проект', example: '' });
    renderGaps(undefined);
    expect(mockPipeline).toHaveBeenCalledWith({ action: 'init_or_upload' });
    expect(await screen.findByText('Сначала опишите проект.')).toBeInTheDocument();
  });

  it('без ответа в этой вкладке показывает текущий пробел из пайплайна', async () => {
    mockPipeline.mockResolvedValue(GAP);
    renderGaps(undefined);
    expect(await screen.findByText('Кто целевые пользователи?')).toBeInTheDocument();
  });

  it('отклонённый ответ остаётся в поле вместе с замечанием', async () => {
    mockPipeline.mockResolvedValue({
      status: 'ANSWER_REJECTED',
      step: 'ANSWER_VALIDATION',
      target_field: GAP.status === 'NEED_USER_INPUT' ? GAP.target_field : undefined,
      question: 'Кто целевые пользователи?',
      example: '',
      rejection_reason: 'Уточните сегмент: какие студенты и в каком городе.',
    } as PipelineResponse);
    renderGaps(GAP);
    await userEvent.type(screen.getByLabelText('Ваш ответ'), 'Студенты');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить ответ' }));
    expect(await screen.findByText('Уточните сегмент: какие студенты и в каком городе.')).toBeInTheDocument();
    expect(screen.getByLabelText('Ваш ответ')).toHaveValue('Студенты');
  });

  it('показывает вопрос пайплайна и пример', () => {
    renderGaps(GAP);
    expect(screen.getByText('Кто целевые пользователи?')).toBeInTheDocument();
    expect(screen.getByText(/Студенты очных программ вузов Самары/)).toBeInTheDocument();
  });

  it('показывает, что проверяет фонд, и пример под подписью «Как обычно пишут»', () => {
    renderGaps({ ...GAP, criteria: 'Указан конкретный сегмент пользователей.' });
    expect(screen.getByText('Что проверяет фонд: Указан конкретный сегмент пользователей.')).toBeInTheDocument();
    expect(screen.getByText(/Как обычно пишут: Студенты очных программ вузов Самары/)).toBeInTheDocument();
  });

  it('ответ уходит как submit_answer с целевым полем и вопросом', async () => {
    mockPipeline.mockResolvedValue({ ...GAP, question: 'Следующий вопрос' } as PipelineResponse);
    renderGaps(GAP);
    await userEvent.type(screen.getByLabelText('Ваш ответ'), 'Студенты очных программ вузов Самары.');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить ответ' }));
    expect(mockPipeline).toHaveBeenCalledWith({
      action: 'submit_answer',
      target_field: { section_id: 3, field_key: 'target_audience' },
      previous_question: 'Кто целевые пользователи?',
      text_input: 'Студенты очных программ вузов Самары.',
    });
    expect(await screen.findByText('Следующий вопрос')).toBeInTheDocument();
  });

  it('«Пропустить и вернуться позже» отправляет skip_gap с пропущенным полем', async () => {
    mockPipeline.mockResolvedValue({
      status: 'NEED_USER_INPUT',
      step: 'GAP_FILLING',
      question: 'Пропущено пробелов: 1. Вернитесь к ним позже.',
      rejection_reason: null,
    } as PipelineResponse);
    renderGaps(GAP);
    await userEvent.click(screen.getByRole('button', { name: 'Пропустить и вернуться позже' }));
    expect(mockPipeline).toHaveBeenCalledWith({
      action: 'skip_gap',
      target_field: { section_id: 3, field_key: 'target_audience' },
      skipped_fields: [{ section_id: 3, field_key: 'target_audience' }],
    });
    expect(await screen.findByText('Закроем пробелы позже')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Перейти к паспорту' })).toBeInTheDocument();
  });

  it('«Не знаю — помогите» открывает ИИ-Консультанта', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderGaps(GAP);
    expect(screen.queryByRole('dialog', { name: 'ИИ-Консультант по гранту ФСИ' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Не знаю — помогите' }));
    expect(screen.getByRole('dialog', { name: 'ИИ-Консультант по гранту ФСИ' })).toBeInTheDocument();
  });

  it('на живом экране доступен ИИ-Консультант', () => {
    renderGaps(GAP);
    expect(screen.getByRole('button', { name: 'Открыть чат с ИИ-Консультантом' })).toBeInTheDocument();
  });

  it('пустой ответ не отправляется', async () => {
    renderGaps(GAP);
    await userEvent.click(screen.getByRole('button', { name: 'Отправить ответ' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Ответ пустой');
    expect(mockPipeline).not.toHaveBeenCalled();
  });

  it('замечание аудита (rejection_reason) показывается под вопросом', () => {
    renderGaps({ ...GAP, rejection_reason: 'Проблема описана без измеримых последствий.' });
    expect(screen.getByText('Проблема описана без измеримых последствий.')).toBeInTheDocument();
  });

  it('направление и вызов выбираются выбором, а не текстом', () => {
    renderGaps({ ...GAP, target_field: { section_id: 4, field_key: 'direction' }, question: 'Направление?' });
    // Направление выбирается кнопками (группа с именем «Направление проекта», может быть и fieldset, и SegmentedControl).
    expect(screen.getAllByRole('group', { name: 'Направление проекта' }).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Сохранить направление' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Ваш ответ')).not.toBeInTheDocument();
  });

  it('предложение направления и вызова показано вопросом и выбрано заранее — студент подтверждает или меняет', () => {
    renderGaps({
      ...GAP,
      target_field: { section_id: 4, field_key: 'direction' },
      question: 'По описанию проекта подходит направление Н4. Подходит ли оно вам?',
      suggestion: { direction: 'Н4', tech_challenge: null },
    } as PipelineResponse);
    expect(screen.getByText('По описанию проекта подходит направление Н4. Подходит ли оно вам?')).toBeInTheDocument();
    expect(screen.getByText(/Н4\. Новые приборы/)).toBeInTheDocument();
  });

  it('шаг сметы показывает таблицу сметы', () => {
    renderGaps({
      status: 'NEED_USER_INPUT',
      step: 'BUDGET_REVIEW',
      question: 'Смета не одобрена',
      rejection_reason: 'Смета: не заполнена.',
    } satisfies PipelineResponse);
    expect(screen.getByRole('button', { name: 'Сохранить смету' })).toBeInTheDocument();
    expect(screen.getByText(/Смета: не заполнена/)).toBeInTheDocument();
  });

  it('когда паспорт COMPLETED — вызывается onDone', async () => {
    mockPipeline.mockResolvedValue({
      status: 'COMPLETED',
      export_ready: true,
      not_approved: [],
      eligibility_status: 'ELIGIBLE',
      summary: 'Готово',
      checklist: [],
      warnings: [],
      passport: [],
    } satisfies PipelineResponse);
    const onDone = renderGaps(GAP);
    await userEvent.type(screen.getByLabelText('Ваш ответ'), 'Текст ответа.');
    await userEvent.click(screen.getByRole('button', { name: 'Отправить ответ' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
