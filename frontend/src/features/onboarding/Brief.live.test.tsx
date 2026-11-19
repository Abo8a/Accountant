// Бриф в живом режиме (VITE_PIPELINE_URL задан): файлы уходят на сервер, сборку по ним запускает экран сборки.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredFile } from '../../shared/api/files';

vi.mock('../../shared/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/config/env')>();
  return { env: { ...actual.env, liveApi: true, pipelineUrl: '/pipeline' } };
});
vi.mock('../consultant/ConsultantWidget', () => ({ ConsultantWidget: () => null }));
const cabinet = vi.hoisted(() => ({ state: { files_limit: 5 } as { files_limit: number } | undefined }));
vi.mock('../../shared/state/cabinet', () => ({ useCabinetState: () => cabinet.state, refreshCabinetState: vi.fn() }));
const store = vi.fn();
vi.mock('../../shared/api/files', () => ({ storeProjectFile: (...a: unknown[]) => store(...a) }));

import { loadFlow, saveFlow } from '../../shared/state/flow';
import { Brief } from './Brief';

const stored = (name: string, sha: string, size = 1_048_576): StoredFile => ({
  file_name: name,
  file_url: `file:///data/uploads/u/${sha}.pdf`,
  sha256_hash: sha.repeat(64).slice(0, 64),
  size_bytes: size,
});
const storedOk = (name: string, sha: string, size?: number) => ({ status: 'stored' as const, file: stored(name, sha, size) });

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

const pdf = (name: string) => new File(['%PDF-1.4 ' + name], name, { type: 'application/pdf' });
const picker = () => screen.getByLabelText('Файлы для загрузки') as HTMLInputElement;
const addCounter = () => screen.getByRole('button', { name: /Добавить ещё файл/ });

beforeEach(() => {
  window.sessionStorage.clear();
  store.mockReset();
  cabinet.state = { files_limit: 5 };
});
afterEach(() => window.sessionStorage.clear());

describe('Brief (живой режим): вопрос «Есть материалы о проекте?»', () => {
  it('открывается на вопросе о материалах, а не сразу на анкете; в подсказке лимит из тарифа пользователя', () => {
    renderBrief();
    expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Перетащите файлы сюда/ })).toHaveTextContent('PDF, DOCX, PPTX, сканы — до 5 файлов');
    expect(screen.getByRole('button', { name: 'У меня нет файлов' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Тариф для прототипа' })).not.toBeInTheDocument();
    expect(picker()).toHaveAttribute('accept', '.pdf,.docx,.pptx');
  });

  it('лимит в подсказке берётся с сервера: 10 файлов — «до 10 файлов»', () => {
    cabinet.state = { files_limit: 10 };
    renderBrief();
    expect(screen.getByRole('button', { name: /Перетащите файлы сюда/ })).toHaveTextContent('до 10 файлов');
  });

  it('после отказа по стоп-фактору открывается анкета с причиной отказа', () => {
    saveFlow({ briefRefusal: [{ reason: 'Двойное назначение', how_to_fix: 'Уберите военное применение' }] });
    renderBrief();
    expect(screen.getByRole('heading', { level: 1, name: 'Расскажите о проекте' })).toBeInTheDocument();
    expect(screen.getByText('Двойное назначение')).toBeInTheDocument();
  });

  it('с начатой анкетой открывается анкета, ответы на месте', () => {
    saveFlow({ briefDraft: { q1: 'Мой ответ' } });
    renderBrief();
    expect(screen.getByLabelText(/1\. Какую проблему/)).toHaveValue('Мой ответ');
  });

  it('«Нашлись файлы? Загрузить» из анкеты ведёт к загрузке', async () => {
    const user = userEvent.setup();
    renderBrief();
    await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));
    await user.click(screen.getByRole('button', { name: 'Нашлись файлы? Загрузить' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
  });
});

describe('Brief (живой режим): загрузка файлов', () => {
  it('файлы сохраняются на сервере, затем показан список с размером и счётчиком; «распознан» не пишем — разбор ещё впереди', async () => {
    const user = userEvent.setup();
    store.mockResolvedValueOnce(storedOk('Презентация.pdf', 'a', 4_404_019)).mockResolvedValueOnce(storedOk('План.docx', 'b', 2_097_152));
    renderBrief();

    await user.upload(picker(), [pdf('Презентация.pdf'), pdf('План.docx')]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Материалы загружены' })).toBeInTheDocument();
    expect(store).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Презентация.pdf')).toBeInTheDocument();
    expect(screen.getByText('4,2 МБ')).toBeInTheDocument();
    expect(screen.getByText('2,0 МБ')).toBeInTheDocument();
    expect(addCounter()).toHaveTextContent('· использовано 2 из 5');
    expect(screen.queryByText('Текст распознан')).not.toBeInTheDocument();
    expect(screen.getByText('DOCX')).toBeInTheDocument();
    // Загруженное запоминается в потоке: переживёт переход на другой экран.
    expect(loadFlow().briefFiles?.map((f) => f.file_name)).toEqual(['Презентация.pdf', 'План.docx']);
  });

  it('сервер ответил «дубль» — строка с пометкой, в лимит не считается', async () => {
    const user = userEvent.setup();
    store.mockResolvedValueOnce(storedOk('Pitch.pdf', 'a')).mockResolvedValueOnce({ status: 'duplicate' });
    renderBrief();
    await user.upload(picker(), [pdf('Pitch.pdf'), pdf('Pitch (1).pdf')]);

    expect(await screen.findByText('Этот файл уже загружен — повторно не разбираем и в лимит не считаем')).toBeInTheDocument();
    expect(addCounter()).toHaveTextContent('· использовано 1 из 5');
    expect(loadFlow().briefFiles).toHaveLength(1);
  });

  it('тот же файл, добавленный второй раз за сессию (одинаковый хеш), — тоже дубль', async () => {
    const user = userEvent.setup();
    store.mockResolvedValue(storedOk('Pitch.pdf', 'a'));
    renderBrief();
    await user.upload(picker(), pdf('Pitch.pdf'));
    await screen.findByRole('heading', { level: 1, name: 'Материалы загружены' });
    await user.click(addCounter());
    await user.upload(picker(), pdf('Pitch copy.pdf'));

    await waitFor(() => expect(screen.getByText('Pitch copy.pdf')).toBeInTheDocument());
    expect(addCounter()).toHaveTextContent('· использовано 1 из 5');
    expect(loadFlow().briefFiles).toHaveLength(1);
  });

  it('сервер отказал (формат, размер): текст отказа показан, список не появился', async () => {
    const user = userEvent.setup();
    const message = 'Загрузите файл в формате PDF, DOCX или PPTX. Скан передайте одним PDF.';
    store.mockResolvedValueOnce({ status: 'error', code: 'INVALID_FIELD_VALUE', message });
    renderBrief();
    await user.upload(picker(), pdf('scan.pdf'));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    expect(loadFlow().briefFiles).toBeUndefined();
  });

  it('один файл не прошёл, остальные загружены: показан отказ и список из принятых', async () => {
    const user = userEvent.setup();
    store.mockResolvedValueOnce({ status: 'error', code: 'INVALID_FIELD_VALUE', message: 'Файл пустой.' }).mockResolvedValueOnce(storedOk('Good.pdf', 'a'));
    renderBrief();
    await user.upload(picker(), [pdf('Empty.pdf'), pdf('Good.pdf')]);

    expect(await screen.findByRole('heading', { level: 1, name: 'Материалы загружены' })).toBeInTheDocument();
    expect(screen.getByText('Good.pdf')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Файл пустой.');
  });

  it('лимит тарифа: лишние файлы на сервер не отправляются, показано сообщение о лимите', async () => {
    const user = userEvent.setup();
    cabinet.state = { files_limit: 2 };
    store.mockResolvedValueOnce(storedOk('One.pdf', 'a')).mockResolvedValueOnce(storedOk('Two.pdf', 'b'));
    renderBrief();
    await user.upload(picker(), [pdf('One.pdf'), pdf('Two.pdf'), pdf('Three.pdf')]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Лимит файлов исчерпан. Удалите ненужный файл.');
    expect(store).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Three.pdf')).not.toBeInTheDocument();
    expect(addCounter()).toHaveTextContent('· использовано 2 из 2');
  });

  it('сервер отказал по лимиту или тарифу: остальные файлы из выбора не отправляются', async () => {
    const user = userEvent.setup();
    store.mockResolvedValueOnce({ status: 'error', code: 'FILE_QUOTA_EXCEEDED', message: 'Превышен лимит загрузки файлов по тарифу' });
    renderBrief();
    await user.upload(picker(), [pdf('One.pdf'), pdf('Two.pdf')]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Превышен лимит загрузки файлов по тарифу');
    expect(store).toHaveBeenCalledTimes(1);
  });

  it('«Удалить файл» убирает файл из списка и из потока; без файлов сборка по ним недоступна', async () => {
    const user = userEvent.setup();
    store.mockResolvedValueOnce(storedOk('One.pdf', 'a')).mockResolvedValueOnce(storedOk('Two.pdf', 'b'));
    renderBrief();
    await user.upload(picker(), [pdf('One.pdf'), pdf('Two.pdf')]);
    await screen.findByRole('heading', { level: 1, name: 'Материалы загружены' });

    await user.click(screen.getAllByRole('button', { name: 'Удалить файл' })[0]!);
    expect(screen.queryByText('One.pdf')).not.toBeInTheDocument();
    expect(addCounter()).toHaveTextContent('· использовано 1 из 5');
    expect(loadFlow().briefFiles?.map((f) => f.file_name)).toEqual(['Two.pdf']);

    await user.click(screen.getByRole('button', { name: 'Удалить файл' }));
    expect(screen.getByRole('button', { name: 'Собрать паспорт по файлам' })).toBeDisabled();
  });
});

describe('Brief (живой режим): сборка по файлам', () => {
  it('«Собрать паспорт по файлам» ставит в очередь сохранённые файлы, без брифа, и ведёт на экран сборки', async () => {
    const user = userEvent.setup();
    store.mockResolvedValueOnce(storedOk('Pitch.pdf', 'a'));
    renderBrief();
    await user.upload(picker(), pdf('Pitch.pdf'));
    await user.click(await screen.findByRole('button', { name: 'Собрать паспорт по файлам' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Буха читает материалы' })).toBeInTheDocument();
    const flow = loadFlow();
    expect(flow.pendingFiles).toEqual([stored('Pitch.pdf', 'a')]);
    expect(flow.pendingBrief).toBeUndefined();
  });

  it('после обновления страницы загруженные файлы на месте: открывается список, а не вопрос', () => {
    saveFlow({ briefFiles: [stored('Pitch.pdf', 'a'), stored('Plan.docx', 'b')] });
    renderBrief();
    expect(screen.getByRole('heading', { level: 1, name: 'Материалы загружены' })).toBeInTheDocument();
    expect(screen.getByText('Pitch.pdf')).toBeInTheDocument();
    expect(addCounter()).toHaveTextContent('· использовано 2 из 5');
  });

  it('«Назад» из списка возвращает к вопросу, файлы остаются в потоке', async () => {
    const user = userEvent.setup();
    saveFlow({ briefFiles: [stored('Pitch.pdf', 'a')] });
    renderBrief();
    await user.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    expect(loadFlow().briefFiles).toHaveLength(1);
  });

  it('сборка по анкете после загрузки файлов не тянет их за собой: очередь файлов очищена', async () => {
    const user = userEvent.setup();
    saveFlow({ briefFiles: [stored('Pitch.pdf', 'a')], pendingFiles: [stored('Pitch.pdf', 'a')] });
    renderBrief();
    await user.click(screen.getByRole('button', { name: 'Назад' }));
    await user.click(screen.getByRole('button', { name: 'У меня нет файлов' }));
    for (const label of [/1\. Какую проблему/, /2\. Что делает продукт/, /3\. Что уже сделано/, /4\. Кто в команде/]) {
      await user.type(screen.getByLabelText(label), 'Ответ');
    }
    await user.click(screen.getByRole('button', { name: 'Собрать паспорт' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Буха читает материалы' })).toBeInTheDocument();
    const flow = loadFlow();
    expect(flow.pendingBrief).toContain('Ответ');
    expect(flow.pendingFiles).toBeUndefined();
    expect(flow.briefFiles).toBeUndefined();
  });

  it('«Назад» на первом вопросе ведёт к профилю', () => {
    renderBrief();
    expect(within(document.body).getByRole('link', { name: 'Назад' })).toHaveAttribute('href', '/onboarding');
  });
});
