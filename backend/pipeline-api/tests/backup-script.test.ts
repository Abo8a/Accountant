// deploy/backup.sh: копия базы и тома загрузок, откат при сбое, ротация. pg_dump подменён заглушкой, tar и find настоящие.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', '..', '..', 'deploy', 'backup.sh');
const hasSh = spawnSync('sh', ['-c', 'true']).status === 0;

// Для sh на Windows (Git Bash) пути нужны в виде /c/Users/...: «C:/...» tar принимает за адрес удалённой машины.
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

let root: string;
let backups: string;
let uploads: string;
let stubDump: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buha-backup-'));
  backups = join(root, 'backups');
  uploads = join(root, 'uploads');
  mkdirSync(join(uploads, 'user-1'), { recursive: true });
  writeFileSync(join(uploads, 'user-1', 'abc.pdf'), '%PDF-1.4 материал');
  stubDump = join(root, 'pg_dump_stub.sh');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Заглушка pg_dump: пишет «DUMP» в файл из --file=…, а остальные аргументы — в args.txt. */
function stubPgDump(mode: 'ok' | 'fail' | 'empty') {
  const body = {
    ok: 'echo DUMP > "$file"',
    empty: ': > "$file"',
    fail: 'echo "pg_dump: connection refused" >&2; exit 1',
  }[mode];
  writeFileSync(
    stubDump,
    `#!/bin/sh\nfor a in "$@"; do case "$a" in --file=*) file="\${a#--file=}";; esac; done\necho "$@" > "${posix(root)}/args.txt"\n${body}\n`,
  );
}

function run(env: Record<string, string> = {}) {
  return spawnSync('sh', [posix(SCRIPT)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKUP_ONCE: '1',
      BACKUP_DIR: posix(backups),
      UPLOAD_DIR: posix(uploads),
      PG_DUMP: `sh ${posix(stubDump)}`,
      ...env,
    },
  });
}

const names = (pattern: RegExp) => (existsSync(backups) ? readdirSync(backups).filter((n) => pattern.test(n)) : []);
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const touch = (name: string, days: number) => {
  mkdirSync(backups, { recursive: true });
  writeFileSync(join(backups, name), 'old');
  utimesSync(join(backups, name), daysAgo(days), daysAgo(days));
};

describe.skipIf(!hasSh)('deploy/backup.sh', () => {
  it('делает копию базы и архив загрузок, отмечает успех; в pg_dump уходит формат custom без владельцев', () => {
    stubPgDump('ok');
    const res = run();
    expect(res.status, res.stderr).toBe(0);

    expect(names(/^db-\d{8}-\d{6}\.dump$/)).toHaveLength(1);
    expect(names(/^uploads-\d{8}-\d{6}\.tgz$/)).toHaveLength(1);
    expect(existsSync(join(backups, 'last-success'))).toBe(true);
    expect(readdirSync(backups).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(join(root, 'args.txt'), 'utf8')).toMatch(/--format=custom --no-owner --file=.*db-\d{8}-\d{6}\.dump\.tmp/);
    expect(res.stdout).toMatch(/\[backup\].*база: db-/);
  });

  it('архив загрузок восстанавливается: те же файлы с тем же содержимым', () => {
    stubPgDump('ok');
    expect(run().status).toBe(0);
    const archive = names(/^uploads-.*\.tgz$/)[0]!;

    const restored = join(root, 'restored');
    mkdirSync(restored);
    const untar = spawnSync('tar', ['-xzf', posix(join(backups, archive)), '-C', posix(restored)], { encoding: 'utf8' });
    expect(untar.status, untar.stderr).toBe(0);
    expect(readFileSync(join(restored, 'user-1', 'abc.pdf'), 'utf8')).toBe('%PDF-1.4 материал');
  });

  it('пустой том загрузок — не ошибка: архив создаётся', () => {
    rmSync(join(uploads, 'user-1'), { recursive: true });
    stubPgDump('ok');
    expect(run().status).toBe(0);
    expect(names(/^uploads-.*\.tgz$/)).toHaveLength(1);
  });

  it('сбой pg_dump: код 1, недописанного файла нет, отметка успеха и старые копии не тронуты', () => {
    touch('last-success', 1);
    touch('db-20200101-000000.dump', 400);
    const before = readFileSync(join(backups, 'last-success'), 'utf8');
    stubPgDump('fail');

    const res = run();
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('ОШИБКА: дамп базы не создан');
    expect(names(/^db-\d{8}-\d{6}\.dump/).filter((n) => !n.startsWith('db-2020'))).toEqual([]);
    expect(readdirSync(backups).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(readFileSync(join(backups, 'last-success'), 'utf8')).toBe(before);
    // Копия не удалась — прежние (даже старые) остаются: других у нас нет.
    expect(existsSync(join(backups, 'db-20200101-000000.dump'))).toBe(true);
  });

  it('пустой дамп считается сбоем', () => {
    stubPgDump('empty');
    expect(run().status).toBe(1);
    expect(names(/^db-/)).toEqual([]);
    expect(existsSync(join(backups, 'last-success'))).toBe(false);
  });

  it('ротация после удачной копии: старше 14 дней удаляется, свежее и чужие файлы остаются', () => {
    touch('db-20200101-000000.dump', 20);
    touch('uploads-20200101-000000.tgz', 20);
    touch('db-20201231-000000.dump', 3);
    touch('notes.txt', 400);
    touch('db-20200102-000000.dump.tmp', 5);
    stubPgDump('ok');

    expect(run().status).toBe(0);
    const left = readdirSync(backups);
    expect(left).not.toContain('db-20200101-000000.dump');
    expect(left).not.toContain('uploads-20200101-000000.tgz');
    expect(left).not.toContain('db-20200102-000000.dump.tmp');
    expect(left).toContain('db-20201231-000000.dump');
    expect(left).toContain('notes.txt');
  });

  it('срок хранения задаётся BACKUP_KEEP_DAYS', () => {
    touch('db-20201231-000000.dump', 3);
    touch('db-20201201-000000.dump', 0.5);
    stubPgDump('ok');
    expect(run({ BACKUP_KEEP_DAYS: '2' }).status).toBe(0);
    const left = readdirSync(backups);
    expect(left).not.toContain('db-20201231-000000.dump');
    expect(left).toContain('db-20201201-000000.dump');
  });
});
