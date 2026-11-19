// Экран сборки в живом режиме: что именно уходит в пайплайн — текст анкеты или файлы, сохранённые на сервере.
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredFile } from '../../shared/api/files';

vi.mock('../../shared/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/config/env')>();
  return { env: { ...actual.env, liveApi: true, pipelineUrl: '/pipeline' } };
});
const pipeline = vi.fn();
vi.mock('../../shared/api/pipeline', () => ({ callPassportPipeline: (...a: unknown[]) => pipeline(...a) }));
vi.mock('../../shared/state/cabinet', () => ({ refreshCabinetState: vi.fn(), useCabinetState: () => null }));

import { loadFlow, saveFlow } from '../../shared/state/flow';
import { Generating } from './Generating';

const file = (name: string, sha: string): StoredFile => ({
  file_name: name,
  file_url: `file:///data/uploads/u/${sha}.pdf`,
  sha256_hash: sha.repeat(64).slice(0, 64),
  size_bytes: 123,
});

function renderGenerating() {
  return render(
    <MemoryRouter initialEntries={['/generating']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/generating" element={<Generating />} />
        <Route path="/brief" element={<h1>Есть материалы о проекте?</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  pipeline.mockReset();
});
afterEach(() => window.sessionStorage.clear());

describe('Generating (живой режим): сборка по файлам', () => {
  it('отдаёт пайплайну только имя, ссылку и хеш файлов и не присылает текст брифа', async () => {
    pipeline.mockResolvedValue({ status: 'NEED_USER_INPUT' });
    saveFlow({ pendingFiles: [file('Презентация.pdf', 'a'), file('План.docx', 'b')], briefFiles: [file('Презентация.pdf', 'a')] });
    renderGenerating();

    await waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
    expect(pipeline).toHaveBeenCalledWith({
      action: 'init_or_upload',
      files: [
        { file_name: 'Презентация.pdf', file_url: file('x', 'a').file_url, sha256_hash: file('x', 'a').sha256_hash },
        { file_name: 'План.docx', file_url: file('x', 'b').file_url, sha256_hash: file('x', 'b').sha256_hash },
      ],
    });
  });

  it('после успешной сборки очередь и список файлов очищены, ответ сохранён', async () => {
    pipeline.mockResolvedValue({ status: 'NEED_USER_INPUT' });
    saveFlow({ pendingFiles: [file('Pitch.pdf', 'a')], briefFiles: [file('Pitch.pdf', 'a')] });
    renderGenerating();

    await waitFor(() => expect(loadFlow().last).toEqual({ status: 'NEED_USER_INPUT' }));
    expect(loadFlow().pendingFiles).toBeUndefined();
    expect(loadFlow().briefFiles).toBeUndefined();
  });

  it('при ошибке пайплайна очередь остаётся: «повторить» отправит те же файлы', async () => {
    pipeline.mockResolvedValue({ status: 'ERROR', code: 'FILE_QUOTA_EXCEEDED', message: 'Превышен лимит загрузки файлов по тарифу' });
    saveFlow({ pendingFiles: [file('Pitch.pdf', 'a')] });
    renderGenerating();

    expect(await screen.findByText('Превышен лимит загрузки файлов по тарифу')).toBeInTheDocument();
    expect(loadFlow().pendingFiles).toHaveLength(1);
  });

  it('отказ по стоп-фактору возвращает на бриф и очищает файлы: пайплайн их уже записал в проект', async () => {
    pipeline.mockResolvedValue({
      status: 'WAITING_FOR_INITIAL_BRIEF',
      fatal_stop_factors: [{ reason: 'Двойное назначение', how_to_fix: 'Уберите военное применение' }],
    });
    saveFlow({ pendingFiles: [file('Pitch.pdf', 'a')], briefFiles: [file('Pitch.pdf', 'a')] });
    renderGenerating();

    expect(await screen.findByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    expect(loadFlow().briefRefusal).toEqual([{ reason: 'Двойное назначение', how_to_fix: 'Уберите военное применение' }]);
    expect(loadFlow().pendingFiles).toBeUndefined();
    expect(loadFlow().briefFiles).toBeUndefined();
  });

  it('сборка по анкете, как раньше: уходит text_input без поля files', async () => {
    pipeline.mockResolvedValue({ status: 'NEED_USER_INPUT' });
    saveFlow({ pendingBrief: 'Проект про попутчиков' });
    renderGenerating();

    await waitFor(() => expect(pipeline).toHaveBeenCalledTimes(1));
    expect(pipeline).toHaveBeenCalledWith({ action: 'init_or_upload', text_input: 'Проект про попутчиков' });
  });

  it('ни брифа, ни файлов, ни прежнего ответа — возврат на бриф', async () => {
    renderGenerating();
    expect(await screen.findByRole('heading', { level: 1, name: 'Есть материалы о проекте?' })).toBeInTheDocument();
    expect(pipeline).not.toHaveBeenCalled();
  });
});
