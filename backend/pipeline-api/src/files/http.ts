// Материалы проекта: POST /pipeline/files (тело — сам файл, имя в x-file-name), GET и DELETE /pipeline/files/:id.
// Загрузка только сохраняет файл на общий том и проверяет тариф. Разбор запускает отдельный запрос POST /pipeline
// со ссылкой на этот файл: пайплайн долгий (минуты), а приём файла должен отвечать сразу.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PipelineFailure } from '../errors';
import { sessionUserFor, type AuthHttpOptions } from '../auth/http';
import type { PipelineDeps } from '../pipeline/deps';
import { checkProjectFile, mimeForFile, ownUploadPath, PROJECT_FILE_MAX_BYTES, PROJECT_FILE_MAX_MB, removeOwnUpload, sha256Of, storeProjectFile } from './storage';

export const FILES_PATH = '/pipeline/files';
export const FILES_PREFIX = '/pipeline/files/';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FilesHttpOptions {
  uploadDir: string;
  sharedSecret?: string;
  /** Вход по сессии: пользователь берётся из cookie. Без него (старый режим с общим секретом) — заголовок x-user-id. */
  auth?: AuthHttpOptions;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function fail(res: ServerResponse, status: number, code: string, message: string) {
  send(res, status, { status: 'ERROR', code, message });
}

async function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Возвращает true, если запрос относился к файлам и ответ уже отправлен. */
export async function handleFilesRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: PipelineDeps,
  opts: FilesHttpOptions,
): Promise<boolean> {
  const isCollection = pathname === FILES_PATH;
  if (!isCollection && !pathname.startsWith(FILES_PREFIX)) return false;

  if (opts.sharedSecret && req.headers['x-pipeline-secret'] !== opts.sharedSecret) {
    send(res, 401, { error: 'unauthorized' });
    return true;
  }
  let userId: unknown = req.headers['x-user-id'];
  if (opts.auth) {
    const user = await sessionUserFor(req, opts.auth);
    if (!user) {
      send(res, 401, { status: 'UNAUTHORIZED' });
      return true;
    }
    userId = user.userId;
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    send(res, 401, { status: 'UNAUTHORIZED' });
    return true;
  }
  const ctx = await deps.store.loadContext(userId);
  if (!ctx || ctx.isBanned) {
    fail(res, 422, 'USER_BANNED', 'Профиль не найден или заблокирован');
    return true;
  }

  if (isCollection) {
    if (req.method !== 'POST') {
      send(res, 405, { error: 'method not allowed' });
      return true;
    }
    if (!ctx.features.ai_parsing) {
      fail(res, 422, 'PLAN_UPGRADE_REQUIRED', 'На вашем тарифе загрузка документов недоступна');
      return true;
    }
    const content = await readRaw(req, PROJECT_FILE_MAX_BYTES);
    if (!content) {
      fail(res, 413, 'INVALID_FIELD_VALUE', `Файл больше ${PROJECT_FILE_MAX_MB} МБ.`);
      return true;
    }
    let fileName = '';
    try {
      fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
    } catch {
      // имя не в URL-кодировке — считаем, что имени нет
    }
    try {
      // Сначала формат и размер, потом дубль и лимит: повторная загрузка того же файла лимит не занимает.
      checkProjectFile(fileName, content);
      if (ctx.project && (await deps.store.findSourceBySha(ctx.project.id, sha256Of(content)))) {
        send(res, 200, { status: 'DUPLICATE' });
        return true;
      }
      if (ctx.uploadedFilesCount >= ctx.fileUploadsLimit) {
        throw new PipelineFailure('FILE_QUOTA_EXCEEDED', 'Превышен лимит загрузки файлов по тарифу');
      }
      const file = await storeProjectFile(opts.uploadDir, userId, fileName, content);
      send(res, 200, { status: 'OK', file });
    } catch (err) {
      if (err instanceof PipelineFailure) {
        fail(res, 422, err.code, err.message);
        return true;
      }
      throw err;
    }
    return true;
  }

  const sourceId = pathname.slice(FILES_PREFIX.length);
  if (!UUID_RE.test(sourceId)) {
    send(res, 404, { error: 'not found' });
    return true;
  }
  const source = await deps.store.getUserSource(userId, sourceId);
  if (!source) {
    send(res, 404, { error: 'not found' });
    return true;
  }

  if (req.method === 'GET') {
    const path = ownUploadPath(opts.uploadDir, userId, source.file_url);
    const info = path ? await stat(path).catch(() => null) : null;
    if (!path || !info?.isFile()) {
      send(res, 404, { error: 'not found' });
      return true;
    }
    res.writeHead(200, {
      'Content-Type': mimeForFile(source.file_name),
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(source.file_name)}`,
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(path).pipe(res);
    return true;
  }

  if (req.method === 'DELETE') {
    await deps.store.deleteUserSource(userId, sourceId);
    await removeOwnUpload(opts.uploadDir, userId, source.file_url);
    send(res, 200, { status: 'OK' });
    return true;
  }

  send(res, 405, { error: 'method not allowed' });
  return true;
}
