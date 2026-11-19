// Хранение материалов проекта на общем томе: <uploadDir>/<user_id>/<sha256><.pdf|.docx|.pptx>.
// Парсер читает файл по file://-ссылке на тот же путь. Имя на диске — хеш содержимого: одинаковые файлы
// одного пользователя лежат одним файлом, а имя из запроса никогда не попадает в путь.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PipelineFileInput } from '@passport/contracts';
import { PipelineFailure } from '../errors';

export const PROJECT_FILE_MAX_BYTES = 25 * 1024 * 1024;
export const PROJECT_FILE_MAX_MB = 25;

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** Форматы, которые понимает парсер. Сканы принимаются как PDF (OCR внутри парсера). Сигнатура проверяется по содержимому. */
const FORMATS: Record<string, { magic: number[]; mime: string }> = {
  '.pdf': { magic: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf' },
  '.docx': { magic: ZIP_MAGIC, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.pptx': { magic: ZIP_MAGIC, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

const UNSUPPORTED_MESSAGE = 'Загрузите файл в формате PDF, DOCX или PPTX. Скан передайте одним PDF.';

export interface StoredProjectFile {
  file_name: string;
  file_url: string;
  sha256_hash: string;
  size_bytes: number;
}

/** Расширение файла, если имя и содержимое подходят; иначе PipelineFailure с понятным текстом. */
export function checkProjectFile(fileName: string, content: Buffer): string {
  const ext = extname(fileName).toLowerCase();
  const format = FORMATS[ext];
  if (!format || !format.magic.every((b, i) => content[i] === b)) {
    throw new PipelineFailure('INVALID_FIELD_VALUE', UNSUPPORTED_MESSAGE);
  }
  if (content.length === 0) throw new PipelineFailure('INVALID_FIELD_VALUE', 'Файл пустой.');
  if (content.length > PROJECT_FILE_MAX_BYTES) {
    throw new PipelineFailure('INVALID_FIELD_VALUE', `Файл больше ${PROJECT_FILE_MAX_MB} МБ.`);
  }
  return ext;
}

export function mimeForFile(fileName: string): string {
  return FORMATS[extname(fileName).toLowerCase()]?.mime ?? 'application/octet-stream';
}

function userDir(uploadDir: string, userId: string): string {
  return resolve(uploadDir, userId);
}

export function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Сохраняет файл пользователя и возвращает данные для запроса к пайплайну. Запись атомарная: сначала временный файл. */
export async function storeProjectFile(
  uploadDir: string,
  userId: string,
  fileName: string,
  content: Buffer,
): Promise<StoredProjectFile> {
  const name = fileName.trim().slice(0, 255);
  if (!name) throw new PipelineFailure('INVALID_FIELD_VALUE', 'Не указано имя файла.');
  const ext = checkProjectFile(name, content);
  const sha = sha256Of(content);
  const dir = userDir(uploadDir, userId);
  const target = resolve(dir, `${sha}${ext}`);
  await mkdir(dir, { recursive: true });
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, content);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { file_name: name, file_url: pathToFileURL(target).href, sha256_hash: sha, size_bytes: content.length };
}

/** Локальный путь файла, если ссылка ведёт внутрь папки этого пользователя; иначе null (чужая папка, `..`, s3://, http://). */
export function ownUploadPath(uploadDir: string, userId: string, fileUrl: string): string | null {
  let path: string;
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== 'file:') return null;
    path = fileURLToPath(url);
  } catch {
    return null;
  }
  const full = resolve(path);
  return full.startsWith(userDir(uploadDir, userId) + sep) ? full : null;
}

/**
 * Запрос клиента может ссылаться только на уже загруженные им файлы: путь внутри его папки, имя = заявленный хеш,
 * файл существует. Размер берётся с диска. Иначе парсер прочитал бы любой файл сервера по присланному пути.
 */
export async function verifyOwnUploads(
  uploadDir: string,
  userId: string,
  files: PipelineFileInput[],
): Promise<PipelineFileInput[] | null> {
  const out: PipelineFileInput[] = [];
  for (const file of files) {
    const path = ownUploadPath(uploadDir, userId, file.file_url);
    if (!path || basename(path, extname(path)) !== file.sha256_hash.toLowerCase()) return null;
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    out.push({ ...file, size_bytes: info.size });
  }
  return out;
}

/** Удаляет файл с диска, если он лежит в папке пользователя. Ошибки не пробрасываются: запись в базе уже удалена. */
export async function removeOwnUpload(uploadDir: string, userId: string, fileUrl: string): Promise<void> {
  const path = ownUploadPath(uploadDir, userId, fileUrl);
  if (path) await rm(path, { force: true }).catch(() => undefined);
}
