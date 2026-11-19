import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CabinetFile } from '../../shared/api/cabinet';

const store = vi.fn();
const ingest = vi.fn();
const del = vi.fn();
vi.mock('../../shared/api/files', () => ({
  RETRY_MESSAGE: 'Не получилось, повторить',
  storeProjectFile: (...a: unknown[]) => store(...a),
  ingestProjectFileQueued: (...a: unknown[]) => ingest(...a),
  deleteProjectFile: (...a: unknown[]) => del(...a),
  fileDownloadUrl: (id: string) => `/pipeline/files/${id}`,
}));
const refresh = vi.fn();
vi.mock('../../shared/state/cabinet', () => ({ refreshCabinetState: () => refresh(), useCabinetState: vi.fn() }));

import { LIVE_ACCEPT, liveFilesApi, projectFileFromCabinet } from './Files.live';

const SHA = 'c'.repeat(64);
const STORED_FILE = { file_name: 'deck.pdf', file_url: 'file:///data/uploads/u/x.pdf', sha256_hash: SHA, size_bytes: 2_097_152 };
const upload = () => liveFilesApi.upload({ name: 'deck.pdf', sizeMb: 2, sha256: SHA, existing: [], fileLimit: 5, file: new File(['x'], 'deck.pdf') });
const cabinetFile = (patch: Partial<CabinetFile> = {}): CabinetFile => ({
  id: 'src-1', file_name: 'deck.pdf', sha256_hash: SHA, uploaded_at: '2026-11-05T10:00:00.000Z', size_bytes: 2_097_152, total_pages: 15, claims: 18, ...patch,
});
const stateWith = (...files: CabinetFile[]) => ({ files });

beforeEach(() => {
  store.mockReset();
  ingest.mockReset();
  del.mockReset();
  refresh.mockReset();
});

describe('projectFileFromCabinet', () => {
  it('материал с сервера → строка списка: страницы со склонением, размер в МБ, дата, число утверждений', () => {
    const row = projectFileFromCabinet(cabinetFile(), 7);
    expect(row).toMatchObject({ id: 7, name: 'deck.pdf', ext: 'PDF', kind: 'pdf', pages: '15 страниц', mb: 2, claims: 18, st: 'ok', sha256: SHA, remoteId: 'src-1' });
    expect(row.date).toMatch(/^\d{2}\.11\.2026$/);
    expect(projectFileFromCabinet(cabinetFile({ total_pages: 1 }), 1).pages).toBe('1 страница');
    expect(projectFileFromCabinet(cabinetFile({ total_pages: 24 }), 1).pages).toBe('24 страницы');
    expect(projectFileFromCabinet(cabinetFile({ total_pages: null }), 1).pages).toBeUndefined();
  });
});

describe('liveFilesApi.upload', () => {
  it('помечен как живой и принимает только форматы, которые понимает парсер', () => {
    expect(liveFilesApi.live).toBe(true);
    expect(LIVE_ACCEPT).toBe('.pdf,.docx,.pptx');
  });

  it('без файла — rejected', async () => {
    expect(await liveFilesApi.upload({ name: 'a.pdf', sizeMb: 1, sha256: SHA, existing: [], fileLimit: 5 })).toMatchObject({ status: 'rejected' });
    expect(store).not.toHaveBeenCalled();
  });

  it('ответы сервера переводятся в статусы экрана: дубль, лимит, тариф, прочий отказ с текстом', async () => {
    store.mockResolvedValueOnce({ status: 'duplicate' });
    expect(await upload()).toEqual({ status: 'duplicate' });
    store.mockResolvedValueOnce({ status: 'error', code: 'FILE_QUOTA_EXCEEDED', message: 'x' });
    expect(await upload()).toEqual({ status: 'FILE_QUOTA_EXCEEDED' });
    store.mockResolvedValueOnce({ status: 'error', code: 'PLAN_UPGRADE_REQUIRED', message: 'x' });
    expect(await upload()).toEqual({ status: 'PLAN_UPGRADE_REQUIRED' });
    store.mockResolvedValueOnce({ status: 'error', code: 'INVALID_FIELD_VALUE', message: 'Загрузите файл в формате PDF, DOCX или PPTX.' });
    expect(await upload()).toEqual({ status: 'rejected', message: 'Загрузите файл в формате PDF, DOCX или PPTX.' });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('принятый файл: разбор идёт в фоне, по окончании приходят id на сервере, утверждения и страницы', async () => {
    store.mockResolvedValue({ status: 'stored', file: STORED_FILE });
    ingest.mockResolvedValue({ status: 'done' });
    refresh.mockResolvedValue(stateWith(cabinetFile({ id: 'src-9', claims: 4, total_pages: 3 })));

    const res = await upload();
    expect(res.status).toBe('accepted');
    expect(ingest).toHaveBeenCalledWith(STORED_FILE);
    expect(await res.completion).toEqual({ outcome: 'done', remoteId: 'src-9', claims: 4, pages: '3 страницы' });
  });

  it('пайплайн вернул ошибку — текст сервера; пайплайн «успешен», но файла в проекте нет — не выдаём за успех', async () => {
    store.mockResolvedValue({ status: 'stored', file: STORED_FILE });
    refresh.mockResolvedValue(stateWith());

    ingest.mockResolvedValueOnce({ status: 'error', code: 'ALREADY_PROCESSING', message: 'Идёт обработка' });
    expect(await (await upload()).completion).toEqual({ outcome: 'error', message: 'Идёт обработка' });

    ingest.mockResolvedValueOnce({ status: 'done' });
    expect(await (await upload()).completion).toEqual({ outcome: 'error', message: 'Не получилось, повторить' });
  });

  it('файл другого проекта: источник, который успел записаться до проверки, удаляется', async () => {
    store.mockResolvedValue({ status: 'stored', file: STORED_FILE });
    ingest.mockResolvedValue({ status: 'blocked' });
    refresh.mockResolvedValue(stateWith(cabinetFile({ id: 'src-swap' })));
    del.mockResolvedValue(true);

    expect(await (await upload()).completion).toEqual({ outcome: 'BLOCKED_PROJECT_SWAP' });
    expect(del).toHaveBeenCalledWith('src-swap');
  });
});

describe('liveFilesApi.remove / downloadUrl', () => {
  it('удаляет на сервере и обновляет состояние кабинета; при неудаче состояние не трогает', async () => {
    del.mockResolvedValueOnce(true);
    expect(await liveFilesApi.remove!({ ...projectFileFromCabinet(cabinetFile(), 1) })).toBe(true);
    expect(del).toHaveBeenCalledWith('src-1');
    expect(refresh).toHaveBeenCalledTimes(1);

    del.mockResolvedValueOnce(false);
    expect(await liveFilesApi.remove!(projectFileFromCabinet(cabinetFile(), 1))).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('файл без id на сервере (ещё разбирается) нельзя ни удалить, ни скачать', async () => {
    const pending = { ...projectFileFromCabinet(cabinetFile(), 1), remoteId: undefined };
    expect(await liveFilesApi.remove!(pending)).toBe(false);
    expect(liveFilesApi.downloadUrl!(pending)).toBeNull();
    expect(liveFilesApi.downloadUrl!(projectFileFromCabinet(cabinetFile(), 1))).toBe('/pipeline/files/src-1');
  });
});
