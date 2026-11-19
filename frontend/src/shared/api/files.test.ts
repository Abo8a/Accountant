import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', () => ({ env: { pipelineUrl: '/pipeline', liveApi: true, defaultUserId: '550e8400-e29b-41d4-a716-446655440000' } }));
const callPassportPipeline = vi.fn();
vi.mock('./pipeline', () => ({ callPassportPipeline: (...args: unknown[]) => callPassportPipeline(...args) }));

import {
  deleteProjectFile,
  fileDownloadUrl,
  ingestProjectFile,
  ingestProjectFileQueued,
  RETRY_MESSAGE,
  storeProjectFile,
  type StoredFile,
} from './files';

const STORED: StoredFile = { file_name: 'Презентация.pdf', file_url: 'file:///data/uploads/u/abc.pdf', sha256_hash: 'a'.repeat(64), size_bytes: 10 };

function respond(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('api/files: загрузка на сервер', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('отправляет файл сырым телом с закодированным именем и возвращает сохранённый файл', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'OK', file: STORED }));
    const file = new File(['pdf'], 'Презентация.pdf', { type: 'application/pdf' });

    const result = await storeProjectFile(file);

    expect(result).toEqual({ status: 'stored', file: STORED });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/pipeline/files');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: file });
    expect(init.headers).toEqual({ 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Презентация.pdf') });
  });

  it('уже загруженный файл — duplicate', async () => {
    fetchMock.mockReturnValue(respond(200, { status: 'DUPLICATE' }));
    expect(await storeProjectFile(new File(['x'], 'a.pdf'))).toEqual({ status: 'duplicate' });
  });

  it('отказ сервера: код и текст из ответа', async () => {
    fetchMock.mockReturnValue(respond(422, { status: 'ERROR', code: 'FILE_QUOTA_EXCEEDED', message: 'Превышен лимит загрузки файлов по тарифу' }));
    expect(await storeProjectFile(new File(['x'], 'a.pdf'))).toEqual({
      status: 'error',
      code: 'FILE_QUOTA_EXCEEDED',
      message: 'Превышен лимит загрузки файлов по тарифу',
    });
  });

  it('сеть недоступна или ответ не JSON — «Не получилось, повторить»', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await storeProjectFile(new File(['x'], 'a.pdf'))).toEqual({ status: 'error', message: RETRY_MESSAGE });
    fetchMock.mockReturnValueOnce(Promise.resolve(new Response('<html>', { status: 502 })));
    expect(await storeProjectFile(new File(['x'], 'a.pdf'))).toEqual({ status: 'error', message: RETRY_MESSAGE });
  });

  it('удаление: ok — true, ошибка или сеть — false; ссылка на файл строится от адреса API', async () => {
    fetchMock.mockReturnValueOnce(respond(200, { status: 'OK' }));
    expect(await deleteProjectFile('src-1')).toBe(true);
    expect(fetchMock.mock.calls[0]).toEqual(['/pipeline/files/src-1', { method: 'DELETE', credentials: 'same-origin' }]);
    fetchMock.mockReturnValueOnce(respond(404, { error: 'not found' }));
    expect(await deleteProjectFile('src-2')).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(await deleteProjectFile('src-3')).toBe(false);
    expect(fileDownloadUrl('src-1')).toBe('/pipeline/files/src-1');
  });
});

describe('api/files: разбор файла пайплайном', () => {
  beforeEach(() => callPassportPipeline.mockReset());

  it('передаёт в пайплайн только имя, ссылку и хеш, без размера и прочего', async () => {
    callPassportPipeline.mockResolvedValue({ status: 'NEED_USER_INPUT' });
    expect(await ingestProjectFile(STORED)).toEqual({ status: 'done' });
    expect(callPassportPipeline).toHaveBeenCalledWith({
      action: 'init_or_upload',
      files: [{ file_name: STORED.file_name, file_url: STORED.file_url, sha256_hash: STORED.sha256_hash }],
    });
  });

  it('другой проект — blocked; ошибка пайплайна — error с текстом сервера; сбой сети — «Не получилось, повторить»', async () => {
    callPassportPipeline.mockResolvedValueOnce({ status: 'BLOCKED_PROJECT_SWAP', message: 'x', similarity_score: 0.1 });
    expect(await ingestProjectFile(STORED)).toEqual({ status: 'blocked' });
    callPassportPipeline.mockResolvedValueOnce({ status: 'ERROR', code: 'ALREADY_PROCESSING', message: 'Идёт обработка' });
    expect(await ingestProjectFile(STORED)).toEqual({ status: 'error', code: 'ALREADY_PROCESSING', message: 'Идёт обработка' });
    callPassportPipeline.mockRejectedValueOnce(new Error('offline'));
    expect(await ingestProjectFile(STORED)).toEqual({ status: 'error', message: RETRY_MESSAGE });
  });

  it('очередь: второй файл уходит в пайплайн только после ответа по первому', async () => {
    let releaseFirst!: () => void;
    callPassportPipeline
      .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = () => resolve({ status: 'NEED_USER_INPUT' }))))
      .mockResolvedValueOnce({ status: 'NEED_USER_INPUT' });

    const first = ingestProjectFileQueued(STORED);
    const second = ingestProjectFileQueued({ ...STORED, sha256_hash: 'b'.repeat(64) });
    await Promise.resolve();
    await Promise.resolve();
    expect(callPassportPipeline).toHaveBeenCalledTimes(1);

    releaseFirst();
    expect(await first).toEqual({ status: 'done' });
    expect(await second).toEqual({ status: 'done' });
    expect(callPassportPipeline).toHaveBeenCalledTimes(2);
  });
});
