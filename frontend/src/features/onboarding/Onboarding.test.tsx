import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Onboarding } from './Onboarding';

function renderOnboarding() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/brief" element={<h1>Есть материалы о проекте?</h1>} />
        <Route path="/support" element={<h1>Написать в поддержку</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

// Заполняет обязательные поля, которых нет в предзаполнении эталона.
async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/^Телефон/), '+7 900 000-00-00');
  await user.type(screen.getByLabelText(/^Вуз/), 'МГУ');
  await user.selectOptions(screen.getByLabelText(/^Уровень/), 'Бакалавриат');
  await user.selectOptions(screen.getByLabelText(/^Курс/), '1');
  await user.selectOptions(screen.getByLabelText(/^Регион/), 'Москва');
}

const QUESTIONS = [
  'Вы являетесь студентом или аспирантом?',
  'Есть ли у вас открытые договоры или заявки в Фонде содействия инновациям (ФСИ)?',
  'Получали ли вы ранее грант «Студенческий стартап»?',
  'Готовы ли вы открыть новое ООО после победы в конкурсе?',
];
// Ответы, при которых проходит допуск: студент, нет открытых заявок, гранта не было, готов открыть ООО.
const PASS = ['Да', 'Нет', 'Нет', 'Да'];

async function answerEligibility(user: ReturnType<typeof userEvent.setup>, answers = PASS) {
  for (const [index, question] of QUESTIONS.entries()) {
    await user.click(within(screen.getByRole('group', { name: question })).getByRole('button', { name: answers[index] }));
  }
}

describe('Onboarding', () => {
  it('рендерит заголовок экрана из дизайна', () => {
    renderOnboarding();
    expect(screen.getByRole('heading', { level: 1, name: 'Расскажите о себе' })).toBeInTheDocument();
  });

  it('рендерит ключевые тексты эталона', () => {
    renderOnboarding();
    expect(screen.getByText('Блок 1 паспорта')).toBeInTheDocument();
    expect(screen.getByText('Программа поддержки')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Один аккаунт — один проект' })).toBeInTheDocument();
    expect(screen.getByText('После создания проекта ФИО можно изменить только через поддержку.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Продолжить' })).toBeInTheDocument();
  });

  it('предзаполняет ФИО значениями эталона', () => {
    renderOnboarding();
    expect(screen.getByLabelText(/^Фамилия/)).toHaveValue('Иванов');
    expect(screen.getByLabelText(/^Имя/)).toHaveValue('Иван');
    expect(screen.getByLabelText(/^Отчество/)).toHaveValue('Иванович');
  });

  it('программа «Студенческий стартап» выбрана, остальные отключены', () => {
    renderOnboarding();
    expect(screen.getByRole('button', { name: /Студенческий стартап/ })).toHaveAttribute('aria-pressed', 'true');
    const start1 = screen.getByText('Старт-1').closest('[aria-disabled]');
    expect(start1).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Сколково').closest('[aria-disabled]')).toHaveAttribute('aria-disabled', 'true');
  });

  it('«Понятно» отмечено по умолчанию', () => {
    renderOnboarding();
    expect(screen.getByRole('checkbox', { name: 'Понятно' })).toBeChecked();
  });

  describe('сценарии полей', () => {
    it('«Нет отчества» отключает поле и очищает значение; повторный клик возвращает его', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      const toggle = screen.getByRole('checkbox', { name: 'Нет отчества' });
      expect(toggle).toHaveAttribute('aria-checked', 'false');

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-checked', 'true');
      const middle = screen.getByLabelText('Отчество');
      expect(middle).toBeDisabled();
      expect(middle).toHaveAttribute('placeholder', 'Не указывается');
      expect(middle).toHaveValue('');
      expect(middle).not.toBeRequired();

      await user.click(toggle);
      expect(screen.getByLabelText(/^Отчество/)).toHaveValue('Иванович');
      expect(screen.getByLabelText(/^Отчество/)).toBeRequired();
    });

    it('«Учусь в настоящее время» показывает панель вуза; снятие отметки прячет её и показывает предупреждение', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      expect(screen.getByLabelText(/^Вуз/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Уровень/)).toBeInTheDocument();
      expect(screen.getByLabelText(/^Курс/)).toBeInTheDocument();

      await user.click(screen.getByRole('checkbox', { name: 'Учусь в настоящее время' }));
      expect(screen.queryByLabelText(/^Вуз/)).not.toBeInTheDocument();
      const status = screen.getByRole('status');
      expect(within(status).getByText('Участвовать в «Студенческом стартапе» могут только студенты и аспиранты.')).toBeInTheDocument();
    });

    it('уровень и курс — обязательные списки с пустым значением по умолчанию', () => {
      renderOnboarding();
      expect(screen.getByLabelText(/^Уровень/)).toHaveValue('');
      expect(screen.getByLabelText(/^Курс/)).toHaveValue('');
      expect(screen.getByLabelText(/^Регион/)).toHaveValue('');
    });
  });

  describe('валидация и переход', () => {
    it('без обязательных полей («Телефон», вуз, уровень, курс, регион) переход на бриф не происходит', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      await answerEligibility(user);
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Расскажите о себе' })).toBeInTheDocument();
      expect(screen.getByLabelText(/^Телефон/)).toBeInvalid();
    });

    it('частично заполненная форма тоже не уходит дальше', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      await user.type(screen.getByLabelText(/^Телефон/), '+7 900 000-00-00');
      await answerEligibility(user);
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Расскажите о себе' })).toBeInTheDocument();
      expect(screen.getByLabelText(/^Регион/)).toBeInvalid();
    });

    it('с заполненными обязательными полями «Продолжить» ведёт на бриф', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      await fillRequired(user);
      await answerEligibility(user);
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    });

    it('вне учёбы вуз не нужен: предупреждение не блокирует переход', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      await user.click(screen.getByRole('checkbox', { name: 'Учусь в настоящее время' }));
      await user.type(screen.getByLabelText(/^Телефон/), '+7 900 000-00-00');
      await user.selectOptions(screen.getByLabelText(/^Регион/), 'Москва');
      await answerEligibility(user);
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    });
  });

  describe('условия участия (анкета допуска)', () => {
    it('четыре вопроса с подсказками и ответами «Да / Нет»', () => {
      renderOnboarding();
      expect(screen.getByRole('heading', { level: 2, name: 'Условия участия' })).toBeInTheDocument();
      for (const question of QUESTIONS) {
        const group = screen.getByRole('group', { name: question });
        expect(within(group).getByRole('button', { name: 'Да' })).toHaveAttribute('aria-pressed', 'false');
        expect(within(group).getByRole('button', { name: 'Нет' })).toHaveAttribute('aria-pressed', 'false');
      }
      expect(screen.getByText('Это обязательное условие участия в конкурсе: грант получает новое ООО, зарегистрированное после победы.')).toBeInTheDocument();
    });

    it('пока не отвечены все вопросы, «Продолжить» неактивна и показан счётчик', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      expect(screen.getByText('Условия участия: 0 из 4')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Продолжить' })).toBeDisabled();
      await user.click(within(screen.getByRole('group', { name: QUESTIONS[0] })).getByRole('button', { name: 'Да' }));
      expect(screen.getByText('Условия участия: 1 из 4')).toBeInTheDocument();
      await answerEligibility(user);
      expect(screen.queryByText(/Условия участия: \d из 4/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Продолжить' })).toBeEnabled();
    });

    it('неподходящий ответ ведёт к окончательному отказу с причиной и ссылкой в поддержку', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      await fillRequired(user);
      await answerEligibility(user, ['Да', 'Да', 'Нет', 'Да']);
      await user.click(screen.getByRole('button', { name: 'Продолжить' }));
      const alert = screen.getByRole('alert');
      expect(within(alert).getByRole('heading', { level: 2, name: 'Проект не проходит проверку допуска' })).toBeInTheDocument();
      expect(within(alert).getByText('Есть открытые договоры или заявки в ФСИ.')).toBeInTheDocument();
      expect(within(alert).getByText('Участие возможно только при отсутствии открытых договоров и заявок в Фонде.')).toBeInTheDocument();
      expect(within(alert).getByRole('link', { name: 'Написать в поддержку' })).toHaveAttribute('href', '/support');
      expect(within(alert).getByRole('link', { name: 'На главную' })).toHaveAttribute('href', '/');
    });

    it('переключатель прототипа показывает отказ и возвращает форму с ответами для допуска', async () => {
      const user = userEvent.setup();
      renderOnboarding();
      const proto = screen.getByRole('group', { name: 'Вариант для прототипа' });
      await user.click(within(proto).getByRole('button', { name: 'Отказ' }));
      expect(screen.getByRole('heading', { level: 2, name: 'Проект не проходит проверку допуска' })).toBeInTheDocument();
      await user.click(within(screen.getByRole('group', { name: 'Вариант для прототипа' })).getByRole('button', { name: 'Допуск' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(within(screen.getByRole('group', { name: QUESTIONS[0] })).getByRole('button', { name: 'Да' })).toHaveAttribute('aria-pressed', 'true');
    });
  });
});
