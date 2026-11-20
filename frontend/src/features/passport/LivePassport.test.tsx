import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelinePassportField, PipelineResponse } from '@passport/contracts';
import type { CabinetState } from '../../shared/api/cabinet';

// Доработка прямо в блоках паспорта: «Сохранить» — сразу, без моделей; «Проверить» — модель по всем правкам разом.

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
  target_field: { section_id: 6, field_key: 'verification_protocol' },
  question: 'Как вы проверите отличие?',
  criteria: 'Измеримый протокол',
  example: 'A/B-сравнение…',
};

const PASSPORT = [
  field(2, 'team_members', 'Иван — разработчик'),
  field(4, 'direction', 'Н1'),
  field(4, 'tech_challenge', null),
  field(4, 'product_summary', 'Сервис для бухгалтерии'),
  field(6, 'verification_protocol', null),
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

describe("LivePassport — доработка в блоках", () => {
  it('открывает блок текущего вопроса пайплайна и показывает вопрос у пустого поля', () => {
    window.sessionStorage.setItem('buha.flow', JSON.stringify({ last: QUESTION }));
    mocks.state = cabinet(PASSPORT);
    renderAt();
    expect(screen.getByRole('heading', { level: 2, name: 'Аналоги и предполагаемые отличия' })).toBeInTheDocument();
    expect(screen.getByText('Как вы проверите отличие?')).toBeInTheDocument();
  });

  it('пустое поле: «Заполнить» → «Сохранить» сохраняет сразу, без проверки моделью (save_draft)', async () => {
    mocks.call.mockResolvedValue({ status: 'SAVED', pending_review: ['6/verification_protocol'] });
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const card = screen.getByRole('heading', { level: 3, name: 'Протокол проверки' }).closest('article')!;
    expect(within(card).getByText('Пока не заполнено.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    await user.type(within(card).getByRole('textbox'), 'A/B-сравнение на 50 пользователях');
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({
        action: 'save_draft',
        form: [{ section_id: 6, field_key: 'verification_protocol', value: 'A/B-сравнение на 50 пользователях' }],
      }),
    );
    expect(mocks.call).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'submit_answer' }));
    expect(mocks.refresh).toHaveBeenCalled();
    // Редактор закрылся сразу после сохранения
    await waitFor(() => expect(within(card).queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument());
  });

  it('ошибка сохранения: сообщение, черновик остаётся в редакторе', async () => {
    mocks.call.mockResolvedValue({ status: 'ERROR', code: 'INVALID_FIELD_VALUE', message: 'Не удалось сохранить.' });
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const card = screen.getByRole('heading', { level: 3, name: 'Протокол проверки' }).closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    await user.type(within(card).getByRole('textbox'), 'A/B');
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось сохранить.');
    expect(within(card).getByRole('textbox')).toHaveValue('A/B');
  });

  it('вопрос пайплайна, критерий и пример — в редакторе поля, о котором спрашивают', async () => {
    window.sessionStorage.setItem('buha.flow', JSON.stringify({ last: QUESTION }));
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const card = screen.getByRole('heading', { level: 3, name: 'Протокол проверки' }).closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    expect(within(card).getByText('Как вы проверите отличие?')).toBeInTheDocument();
    expect(within(card).getByText('Что проверяет фонд:').parentElement).toHaveTextContent('Что проверяет фонд: Измеримый протокол');
    expect(within(card).getByText('A/B-сравнение…')).toBeInTheDocument();
  });

  it('пример заполнения «Как обычно пишут» — у любого поля, раскрывается по клику', async () => {
    mocks.state = cabinet(PASSPORT, {
      field_hints: {
        '2/team_members': { question: 'Кто в команде?', criteria: 'Перечислены участники и их роли в проекте.', example: 'В команде 3 человека: Иван Иванов (разработка).' },
      },
    });
    const user = userEvent.setup();
    renderAt('/passport?block=2');
    const team = screen.getByRole('heading', { level: 3, name: 'Состав команды' }).closest('article')!;
    await user.click(within(team).getByRole('button', { name: 'Править' }));
    expect(within(team).getByText('Что проверяет фонд:').parentElement).toHaveTextContent('Перечислены участники и их роли в проекте.');
    const summary = within(team).getByText('Как обычно пишут');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    await user.click(summary);
    expect(details).toHaveAttribute('open');
    expect(within(details).getByText('В команде 3 человека: Иван Иванов (разработка).')).toBeVisible();
  });

  it('поле с замечанием и заполненное поле — тоже быстрое сохранение', async () => {
    mocks.call.mockResolvedValue({ status: 'SAVED', pending_review: [] });
    const user = userEvent.setup();
    renderAt('/passport?block=6');
    const needs = screen.getByRole('heading', { level: 3, name: 'Гипотеза отличия' }).closest('article')!;
    await user.click(within(needs).getByRole('button', { name: 'Править' }));
    await user.click(within(needs).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({ action: 'save_draft', form: [{ section_id: 6, field_key: 'novelty_hypothesis', value: 'Быстрее аналогов' }] }),
    );

    await user.click(screen.getByRole('button', { name: /Продукт/ }));
    const product = screen.getByRole('heading', { level: 3, name: 'Кратко о продукте' }).closest('article')!;
    await user.click(within(product).getByRole('button', { name: 'Править' }));
    await user.click(within(product).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({ action: 'save_draft', form: [{ section_id: 4, field_key: 'product_summary', value: 'Сервис для бухгалтерии' }] }),
    );
  });

  it('поле с анкетой открывается анкетой, даже если текст написан словами', async () => {
    const user = userEvent.setup();
    renderAt('/passport?block=2');
    const team = screen.getByRole('heading', { level: 3, name: 'Состав команды' }).closest('article')!;
    await user.click(within(team).getByRole('button', { name: 'Править' }));
    expect(within(team).getByRole('textbox', { name: 'ФИО, строка 1' })).toBeInTheDocument();
    expect(within(team).queryByRole('button', { name: 'Написать текстом' })).not.toBeInTheDocument();
  });

  it('сохранённая, но не проверенная правка помечена «Не проверено»', () => {
    mocks.state = cabinet(PASSPORT, { pending_review: ['2/team_members'] });
    renderAt('/passport?block=2');
    const team = screen.getByRole('heading', { level: 3, name: 'Состав команды' }).closest('article')!;
    expect(within(team).getByText('Не проверено')).toBeInTheDocument();
  });

  it('в правом верхнем углу — «Проверить» вместо «Итог проверки»: модель по всем правкам разом', async () => {
    const after = cabinet(PASSPORT, {
      block_audits: [{ section_id: 3, status: 'needs_review', remark: 'Мало.', how_to_fix: null, failed_fields: [] }, { section_id: 6, status: 'needs_review', remark: 'Мало.', how_to_fix: null, failed_fields: [] }],
      budget_audit: { status: 'approved', remark: null, how_to_fix: null, violations: [] },
    });
    mocks.refresh.mockResolvedValueOnce(after as never);
    mocks.call.mockResolvedValue({ status: 'NEED_USER_INPUT', step: 'GAP_FILLING', question: 'Пропущено пробелов: 2.', example: '', rejection_reason: null });
    window.sessionStorage.setItem('buha.flow', JSON.stringify({ last: QUESTION }));
    const user = userEvent.setup();
    renderAt('/passport?block=2');
    expect(screen.queryByRole('link', { name: 'Итог проверки' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Проверить' }));
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith({ action: 'review_edits' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Проверка завершена. Замечания аудита: блоки 3, 6.');
    expect(screen.getByRole('link', { name: 'Итог проверки' })).toHaveAttribute('href', '/result');
  });

  it('«Проверить» с ошибкой (нет кредитов) — сообщение, без итога', async () => {
    mocks.call.mockResolvedValue({ status: 'ERROR', code: 'AI_CREDITS_EXHAUSTED', message: 'ИИ-кредиты закончились.' });
    window.sessionStorage.setItem('buha.flow', JSON.stringify({ last: QUESTION }));
    const user = userEvent.setup();
    renderAt('/passport?block=2');
    await user.click(screen.getByRole('button', { name: 'Проверить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ИИ-кредиты закончились.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('замечание аудита блока — над полями блока', () => {
    mocks.state = cabinet(PASSPORT, {
      block_audits: [{ section_id: 6, status: 'needs_review', remark: 'Один аналог — мало.', how_to_fix: 'Добавьте второй.', failed_fields: ['analogues_comparison'] }],
    });
    renderAt('/passport?block=6');
    expect(screen.getByText('Один аналог — мало. Добавьте второй.')).toBeInTheDocument();
  });

  it('легенда — три подчёркивания: «С ваших слов», «Дописано ИИ», «Заполнить»', () => {
    renderAt('/passport?block=6');
    const legend = screen.getByRole('list', { name: 'Обозначения' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['С ваших слов', 'Дописано ИИ', 'Заполнить']);
  });

  it('текст поля подчёркнут по происхождению; в панели утверждения — чьи это слова', async () => {
    const user = userEvent.setup();
    const own = 'Провели две фокус-группы.';
    const added = 'Сервис монетизируется подпиской.';
    const claim = (text: string, start: number, origin: 'user' | 'ai'): PipelinePassportField['claims'][number] => ({
      claim_text: text,
      claim_type: 'client_statement',
      claim_kind: 'sentence',
      source_id: null,
      source_locator: null,
      span_start: start,
      span_end: start + text.length,
      order_index: 1,
      verification_status: 'unverified',
      origin,
    });
    const value = `${own} ${added}`;
    mocks.state = cabinet([{ ...field(2, 'team_members', value), claims: [claim(own, 0, 'user'), claim(added, own.length + 1, 'ai')] }]);
    renderAt('/passport?block=2');
    expect(screen.getByText(own)).toHaveClass('passport-claim--user');
    expect(screen.getByText(added)).toHaveClass('passport-claim--ai');
    await user.click(screen.getByText(added));
    expect(within(screen.getByRole('complementary', { name: 'Утверждение' })).getByText('Дописано ИИ')).toBeInTheDocument();
    await user.click(screen.getByText(own));
    expect(within(screen.getByRole('complementary', { name: 'Утверждение' })).getByText('Слова пользователя')).toBeInTheDocument();
  });

  it('пустое обязательное поле подчёркнуто как «Заполнить», необязательное — нет', () => {
    renderAt('/passport?block=6');
    expect(screen.getByText('Пока не заполнено.')).toHaveClass('passport__to-fill');
    cleanup();
    renderAt('/passport?block=4');
    expect(screen.getByText('Необязательное поле.')).not.toHaveClass('passport__to-fill');
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
  it('анкета в блоке: пустая команда заполняется таблицей, сохраняется вместе с формой', async () => {
    mocks.state = cabinet([field(2, 'team_members', null), field(2, 'competencies_and_experience', null)]);
    const user = userEvent.setup();
    renderAt('/passport?block=2');
    const card = screen.getByRole('heading', { level: 3, name: 'Состав команды' }).closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    await user.type(within(card).getByRole('textbox', { name: 'ФИО, строка 1' }), 'Иван Иванов');
    await user.type(within(card).getByRole('textbox', { name: 'Роль в проекте, строка 1' }), 'разработка');
    await user.click(within(card).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith({
        action: 'save_draft',
        form: [{ section_id: 2, field_key: 'team_members', value: 'В команде 1 человек: Иван Иванов (разработка).' }],
        field_form: {
          section_id: 2,
          field_key: 'team_members',
          data: { choice: '', flags: [], inputs: {}, rows: [{ name: 'Иван Иванов', role: 'разработка' }], text: '' },
        },
      }),
    );
  });

  it('опыт команды подхватывает участников из сохранённой анкеты команды', async () => {
    mocks.state = cabinet([
      { ...field(2, 'team_members', 'Команда: Иван Иванов'), form_data: { rows: [{ name: 'Иван Иванов', role: 'код' }] } },
      field(2, 'competencies_and_experience', null),
    ]);
    const user = userEvent.setup();
    renderAt('/passport?block=2');
    const card = screen.getByRole('heading', { level: 3, name: 'Компетенции и опыт команды' }).closest('article')!;
    await user.click(within(card).getByRole('button', { name: 'Заполнить' }));
    expect(within(card).getByRole('textbox', { name: 'Участник, строка 1' })).toHaveValue('Иван Иванов');
  });
});
