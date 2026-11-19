// Материалы проекта: приём файлов на общий том, лимит и дубли, список в кабинете, скачивание, удаление
// и защита от чужих file_url в запросе пайплайна.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createPipelineServer } from '../src/server';
import { AuthService } from '../src/auth/service';
import type { MailMessage, MailPort } from '../src/mail/port';
import { checkProjectFile, ownUploadPath, sha256Of, verifyOwnUploads } from '../src/files/storage';
import { ingestFiles } from '../src/pipeline/intake';
import { FakeParser, createTestDb, makeDeps, type TestDb } from './helpers';

class CaptureMail implements MailPort {
  sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastCode(): string {
    return this.sent.at(-1)!.text.match(/Ваш код: (\d{6})/)![1]!;
  }
}

const pdf = (text: string) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(text)]);
const zip = (text: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(text)]);

let db: TestDb;
let uploadDir: string;
let base: string;
let stop: () => Promise<void>;
let mail: CaptureMail;
let counter = 0;

beforeAll(async () => {
  db = await createTestDb();
  uploadDir = await mkdtemp(join(tmpdir(), 'buha-uploads-'));
  mail = new CaptureMail();
  const auth = new AuthService(db.sql, mail, 'test-auth-secret', () => new Date(Date.now() + counter++ * 120_000));
  const server = createPipelineServer(makeDeps(db), { auth: { service: auth, cookieSecure: false }, uploadDir });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  stop = () => new Promise<void>((r) => server.close(() => r()));
});

afterAll(async () => {
  await stop();
  await rm(uploadDir, { recursive: true, force: true });
});

async function signIn(): Promise<{ cookie: string; userId: string }> {
  const email = `files.${randomUUID()}@example.com`;
  const json = { 'Content-Type': 'application/json' };
  await fetch(`${base}/auth/code/request`, { method: 'POST', headers: json, body: JSON.stringify({ email }) });
  const res = await fetch(`${base}/auth/code/verify`, { method: 'POST', headers: json, body: JSON.stringify({ email, code: mail.lastCode(), password: 'test-password-1' }) });
  const body = (await res.json()) as { userId: string };
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, userId: body.userId };
}

const upload = (cookie: string | null, name: string, content: Buffer) =>
  fetch(`${base}/pipeline/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name), ...(cookie ? { cookie } : {}) },
    body: content,
  });

describe('проверка и хранение файла', () => {
  it('принимает PDF, DOCX и PPTX по имени и сигнатуре', () => {
    expect(checkProjectFile('Презентация.pdf', pdf('x'))).toBe('.pdf');
    expect(checkProjectFile('План.DOCX', zip('x'))).toBe('.docx');
    expect(checkProjectFile('deck.pptx', zip('x'))).toBe('.pptx');
  });

  it('отклоняет картинки, неизвестные форматы и файл, чьё содержимое не совпадает с расширением', () => {
    expect(() => checkProjectFile('scan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(/PDF, DOCX или PPTX/);
    expect(() => checkProjectFile('notes.txt', Buffer.from('текст'))).toThrow(/PDF, DOCX или PPTX/);
    expect(() => checkProjectFile('fake.pdf', Buffer.from('это не pdf'))).toThrow(/PDF, DOCX или PPTX/);
  });

  it('ссылка засчитывается, только если ведёт в папку этого пользователя', () => {
    const user = randomUUID();
    const own = pathToFileURL(resolve(uploadDir, user, `${'a'.repeat(64)}.pdf`)).href;
    expect(ownUploadPath(uploadDir, user, own)).not.toBeNull();
    expect(ownUploadPath(uploadDir, randomUUID(), own)).toBeNull();
    expect(ownUploadPath(uploadDir, user, pathToFileURL(resolve(uploadDir, user, '..', 'secret.pdf')).href)).toBeNull();
    expect(ownUploadPath(uploadDir, user, `file://${resolve(uploadDir, user)}/../../etc/passwd`)).toBeNull();
    expect(ownUploadPath(uploadDir, user, 's3://bucket/key.pdf')).toBeNull();
    expect(ownUploadPath(uploadDir, user, 'http://example.com/a.pdf')).toBeNull();
  });
});

describe('POST /pipeline/files', () => {
  it('без сессии — 401', async () => {
    expect((await upload(null, 'a.pdf', pdf('x'))).status).toBe(401);
  });

  it('сохраняет файл на том под именем-хешем и возвращает ссылку, хеш и размер', async () => {
    const { cookie, userId } = await signIn();
    const content = pdf('Презентация проекта');
    const res = await upload(cookie, 'Презентация.pdf', content);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; file: { file_name: string; file_url: string; sha256_hash: string; size_bytes: number } };
    expect(body.status).toBe('OK');
    expect(body.file).toMatchObject({ file_name: 'Презентация.pdf', sha256_hash: sha256Of(content), size_bytes: content.length });
    const path = ownUploadPath(uploadDir, userId, body.file.file_url)!;
    expect(path).toBe(resolve(uploadDir, userId, `${sha256Of(content)}.pdf`));
    expect(await readFile(path)).toEqual(content);
  });

  it('неподдерживаемый формат — 422 INVALID_FIELD_VALUE с подсказкой про PDF', async () => {
    const { cookie } = await signIn();
    const res = await upload(cookie, 'scan.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'INVALID_FIELD_VALUE', message: expect.stringContaining('PDF') });
  });

  it('файл больше 25 МБ — 413', async () => {
    const { cookie } = await signIn();
    const res = await upload(cookie, 'big.pdf', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(25 * 1024 * 1024)]));
    expect(res.status).toBe(413);
  });

  it('тариф без разбора документов — 422 PLAN_UPGRADE_REQUIRED', async () => {
    const { cookie } = await signIn();
    await db.sql.query(`UPDATE billing_plans SET features = features || '{"ai_parsing": false}'::jsonb WHERE id = 'free'`);
    try {
      const res = await upload(cookie, 'a.pdf', pdf('x'));
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'PLAN_UPGRADE_REQUIRED' });
    } finally {
      await db.sql.query(`UPDATE billing_plans SET features = features || '{"ai_parsing": true}'::jsonb WHERE id = 'free'`);
    }
  });

  it('уже разобранный файл — DUPLICATE, место в лимите не занимает; шестой новый файл на «Базовом» — FILE_QUOTA_EXCEEDED', async () => {
    const { cookie, userId } = await signIn();
    const projectId = await db.store.ensureProject(userId);
    const contents = Array.from({ length: 5 }, (_, i) => pdf(`документ ${i}`));
    for (const [i, content] of contents.entries()) {
      await db.store.insertSource(projectId, { file_name: `d${i}.pdf`, file_url: `file:///d${i}.pdf`, sha256_hash: sha256Of(content), extracted_text: 't', metadata: {} });
    }
    // Лимит исчерпан (5 из 5), но повторная загрузка уже известного файла — не нарушение.
    const dup = await upload(cookie, 'копия.pdf', contents[2]!);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toEqual({ status: 'DUPLICATE' });

    const sixth = await upload(cookie, 'шестой.pdf', pdf('новый документ'));
    expect(sixth.status).toBe(422);
    expect(await sixth.json()).toMatchObject({ code: 'FILE_QUOTA_EXCEEDED' });
  });
});

describe('список, скачивание и удаление', () => {
  it('GET /pipeline/state отдаёт материалы проекта: размер, страницы и число утверждений', async () => {
    const { cookie, userId } = await signIn();
    const projectId = await db.store.ensureProject(userId);
    const content = pdf('отчёт');
    const sha = sha256Of(content);
    const parser = new FakeParser({
      'file:///report.pdf': { sha256_hash: sha, extracted_text: 'Текст', metadata: { total_pages: 3, pages: [{ page: 1, text: 'Текст', char_start: 0, char_end: 5 }] } },
    });
    await ingestFiles(makeDeps(db, undefined, parser), projectId, [{ file_name: 'report.pdf', file_url: 'file:///report.pdf', sha256_hash: sha, size_bytes: 777 }]);

    const res = await fetch(`${base}/pipeline/state`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const state = (await res.json()) as { files: Record<string, unknown>[]; files_used: number };
    expect(state.files_used).toBe(1);
    expect(state.files).toEqual([
      expect.objectContaining({ file_name: 'report.pdf', sha256_hash: sha, size_bytes: 777, total_pages: 3, claims: 0 }),
    ]);
  });

  it('скачивание и удаление работают только для владельца; удаление убирает запись и файл с тома', async () => {
    const owner = await signIn();
    const stranger = await signIn();
    const content = pdf('мой файл');
    const stored = ((await (await upload(owner.cookie, 'мой файл.pdf', content)).json()) as { file: { file_url: string; sha256_hash: string; file_name: string } }).file;
    const projectId = await db.store.ensureProject(owner.userId);
    const sourceId = await db.store.insertSource(projectId, { ...stored, extracted_text: 't', metadata: {} });
    const diskPath = ownUploadPath(uploadDir, owner.userId, stored.file_url)!;

    const download = await fetch(`${base}/pipeline/files/${sourceId}`, { headers: { cookie: owner.cookie } });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain(encodeURIComponent('мой файл.pdf'));
    expect(Buffer.from(await download.arrayBuffer())).toEqual(content);

    expect((await fetch(`${base}/pipeline/files/${sourceId}`, { headers: { cookie: stranger.cookie } })).status).toBe(404);
    expect((await fetch(`${base}/pipeline/files/${sourceId}`, { method: 'DELETE', headers: { cookie: stranger.cookie } })).status).toBe(404);
    expect(await stat(diskPath)).toBeTruthy();

    const del = await fetch(`${base}/pipeline/files/${sourceId}`, { method: 'DELETE', headers: { cookie: owner.cookie } });
    expect(del.status).toBe(200);
    expect(await db.store.getUserSource(owner.userId, sourceId)).toBeNull();
    await expect(stat(diskPath)).rejects.toThrow();
    expect((await fetch(`${base}/pipeline/files/${sourceId}`, { headers: { cookie: owner.cookie } })).status).toBe(404);
  });
});

describe('file_url в запросе POST /pipeline при входе по сессии', () => {
  const run = (cookie: string, files: unknown) =>
    fetch(`${base}/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ user_id: randomUUID(), action: 'init_or_upload', program: 'Студенческий стартап', files }),
    });
  const hash = 'b'.repeat(64);

  it('чужая папка, произвольный путь сервера и s3:// отклоняются до вызова парсера — 400', async () => {
    const { cookie } = await signIn();
    for (const file_url of [
      'file:///etc/passwd',
      pathToFileURL(resolve(uploadDir, randomUUID(), `${hash}.pdf`)).href,
      's3://bucket/key.pdf',
    ]) {
      const res = await run(cookie, [{ file_name: 'a.pdf', file_url, sha256_hash: hash }]);
      expect(res.status).toBe(400);
    }
  });

  it('ссылка на свой загруженный файл проходит проверку; размер подставляется с диска', async () => {
    const { cookie, userId } = await signIn();
    const content = pdf('свой документ');
    const { file } = (await (await upload(cookie, 'свой.pdf', content)).json()) as { file: { file_url: string; sha256_hash: string } };
    const own = await verifyOwnUploads(uploadDir, userId, [{ file_name: 'свой.pdf', file_url: file.file_url, sha256_hash: file.sha256_hash, size_bytes: 1 }]);
    expect(own).toEqual([expect.objectContaining({ size_bytes: content.length })]);
    // Заявленный хеш обязан совпадать с именем файла на томе.
    expect(await verifyOwnUploads(uploadDir, userId, [{ file_name: 'свой.pdf', file_url: file.file_url, sha256_hash: hash }])).toBeNull();

    const res = await run(cookie, [{ file_name: 'свой.pdf', file_url: file.file_url, sha256_hash: file.sha256_hash }]);
    expect(res.status).not.toBe(400);
  });
});
