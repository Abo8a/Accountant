// Живой режим экрана «Материалы»: файлы настоящие — отправляются на сервер, разбираются пайплайном, скачиваются и удаляются.
import type { CabinetFile } from '../../shared/api/cabinet';
import {
  deleteProjectFile,
  fileDownloadUrl,
  ingestProjectFileQueued,
  RETRY_MESSAGE,
  storeProjectFile,
} from '../../shared/api/files';
import { refreshCabinetState } from '../../shared/state/cabinet';
import { extOf, formatToday, kindFromExt, pagesWord, type FilesApi, type ProjectFile, type UploadCompletion } from './Files.model';

/** Форматы, которые понимает парсер (скан — одним PDF). */
export const LIVE_ACCEPT = '.pdf,.docx,.pptx';

/** Материал проекта с сервера → строка списка. id строки — порядковый, настоящий id источника лежит в remoteId. */
export function projectFileFromCabinet(file: CabinetFile, id: number): ProjectFile {
  const ext = extOf(file.file_name);
  return {
    id,
    name: file.file_name,
    ext,
    kind: kindFromExt(ext),
    pages: file.total_pages ? pagesWord(file.total_pages) : undefined,
    mb: (file.size_bytes ?? 0) / 1048576,
    date: formatToday(new Date(file.uploaded_at)),
    claims: file.claims,
    st: 'ok',
    sha256: file.sha256_hash,
    remoteId: file.id,
  };
}

/** Ждёт, пока пайплайн разберёт файл, и сверяет результат с тем, что реально сохранено на сервере. */
async function complete(sha256: string, ingest: ReturnType<typeof ingestProjectFileQueued>): Promise<UploadCompletion> {
  const result = await ingest;
  const state = await refreshCabinetState();
  const saved = state?.files.find((f) => f.sha256_hash === sha256);

  if (result.status === 'blocked') {
    // Файл другого проекта сохраняться не должен: пайплайн успевает записать источник до проверки Стража.
    if (saved) {
      await deleteProjectFile(saved.id);
      await refreshCabinetState();
    }
    return { outcome: 'BLOCKED_PROJECT_SWAP' };
  }
  if (result.status === 'error') return { outcome: 'error', message: result.message };
  // Пайплайн ответил без ошибки, но файл не записан (например, не пройден допуск): не выдаём это за успех.
  if (!saved) return { outcome: 'error', message: RETRY_MESSAGE };
  return { outcome: 'done', remoteId: saved.id, claims: saved.claims, pages: saved.total_pages ? pagesWord(saved.total_pages) : undefined };
}

export const liveFilesApi: FilesApi = {
  live: true,

  async upload({ file }) {
    if (!file) return { status: 'rejected', message: RETRY_MESSAGE };
    const stored = await storeProjectFile(file);
    if (stored.status === 'duplicate') return { status: 'duplicate' };
    if (stored.status === 'error') {
      if (stored.code === 'FILE_QUOTA_EXCEEDED') return { status: 'FILE_QUOTA_EXCEEDED' };
      if (stored.code === 'PLAN_UPGRADE_REQUIRED') return { status: 'PLAN_UPGRADE_REQUIRED' };
      return { status: 'rejected', message: stored.message };
    }
    return { status: 'accepted', completion: complete(stored.file.sha256_hash, ingestProjectFileQueued(stored.file)) };
  },

  async remove(file) {
    if (!file.remoteId) return false;
    const ok = await deleteProjectFile(file.remoteId);
    if (ok) await refreshCabinetState();
    return ok;
  },

  downloadUrl: (file) => (file.remoteId ? fileDownloadUrl(file.remoteId) : null),
};
