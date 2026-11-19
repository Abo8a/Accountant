import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Brief } from './Brief';

function renderBrief() {
  return render(
    <MemoryRouter initialEntries={['/brief']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/brief" element={<Brief />} />
        <Route path="/onboarding" element={<h1>Расскажите о себе</h1>} />
        <Route path="/generating" element={<h1>Буха читает материалы</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

const QUESTION_LABELS = [
  /1\. Какую проблему решает проект и для кого\?/,
  /2\. Что делает продукт\?/,
  /3\. Что уже сделано, а что в планах\?/,
  /4\. Кто в команде и чем занимается\?/,
];

describe('Brief', () => {
  it('рендерит заголовок экрана из дизайна', () => {
    renderBrief();
    expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
  });

  it('ветка «есть файлы?»: зона загрузки и ответ «У меня нет файлов» видны сразу', () => {
    renderBrief();
    expect(screen.getByRole('button', { name: /Перетащите файлы сюда/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'У меня нет файлов' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Файлов пока нет?' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Назад' })).toHaveAttribute('href', '/onboarding');
  });

  it('переключатель прототипа: по умолчанию «Пакет ИИ»', () => {
    renderBrief();
    expect(screen.getByRole('button', { name: 'Пакет ИИ' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Бесплатный' })).toHaveAttribute('aria-pressed', 'false');
  });

  describe('ветка «файлы»', () => {
    it('после загрузки показывает список файлов, счётчик и кнопку сборки по файлам', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: /Перетащите файлы сюда/ }));

      expect(screen.getByRole('heading', { level: 1, name: 'Материалы загружены' })).toBeInTheDocument();
      expect(screen.getByText('Monetrix_presentation_02.11.pdf')).toBeInTheDocument();
      expect(screen.getByText('Svidetelstvo_RID_scan.pdf')).toBeInTheDocument();
      expect(screen.getByText('Monetrix_presentation_02.11 (1).pdf')).toBeInTheDocument();
      expect(screen.getByText('Текст распознан')).toBeInTheDocument();
      expect(screen.getByText('Распознаём скан')).toBeInTheDocument();
      expect(screen.getByText('Этот файл уже загружен — повторно не разбираем и в лимит не считаем')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Добавить ещё файл/ })).toHaveTextContent('· использовано 2 из 10');
      expect(screen.getByRole('button', { name: 'Собрать паспорт по файлам' })).toBeInTheDocument();
      expect(screen.queryByText('Расскажите о проекте')).not.toBeInTheDocument();
    });

    it('«Убрать» у дубликата не меняет счётчик; «Удалить файл» уменьшает его', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: /Перетащите файлы сюда/ }));

      await user.click(screen.getByRole('button', { name: 'Убрать' }));
      expect(screen.queryByText('Monetrix_presentation_02.11 (1).pdf')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Добавить ещё файл/ })).toHaveTextContent('· использовано 2 из 10');

      await user.click(screen.getAllByRole('button', { name: 'Удалить файл' })[0]);
      expect(screen.queryByText('Monetrix_presentation_02.11.pdf')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Добавить ещё файл/ })).toHaveTextContent('· использовано 1 из 10');
    });

    it('«Собрать паспорт по файлам» ведёт на генерацию', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: /Перетащите файлы сюда/ }));
      await user.click(screen.getByRole('button', { name: 'Собрать паспорт по файлам' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Буха читает материалы' })).toBeInTheDocument();
    });

    it('«Назад» из файлов возвращает к вопросу «Есть материалы»', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: /Перетащите файлы сюда/ }));
      await user.click(screen.getByRole('button', { name: 'Назад' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    });
  });

  describe('ветка «анкета»', () => {
    it('«У меня нет файлов» открывает четыре вопроса и свободное поле', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));

      expect(screen.getByRole('heading', { level: 1, name: 'Расскажите о проекте' })).toBeInTheDocument();
      for (const label of QUESTION_LABELS) {
        expect(screen.getByLabelText(label)).toBeRequired();
      }
      expect(screen.getByLabelText('Что ещё важно знать о проекте?')).not.toBeRequired();
      expect(screen.getAllByText('Как обычно отвечают')).toHaveLength(4);
      expect(screen.getByRole('button', { name: 'Собрать паспорт' })).toBeInTheDocument();
      expect(screen.getByText(/обязательные вопросы/)).toBeInTheDocument();
    });

    it('«Нашлись файлы? Загрузить» возвращает к ветке файлов', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));
      await user.click(screen.getByRole('button', { name: 'Нашлись файлы? Загрузить' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    });

    it('без ответов на обязательные вопросы сборка не запускается', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));
      await user.click(screen.getByRole('button', { name: 'Собрать паспорт' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Расскажите о проекте' })).toBeInTheDocument();
      expect(screen.getByLabelText(QUESTION_LABELS[0])).toBeInvalid();
    });

    it('с ответами на все четыре вопроса «Собрать паспорт» ведёт на генерацию', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));
      for (const label of QUESTION_LABELS) {
        await user.type(screen.getByLabelText(label), 'Ответ');
      }
      await user.click(screen.getByRole('button', { name: 'Собрать паспорт' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Буха читает материалы' })).toBeInTheDocument();
    });

    it('«Назад» из анкеты возвращает к вопросу «Есть материалы»', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));
      await user.click(screen.getByRole('button', { name: 'Назад' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    });
  });

  describe('бесплатный тариф', () => {
    it('загрузка открыта: зона загрузки с лимитом 5 файлов, пейволла нет, анкета доступна', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'Бесплатный' }));

      expect(screen.getByRole('button', { name: 'Бесплатный' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: /Перетащите файлы сюда/ })).toHaveTextContent('PDF, DOCX, PPTX, сканы — до 5 файлов');
      expect(screen.queryByRole('heading', { level: 2, name: 'Разбор документов — на тарифе «Профессиональный»' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Подключить за 990 ₽' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'У меня нет файлов' })).toBeInTheDocument();
    });

    it('на «Пакете ИИ» в подсказке зоны загрузки — до 10 файлов', () => {
      renderBrief();
      expect(screen.getByRole('button', { name: /Перетащите файлы сюда/ })).toHaveTextContent('PDF, DOCX, PPTX, сканы — до 10 файлов');
    });

    it('ветка «файлы»: счётчик считает от лимита 5', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'Бесплатный' }));
      await user.click(screen.getByRole('button', { name: /Перетащите файлы сюда/ }));
      expect(screen.getByRole('heading', { level: 1, name: 'Материалы загружены' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Добавить ещё файл/ })).toHaveTextContent('· использовано 2 из 5');
    });

    it('в анкете на Базовом есть ссылка «Нашлись файлы? Загрузить» и она возвращает к загрузке', async () => {
      const user = userEvent.setup();
      renderBrief();
      await user.click(screen.getByRole('button', { name: 'Бесплатный' }));
      await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));
      await user.click(screen.getByRole('button', { name: 'Нашлись файлы? Загрузить' }));
      expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    });
  });
});
