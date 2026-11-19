import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Passport } from './Passport';
import { Result } from './Result';

// DOCX скачивается на любом этапе: незаполненные поля в файле остаются пустыми. PDF-выгрузки пока нет.
const NOT_READY_NOTE = 'Скачать можно уже сейчас: незаполненные поля в файле останутся пустыми. Перед подачей закройте пункты списка «Что сделать перед подачей».';

describe('Скачивание паспорта', () => {
  it('экран паспорта: DOCX доступен до одобрения, подсказка про пустые поля; PDF пока недоступен', () => {
    render(
      <MemoryRouter>
        <Passport />
      </MemoryRouter>,
    );
    const docx = screen.getByRole('button', { name: 'DOCX' });
    expect(docx).toBeEnabled();
    expect(docx).toHaveAttribute('title', 'Паспорт ещё не одобрен целиком: незаполненные поля в файле останутся пустыми');
    expect(screen.getByRole('button', { name: 'PDF' })).toBeDisabled();
  });

  it('экран паспорта: после одобрения всех блоков DOCX без подсказки', () => {
    render(
      <MemoryRouter>
        <Passport exportReady />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'DOCX' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'DOCX' })).not.toHaveAttribute('title');
  });

  it('итог проверки: «Скачать DOCX» доступен до одобрения, пояснение про пустые поля; PDF пока недоступен', () => {
    render(
      <MemoryRouter>
        <Result />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Скачать DOCX' })).toBeEnabled();
    expect(screen.getByText(NOT_READY_NOTE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Скачать PDF' })).toBeDisabled();
  });

  it('итог проверки: при готовности кнопка активна и пояснения нет', () => {
    render(
      <MemoryRouter>
        <Result exportReady />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Скачать DOCX' })).toBeEnabled();
    expect(screen.queryByText(NOT_READY_NOTE)).not.toBeInTheDocument();
  });
});
