import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CabinetState } from '../../shared/api/cabinet';

const cabinet = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock('../../shared/state/cabinet', () => ({ useCabinetState: () => cabinet.state, refreshCabinetState: vi.fn() }));

import { Files, LiveFiles } from './Files';
import type { FilesApi, ProjectFile, UploadCompletion } from './Files.model';

const DECK: ProjectFile = {
  id: 1, name: 'Deck.pdf', ext: 'PDF', kind: 'pdf', pages: '15 страниц', mb: 4.2, date: '02.11.2026', claims: 18, st: 'ok', sha256: 'h1', remoteId: 'r1',
};

function liveApi(overrides: Partial<FilesApi> = {}): FilesApi {
  return {
    live: true,
    upload: vi.fn(async () => ({ status: 'accepted' as const })),
    remove: vi.fn(async () => true),
    downloadUrl: (f) => (f.remoteId ? `/pipeline/files/${f.remoteId}` : null),
    ...overrides,
  };
}

function renderLive(api: FilesApi, initialFiles: ProjectFile[] = [DECK], plan: 'free' | 'pro' = 'free') {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Files api={api} plan={plan} initialFiles={initialFiles} />
    </MemoryRouter>,
  );
}

const pick = () => screen.getByLabelText('Файлы для загрузки') as HTMLInputElement;
const rows = () => screen.queryAllByRole('row').filter((r) => r.className.includes('files__row--item'));
const rowOf = (name: string) => rows().find((r) => within(r).queryByText(name))!;
const pdf = (name: string) => new File(['%PDF-1.4 ' + name], name, { type: 'application/pdf' });

/** Загрузка, разбор которой завершается тогда, когда тест решит. */
function deferredUpload() {
  let finish!: (c: UploadCompletion) => void;
  const completion = new Promise<UploadCompletion>((resolve) => (finish = resolve));
  const api = liveApi({ upload: vi.fn(async () => ({ status: 'accepted' as const, completion })) });
  return { api, finish };
}

afterEach(() => {
  cabinet.state = undefined;
  vi.restoreAllMocks();
});

describe('Files в живом режиме: фоновый разбор', () => {
  it('пока пайплайн разбирает файл, строка «Разбираем…», скачать и удалить нельзя; по окончании — число утверждений', async () => {
    const user = userEvent.setup();
    const { api, finish } = deferredUpload();
    renderLive(api);

    await user.upload(pick(), pdf('Plan.pdf'));
    const row = await waitFor(() => {
      const r = rowOf('Plan.pdf');
      expect(r).toBeTruthy();
      return r;
    });
    expect(within(row).getByText('Разбираем…')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Скачать файл' })).toBeDisabled();
    expect(within(row).getByRole('button', { name: 'Удалить файл' })).toBeDisabled();
    expect(within(rowOf('Deck.pdf')).getByRole('button', { name: 'Удалить файл' })).toBeEnabled();

    await act(async () => finish({ outcome: 'done', remoteId: 'r2', claims: 5, pages: '3 страницы' }));

    expect(within(rowOf('Plan.pdf')).getByText('5 утверждений')).toBeInTheDocument();
    expect(within(rowOf('Plan.pdf')).getByText(/3 страницы/)).toBeInTheDocument();
    expect(within(rowOf('Plan.pdf')).getByRole('button', { name: 'Удалить файл' })).toBeEnabled();
  });

  it('разбор не удался: строка исчезает, в тосте текст сервера', async () => {
    const user = userEvent.setup();
    const { api, finish } = deferredUpload();
    renderLive(api);
    await user.upload(pick(), pdf('Plan.pdf'));
    await waitFor(() => expect(rowOf('Plan.pdf')).toBeTruthy());

    await act(async () => finish({ outcome: 'error', message: 'Идёт обработка' }));

    expect(screen.queryByText('Plan.pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Идёт обработка');
    expect(screen.getByText('из 5')).toBeInTheDocument();
  });

  it('материалы другого проекта: строка исчезает, показана карточка и тост про один аккаунт — один проект', async () => {
    const user = userEvent.setup();
    const { api, finish } = deferredUpload();
    renderLive(api);
    await user.upload(pick(), pdf('Recipe.pdf'));
    await waitFor(() => expect(rowOf('Recipe.pdf')).toBeTruthy());

    await act(async () => finish({ outcome: 'BLOCKED_PROJECT_SWAP' }));

    expect(screen.queryByText('Recipe.pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('alert', { name: 'Похоже, это материалы другого проекта' })).toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Файл «Recipe.pdf» не совпадает по смыслу с описанием вашего проекта.');
    expect(status).toHaveTextContent('Один аккаунт — один проект');
    expect(status).not.toHaveTextContent('Monetrix');
  });

  it('сервер отказал (формат, размер): строки нет, в тосте его текст', async () => {
    const user = userEvent.setup();
    const message = 'Загрузите файл в формате PDF, DOCX или PPTX. Скан передайте одним PDF.';
    renderLive(liveApi({ upload: vi.fn(async () => ({ status: 'rejected' as const, message })) }));
    await user.upload(pick(), pdf('Scan.pdf'));
    expect(await screen.findByRole('status')).toHaveTextContent(message);
    expect(screen.queryByText('Scan.pdf')).not.toBeInTheDocument();
  });

  it('в выборе файла только форматы, которые понимает парсер', () => {
    renderLive(liveApi());
    expect(pick()).toHaveAttribute('accept', '.pdf,.docx,.pptx');
  });
});

describe('Files в живом режиме: удаление, скачивание, просмотр', () => {
  it('удаление ждёт ответа сервера: после «Удалить файл» строка исчезает и показано предупреждение об утверждениях', async () => {
    const user = userEvent.setup();
    const api = liveApi();
    renderLive(api);
    await user.click(within(rowOf('Deck.pdf')).getByRole('button', { name: 'Удалить файл' }));
    await user.click(within(screen.getByRole('alertdialog', { name: 'Удаление файла' })).getByRole('button', { name: 'Удалить файл' }));

    expect(api.remove).toHaveBeenCalledWith(expect.objectContaining({ remoteId: 'r1' }));
    await waitFor(() => expect(screen.queryByText('Deck.pdf')).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('Файл удалён. 18 утверждений остались без источника.');
  });

  it('сервер не удалил файл: строка остаётся, показано «Не получилось, повторить»', async () => {
    const user = userEvent.setup();
    renderLive(liveApi({ remove: vi.fn(async () => false) }));
    await user.click(within(rowOf('Deck.pdf')).getByRole('button', { name: 'Удалить файл' }));
    await user.click(within(screen.getByRole('alertdialog', { name: 'Удаление файла' })).getByRole('button', { name: 'Удалить файл' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Не получилось, повторить');
    expect(screen.getByText('Deck.pdf')).toBeInTheDocument();
  });

  it('«Скачать файл» открывает настоящую ссылку на файл, а не показывает пример «Скачивание началось»', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
    try {
      renderLive(liveApi());
      await user.click(within(rowOf('Deck.pdf')).getByRole('button', { name: 'Скачать файл' }));
      expect(assign).toHaveBeenCalledWith('/pipeline/files/r1');
      expect(screen.queryByText('Скачивание началось.')).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('просмотр файла: без примера страницы из макета («Страница 4 из 15»)', async () => {
    const user = userEvent.setup();
    renderLive(liveApi());
    await user.click(within(rowOf('Deck.pdf')).getByRole('button', { name: 'Открыть' }));
    const drawer = screen.getByRole('dialog', { name: 'Просмотр файла' });
    expect(within(drawer).getByText('Буха нашла 18 утверждений')).toBeInTheDocument();
    expect(within(drawer).queryByText('Страница 4 из 15')).not.toBeInTheDocument();
    expect(within(drawer).queryByText('Подтверждённый факт со стр. 4')).not.toBeInTheDocument();
  });
});

describe('LiveFiles: материалы пользователя с сервера', () => {
  const state = (patch: Partial<CabinetState> = {}) =>
    ({
      plan_id: 'free',
      plan_expires_at: null,
      files_used: 2,
      files_limit: 5,
      founder: {},
      study_certificate: null,
      files: [
        { id: 'a', file_name: 'Pitch.pdf', sha256_hash: 'x'.repeat(64), uploaded_at: '2026-11-05T10:00:00.000Z', size_bytes: 1_048_576, total_pages: 12, claims: 7 },
        { id: 'b', file_name: 'Plan.docx', sha256_hash: 'y'.repeat(64), uploaded_at: '2026-11-06T10:00:00.000Z', size_bytes: 2_097_152, total_pages: 3, claims: 0 },
      ],
      project_status: 'draft',
      passport: [],
      block_audits: [],
      budget_audit: null,
      result: null,
      ...patch,
    }) as CabinetState;
  const renderLiveFiles = () =>
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <LiveFiles />
      </MemoryRouter>,
    );

  it('«Базовый» с двумя файлами: список с сервера, «из 5», зона загрузки на месте, заглушки «скоро появится» нет', () => {
    cabinet.state = state();
    renderLiveFiles();
    expect(screen.getByText('Pitch.pdf')).toBeInTheDocument();
    expect(screen.getByText('Plan.docx')).toBeInTheDocument();
    expect(screen.getByText('7 утверждений')).toBeInTheDocument();
    expect(screen.getByText('12 страниц · 1,0 МБ')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Использовано файлов' })).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByText('из 5')).toBeInTheDocument();
    expect(screen.getByText('Тариф «Базовый»')).toBeInTheDocument();
    expect(screen.getByText('Перетащите файлы сюда или', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добавить файлы' })).toBeInTheDocument();
    expect(screen.queryByText(/скоро появится/)).not.toBeInTheDocument();
  });

  it('проект без материалов: пустой список и «0 из 5»', () => {
    cabinet.state = state({ files: [], files_used: 0 });
    renderLiveFiles();
    expect(rows()).toHaveLength(0);
    expect(screen.getByRole('progressbar', { name: 'Использовано файлов' })).toHaveAttribute('aria-valuenow', '0');
  });

  it('состояние ещё грузится или недоступно — экран пуст', () => {
    cabinet.state = undefined;
    const { container } = renderLiveFiles();
    expect(container).toBeEmptyDOMElement();
  });
});
