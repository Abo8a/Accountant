// Регистрация: почта + код из письма + пароль; дальше вход по почте и паролю без кода. Админ — только существующий admin, по коду.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPipelineServer } from '../src/server';
import { AuthService, CODE_COOLDOWN_MS } from '../src/auth/service';
import type { MailMessage, MailPort } from '../src/mail/port';
import { createTestDb, makeDeps, type TestDb } from './helpers';

class CaptureMail implements MailPort {
  sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastCode(): string {
    const m = this.sent.at(-1)?.text.match(/Ваш код: (\d{6})/);
    if (!m) throw new Error('код не найден в письме');
    return m[1]!;
  }
}

const PASSWORD = 'correct-horse-1';

let db: TestDb;
let mail: CaptureMail;
let auth: AuthService;
let base: string;
let stop: () => Promise<void>;
let clock: { now: Date };

beforeAll(async () => {
  db = await createTestDb();
  clock = { now: new Date('2026-11-17T10:00:00Z') };
  mail = new CaptureMail();
  auth = new AuthService(db.sql, mail, 'test-auth-secret', () => clock.now);
  const server = createPipelineServer(makeDeps(db), { auth: { service: auth, cookieSecure: false } });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  stop = () => new Promise<void>((r) => server.close(() => r()));
});

afterAll(async () => {
  await stop();
});

beforeEach(async () => {
  mail.sent = [];
  clock.now = new Date('2026-11-17T10:00:00Z');
  await db.sql.query('DELETE FROM auth_codes');
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Сдвиг часов больше cooldown, чтобы можно было запросить следующий код.
const later = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));

describe('вход по коду: регистрация и вход пользователя', () => {
  it('новый email: код уходит на почту, после подтверждения создаётся аккаунт и сессия', async () => {
    const email = 'new.student@example.com';
    expect((await post('/auth/code/request', { email })).status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe(email);

    const res = await post('/auth/code/verify', { email, code: mail.lastCode(), password: PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; role: string; email: string; userId: string };
    expect(body).toMatchObject({ status: 'OK', role: 'user', email });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^buha_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);

    const { rows } = await db.sql.query('SELECT role, email FROM app_profiles WHERE id = $1::uuid', [body.userId]);
    expect(rows[0]).toMatchObject({ role: 'user', email });
  });

  it('cookie сессии открывает /auth/me, без неё — 401; после выхода сессия закрыта', async () => {
    const email = 'session.user@example.com';
    await post('/auth/code/request', { email });
    const verify = await post('/auth/code/verify', { email, code: mail.lastCode(), password: PASSWORD });
    const cookie = verify.headers.get('set-cookie')!.split(';')[0]!;

    const me = await fetch(`${base}/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ status: 'OK', email, role: 'user' });

    expect((await fetch(`${base}/auth/me`)).status).toBe(401);

    await post('/auth/logout', {}, { cookie });
    expect((await fetch(`${base}/auth/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('неверный код: 400, после 5 попыток — 429 и код больше не принимается', async () => {
    const email = 'brute@example.com';
    await post('/auth/code/request', { email });
    const real = mail.lastCode();
    const wrong = real === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      const res = await post('/auth/code/verify', { email, code: wrong, password: PASSWORD });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    const blocked = await post('/auth/code/verify', { email, code: real, password: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('просроченный код не принимается', async () => {
    const email = 'late@example.com';
    await post('/auth/code/request', { email });
    const code = mail.lastCode();
    later(11 * 60 * 1000);
    const res = await post('/auth/code/verify', { email, code, password: PASSWORD });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'CODE_EXPIRED' });
  });

  it('повторный запрос раньше cooldown не отправляет второе письмо', async () => {
    const email = 'spam@example.com';
    await post('/auth/code/request', { email });
    await post('/auth/code/request', { email });
    expect(mail.sent).toHaveLength(1);
    later(CODE_COOLDOWN_MS + 1000);
    await post('/auth/code/request', { email });
    expect(mail.sent).toHaveLength(2);
  });

  it('неверный формат email — 400, код не отправляется', async () => {
    const res = await post('/auth/code/request', { email: 'не почта' });
    expect(res.status).toBe(400);
    expect(mail.sent).toHaveLength(0);
  });
});

describe('пароль: регистрация с паролем и вход по почте и паролю без кода', () => {
  async function register(email: string, password = PASSWORD): Promise<string> {
    await post('/auth/code/request', { email });
    const res = await post('/auth/code/verify', { email, code: mail.lastCode(), password });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }

  it('пароль сохраняется хешем, в открытом виде его в базе нет', async () => {
    await register('hash.check@example.com');
    const { rows } = await db.sql.query(
      `SELECT pw.password_hash FROM auth_passwords pw JOIN app_profiles p ON p.id = pw.user_id WHERE p.email = 'hash.check@example.com'`,
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.password_hash)).toMatch(/^scrypt\$/);
    expect(String(rows[0]!.password_hash)).not.toContain(PASSWORD);
  });

  it('слишком короткий пароль при регистрации: 400, код не сгорает и подходит со вторым вводом', async () => {
    const email = 'weak@example.com';
    await post('/auth/code/request', { email });
    const code = mail.lastCode();
    const weak = await post('/auth/code/verify', { email, code, password: '1234567' });
    expect(weak.status).toBe(400);
    expect(await weak.json()).toMatchObject({ code: 'WEAK_PASSWORD' });
    const missing = await post('/auth/code/verify', { email, code });
    expect(missing.status).toBe(400);
    expect((await db.sql.query("SELECT 1 FROM app_profiles WHERE email = 'weak@example.com'")).rows).toHaveLength(0);

    const ok = await post('/auth/code/verify', { email, code, password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('после регистрации вход идёт по почте и паролю, письмо с кодом не отправляется', async () => {
    const email = 'return@example.com';
    await register(email);
    mail.sent = [];

    const res = await post('/auth/login', { email: ' Return@Example.com ', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'OK', email, role: 'user' });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).toMatch(/^buha_session=/);
    expect(mail.sent).toHaveLength(0);

    const me = await fetch(`${base}/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
  });

  it('неверный пароль и неизвестная почта дают один и тот же ответ', async () => {
    await register('known@example.com');
    const wrong = await post('/auth/login', { email: 'known@example.com', password: 'wrong-password' });
    const unknown = await post('/auth/login', { email: 'nobody@example.com', password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const a = await wrong.json();
    const b = await unknown.json();
    expect(a).toEqual(b);
    expect(a).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Неверная почта или пароль' });
    expect(wrong.headers.get('set-cookie')).toBeNull();
  });

  it('после 10 неверных попыток вход по этой почте закрыт на время, потом снова открыт', async () => {
    const email = 'lock@example.com';
    await register(email);
    for (let i = 0; i < 10; i++) {
      expect((await post('/auth/login', { email, password: `wrong-pass-${i}` })).status).toBe(401);
    }
    const locked = await post('/auth/login', { email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });

    later(16 * 60 * 1000);
    expect((await post('/auth/login', { email, password: PASSWORD })).status).toBe(200);
  });

  it('забаненный аккаунт с верным паролем не входит', async () => {
    const email = 'banned@example.com';
    await register(email);
    await db.sql.query("UPDATE app_profiles SET is_banned = true WHERE email = $1", [email]);
    const res = await post('/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'BANNED' });
  });

  it('админ не входит по паролю на пользовательском входе: только по коду админа', async () => {
    const email = 'admin.pw@example.com';
    await register(email);
    await db.sql.query("UPDATE app_profiles SET role = 'admin' WHERE email = $1", [email]);
    const res = await post('/auth/login', { email, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('забытый пароль: код из письма + новый пароль меняют пароль и закрывают старые сессии', async () => {
    const email = 'forgot@example.com';
    const oldCookie = await register(email);

    later(CODE_COOLDOWN_MS + 1000);
    await post('/auth/code/request', { email });
    const res = await post('/auth/code/verify', { email, code: mail.lastCode(), password: 'brand-new-pass-2' });
    expect(res.status).toBe(200);

    expect((await post('/auth/login', { email, password: PASSWORD })).status).toBe(401);
    expect((await post('/auth/login', { email, password: 'brand-new-pass-2' })).status).toBe(200);
    expect((await fetch(`${base}/auth/me`, { headers: { cookie: oldCookie } })).status).toBe(401);
  });

  it('аккаунт без пароля (создан до паролей) входит только через «забыли пароль»', async () => {
    const email = 'legacy@example.com';
    await register(email);
    await db.sql.query("DELETE FROM auth_passwords WHERE user_id = (SELECT id FROM app_profiles WHERE email = $1)", [email]);
    expect((await post('/auth/login', { email, password: PASSWORD })).status).toBe(401);
  });
});

describe('вход администратора: только существующий admin, создать админа через API нельзя', () => {
  it('для обычного пользователя код admin не отправляется и аккаунт не появляется', async () => {
    const res = await post('/auth/code/request', { email: 'intruder@example.com', purpose: 'admin' });
    expect(res.status).toBe(200);
    expect(mail.sent).toHaveLength(0);
    const verify = await post('/auth/code/verify', { email: 'intruder@example.com', code: '123456', purpose: 'admin' });
    expect(verify.status).toBe(400);
    const { rows } = await db.sql.query("SELECT 1 FROM app_profiles WHERE email = 'intruder@example.com'");
    expect(rows).toHaveLength(0);
  });

  it('админ (роль выдана вручную в БД) получает код admin и входит', async () => {
    const email = 'boss@example.com';
    await post('/auth/code/request', { email }); // сначала регистрируется как обычный пользователь
    await post('/auth/code/verify', { email, code: mail.lastCode(), password: PASSWORD });
    await db.sql.query("UPDATE app_profiles SET role = 'admin' WHERE email = $1", [email]); // ручное назначение

    mail.sent = [];
    later(CODE_COOLDOWN_MS + 1000);
    expect((await post('/auth/code/request', { email, purpose: 'admin' })).status).toBe(200);
    expect(mail.sent).toHaveLength(1);

    const res = await post('/auth/code/verify', { email, code: mail.lastCode(), purpose: 'admin' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'OK', role: 'admin' });
  });

  it('код пользователя нельзя использовать для входа админа (purpose разделён)', async () => {
    const email = 'split@example.com';
    await post('/auth/code/request', { email });
    await post('/auth/code/verify', { email, code: mail.lastCode(), password: PASSWORD });
    await db.sql.query("UPDATE app_profiles SET role = 'admin' WHERE email = $1", [email]);

    await post('/auth/code/request', { email }); // код для purpose=user — не вход админа
    later(CODE_COOLDOWN_MS + 1000);
    const res = await post('/auth/code/verify', { email, code: mail.lastCode(), purpose: 'admin' });
    expect(res.status).toBe(400); // нет кода для purpose=admin
  });

  it('роль нельзя поднять через пользовательские маршруты', async () => {
    const email = 'escalate@example.com';
    await post('/auth/code/request', { email });
    const verify = await post('/auth/code/verify', { email, code: mail.lastCode(), password: PASSWORD });
    const cookie = verify.headers.get('set-cookie')!.split(';')[0]!;
    // Тело запроса профиля не должно влиять на роль: маршрута для смены роли нет вовсе.
    const res = await post('/profile', { user_id: (await verify.json() as { userId: string }).userId, role: 'admin', founder: { full_name: 'Иван' } }, { cookie });
    expect(res.status).not.toBe(500);
    const { rows } = await db.sql.query('SELECT role FROM app_profiles WHERE email = $1', [email]);
    expect(rows[0]?.role).toBe('user');
  });
});

describe('защита маршрутов сессией: user_id берётся из входа, а не из запроса', () => {
  // Вход пользователя по коду: возвращает cookie сессии и id аккаунта.
  async function login(email: string): Promise<{ cookie: string; userId: string }> {
    await post('/auth/code/request', { email });
    const res = await post('/auth/code/verify', { email, code: mail.lastCode(), password: PASSWORD });
    const body = (await res.json()) as { userId: string };
    return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, userId: body.userId };
  }

  it('без сессии профиль, пайплайн, экспорт и чат отвечают 401', async () => {
    const someone = '00000000-0000-4000-8000-000000000001';
    expect((await post('/profile', { user_id: someone, founder: { full_name: 'Иван' } })).status).toBe(401);
    expect((await post('/pipeline', { user_id: someone, action: 'init_or_upload', program: 'Студенческий стартап' })).status).toBe(401);
    expect((await post('/export', { user_id: someone, sections: [] })).status).toBe(401);
    expect((await fetch(`${base}/chat?user_id=${someone}`)).status).toBe(401);
  });

  it('профиль с сессией пишется только в аккаунт владельца, подмена user_id в теле игнорируется', async () => {
    const alice = await login('alice.protect@example.com');
    const bob = await login('bob.protect@example.com');

    const res = await post(
      '/profile',
      { user_id: bob.userId, founder: { full_name: 'Алиса Петрова' } },
      { cookie: alice.cookie },
    );
    expect(res.status).toBe(200);

    const { rows } = await db.sql.query(
      'SELECT id, founder_data FROM app_profiles WHERE id IN ($1::uuid, $2::uuid)',
      [alice.userId, bob.userId],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.founder_data]));
    expect(byId[alice.userId]).toMatchObject({ full_name: 'Алиса Петрова' });
    expect(byId[bob.userId]?.full_name).toBeUndefined();
  });

  it('чат с сессией отдаёт историю владельца сессии, а не user_id из query', async () => {
    const carol = await login('carol.protect@example.com');
    const dave = await login('dave.protect@example.com');
    const res = await fetch(`${base}/chat?user_id=${dave.userId}`, { headers: { cookie: carol.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages?: unknown[] };
    expect(body).toBeDefined();
    expect(Array.isArray(body.messages) ? body.messages.length : 0).toBe(0);
  });
});
