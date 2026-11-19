import { env } from '../config/env';
import { callPassportPipeline } from './pipeline';

// Материалы проекта в живом режиме. Загрузка в два шага, потому что разбор долгий (минуты):
//   1) POST /pipeline/files — файл сохраняется на сервере, ответ приходит сразу;
//   2) POST /pipeline с ссылкой на сохранённый файл — парсер и модели извлекают факты в паспорт.

export interface StoredFile {
  file_name: string;
  file_url: string;
  sha256_hash: string;
  size_bytes: number;
}

export type StoreResult =
  | { status: 'stored'; file: StoredFile }
  | { status: 'duplicate' }
  | { status: 'error'; code?: string; message: string };

export type IngestResult =
  | { status: 'done' }
  | { status: 'blocked' }
  | { status: 'error'; code?: string; message: string };

/** Текст из user-flows F5: ошибка без потери уже загруженного. */
export const RETRY_MESSAGE = 'Не получилось, повторить';

const filesUrl = () => `${env.pipelineUrl}/files`;

/** Ссылка на скачивание файла (cookie сессии уходит сама, ответ — attachment). */
export function fileDownloadUrl(sourceId: string): string {
  return `${filesUrl()}/${sourceId}`;
}

/** Сохраняет файл на сервере: PDF, DOCX или PPTX до 25 МБ. Повторная загрузка того же файла — duplicate. */
export async function storeProjectFile(file: File): Promise<StoreResult> {
  try {
    const res = await fetch(filesUrl(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
      body: file,
    });
    const json = (await res.json().catch(() => ({}))) as { status?: string; code?: string; message?: string; file?: StoredFile };
    if (res.ok && json.status === 'DUPLICATE') return { status: 'duplicate' };
    if (res.ok && json.status === 'OK' && json.file) return { status: 'stored', file: json.file };
    return { status: 'error', code: json.code, message: json.message ?? RETRY_MESSAGE };
  } catch {
    return { status: 'error', message: RETRY_MESSAGE };
  }
}

/** Отдаёт сохранённый файл на разбор. Ждёт ответа пайплайна — это может занять несколько минут. */
export async function ingestProjectFile(file: StoredFile): Promise<IngestResult> {
  try {
    const res = await callPassportPipeline({
      action: 'init_or_upload',
      files: [{ file_name: file.file_name, file_url: file.file_url, sha256_hash: file.sha256_hash }],
    });
    if (res.status === 'BLOCKED_PROJECT_SWAP') return { status: 'blocked' };
    if (res.status === 'ERROR') return { status: 'error', code: res.code, message: res.message };
    return { status: 'done' };
  } catch {
    return { status: 'error', message: RETRY_MESSAGE };
  }
}

// Пайплайн обрабатывает один запрос на пользователя за раз (иначе ALREADY_PROCESSING), поэтому разбор файлов идёт по очереди.
let queue: Promise<unknown> = Promise.resolve();
export function ingestProjectFileQueued(file: StoredFile): Promise<IngestResult> {
  const next = queue.then(() => ingestProjectFile(file));
  queue = next.catch(() => undefined);
  return next;
}

/** Удаляет материал проекта. Утверждения в паспорте остаются, но теряют источник. */
export async function deleteProjectFile(sourceId: string): Promise<boolean> {
  try {
    const res = await fetch(fileDownloadUrl(sourceId), { method: 'DELETE', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}
