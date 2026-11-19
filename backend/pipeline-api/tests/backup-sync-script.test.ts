// deploy/backup-sync.sh: выгрузка копий в B2 с шифрованием. rclone подменён заглушкой, которая записывает вызовы и переменные окружения.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', '..', '..', 'deploy', 'backup-sync.sh');
const hasSh = spawnSync('sh', ['-c', 'true']).status === 0;
const posix = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`);

// Значения-приманки: ни одно из них не должно появиться в выводе скрипта.
const SECRETS = {
  BACKUP_S3_KEY_ID: '005keyid000000001',
  BACKUP_S3_APPLICATION_KEY: 'K005appkeySECRET/xyz',
  BACKUP_ENCRYPTION_PASSWORD: 'pass-SECRET-123',
  BACKUP_ENCRYPTION_SALT: 'salt-SECRET-456',
};
const CONFIG = {
  BACKUP_S3_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
  BACKUP_S3_REGION: 'us-east-005',
  BACKUP_S3_BUCKET: 'buha-backups',
  ...SECRETS,
};

let root: string;
let backups: string;
let stub: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'buha-sync-'));
  backups = join(root, 'backups');
  mkdirSync(backups);
  stub = join(root, 'rclone_stub.sh');
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      `echo "$@" >> "${posix(root)}/calls.txt"`,
      `env | grep '^RCLONE_CONFIG_' | sort > "${posix(root)}/env.txt"`,
      'case "$1" in',
      '  obscure) printf "OBS(%s)" "$(cat)" ;;',
      '  copy) exit ${STUB_COPY_RC:-0} ;;',
      '  check) exit ${STUB_CHECK_RC:-0} ;;',
      '  lsl) echo "1234 2026-11-19 db-20261119-120000.dump" ;;',
      'esac',
      '',
    ].join('\n'),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[] = [], env: Record<string, string | undefined> = CONFIG, extra: { cwd?: string } = {}) {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('BACKUP_') || k.startsWith('STUB_')) delete base[k];
  return spawnSync('sh', [posix(SCRIPT), ...args], {
    encoding: 'utf8',
    cwd: extra.cwd,
    env: { ...base, BACKUP_ONCE: '1', BACKUP_DIR: posix(backups), RCLONE: `sh ${posix(stub)}`, ...env } as NodeJS.ProcessEnv,
  });
}

const calls = () => (existsSync(join(root, 'calls.txt')) ? readFileSync(join(root, 'calls.txt'), 'utf8').trim().split('\n') : []);
const envDump = () => readFileSync(join(root, 'env.txt'), 'utf8');
const output = (r: ReturnType<typeof run>) => `${r.stdout}\n${r.stderr}`;

describe.skipIf(!hasSh)('deploy/backup-sync.sh', () => {
  it('без настроек B2 ничего не отправляет и пишет, чего не хватает; для разовой проверки это не ошибка', () => {
    const res = run([], {});
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('выгрузка в B2 не настроена');
    for (const name of ['BACKUP_S3_ENDPOINT', 'BACKUP_S3_BUCKET', 'BACKUP_S3_KEY_ID', 'BACKUP_S3_APPLICATION_KEY', 'BACKUP_ENCRYPTION_PASSWORD']) {
      expect(res.stdout).toContain(name);
    }
    expect(calls()).toEqual([]);
  });

  it('нет пароля шифрования — выгрузка не стартует (в открытом виде копии не уходят), в логе только имя переменной', () => {
    const { BACKUP_ENCRYPTION_PASSWORD: _omit, ...withoutPassword } = CONFIG;
    const res = run([], withoutPassword);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/не заданы: BACKUP_ENCRYPTION_PASSWORD\s*$/m);
    expect(res.stdout).not.toContain('BACKUP_S3_BUCKET');
    expect(calls()).toEqual([]);
  });

  it('настроено: пароли обфусцируются через stdin, затем копируются только готовые копии и проверяется результат', () => {
    const res = run();
    expect(res.status, output(res)).toBe(0);

    const all = calls();
    expect(all[0]).toBe('obscure -');
    expect(all[1]).toBe('obscure -');
    expect(all[2]).toBe(`copy ${posix(backups)} bcrypt: --include db-*.dump --include uploads-*.tgz --stats 0 --log-level NOTICE`);
    expect(all[3]).toBe(`check ${posix(backups)} bcrypt: --one-way --size-only --include db-*.dump --include uploads-*.tgz --log-level NOTICE`);
    expect(all).toHaveLength(4);
    expect(res.stdout).toContain('готово: копии');
  });

  it('конфигурация rclone: S3-доступ к B2 и слой шифрования поверх бакета, имена файлов не шифруются', () => {
    run();
    const env = envDump();
    expect(env).toContain('RCLONE_CONFIG_B2S3_TYPE=s3');
    expect(env).toContain('RCLONE_CONFIG_B2S3_ENDPOINT=https://s3.us-east-005.backblazeb2.com');
    expect(env).toContain('RCLONE_CONFIG_B2S3_REGION=us-east-005');
    expect(env).toContain(`RCLONE_CONFIG_B2S3_ACCESS_KEY_ID=${SECRETS.BACKUP_S3_KEY_ID}`);
    expect(env).toContain(`RCLONE_CONFIG_B2S3_SECRET_ACCESS_KEY=${SECRETS.BACKUP_S3_APPLICATION_KEY}`);
    expect(env).toContain('RCLONE_CONFIG_B2S3_NO_CHECK_BUCKET=true');
    expect(env).toContain('RCLONE_CONFIG_BCRYPT_TYPE=crypt');
    expect(env).toContain('RCLONE_CONFIG_BCRYPT_REMOTE=b2s3:buha-backups/backups');
    expect(env).toContain('RCLONE_CONFIG_BCRYPT_FILENAME_ENCRYPTION=off');
    expect(env).toContain('RCLONE_CONFIG_BCRYPT_DIRECTORY_NAME_ENCRYPTION=false');
    // В rclone уходит обфусцированный пароль, а не исходный.
    expect(env).toContain('RCLONE_CONFIG_BCRYPT_PASSWORD=OBS(pass-SECRET-123)');
    expect(env).toContain('RCLONE_CONFIG_BCRYPT_PASSWORD2=OBS(salt-SECRET-456)');
  });

  it('соль необязательна: без неё PASSWORD2 не задаётся', () => {
    const { BACKUP_ENCRYPTION_SALT: _omit, ...noSalt } = CONFIG;
    expect(run([], noSalt).status).toBe(0);
    expect(envDump()).toContain('RCLONE_CONFIG_BCRYPT_PASSWORD=OBS(pass-SECRET-123)');
    expect(envDump()).not.toContain('PASSWORD2');
    expect(calls().filter((c) => c === 'obscure -')).toHaveLength(1);
  });

  it('ключи, пароль и соль не попадают в вывод скрипта ни при успехе, ни при сбое', () => {
    const ok = output(run());
    const failed = output(run([], { ...CONFIG, STUB_COPY_RC: '1' }));
    for (const text of [ok, failed]) {
      for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
    }
  });

  it('сбой выгрузки: код 1, сверка не запускается, в логе ошибка', () => {
    const res = run([], { ...CONFIG, STUB_COPY_RC: '1' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('ОШИБКА: выгрузка не удалась');
    expect(calls().some((c) => c.startsWith('check'))).toBe(false);
  });

  it('сверка нашла расхождение: код 1 и ошибка в логе', () => {
    const res = run([], { ...CONFIG, STUB_CHECK_RC: '1' });
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('ОШИБКА: после выгрузки копии в бакете не совпали с локальными');
  });

  it('шаблоны db-*.dump не раскрываются шеллом по файлам текущей папки', () => {
    const cwd = join(root, 'cwd');
    mkdirSync(cwd);
    writeFileSync(join(cwd, 'db-leaked.dump'), 'x');
    expect(run([], CONFIG, { cwd }).status).toBe(0);
    expect(calls()[2]).toContain('--include db-*.dump --include uploads-*.tgz');
    expect(calls().join('\n')).not.toContain('db-leaked.dump');
  });

  it('list показывает содержимое бакета через слой шифрования', () => {
    const res = run(['list']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('db-20261119-120000.dump');
    expect(calls().at(-1)).toBe('lsl bcrypt: --log-level NOTICE');
  });

  it('fetch скачивает и расшифровывает один файл в указанную папку', () => {
    const dest = join(root, 'restore');
    const res = run(['fetch', 'db-20261119-120000.dump', posix(dest)]);
    expect(res.status, output(res)).toBe(0);
    expect(existsSync(dest)).toBe(true);
    expect(calls().at(-1)).toBe(`copy bcrypt:db-20261119-120000.dump ${posix(dest)} --log-level NOTICE`);
  });

  it('fetch и list без настроек — ошибка (нечем расшифровывать), fetch без аргументов — подсказка и код 2', () => {
    expect(run(['list'], {}).status).toBe(1);
    expect(run(['fetch', 'a.dump', posix(join(root, 'x'))], {}).status).toBe(1);
    const noArgs = run(['fetch']);
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toContain('Использование');
  });

  it('неизвестный режим — код 2', () => {
    expect(run(['wipe']).status).toBe(2);
  });
});
