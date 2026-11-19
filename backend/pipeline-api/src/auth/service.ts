// Вход и регистрация.
// Пользователь: регистрация — email + 6-значный код из письма + пароль (аккаунт создаётся при подтверждении кода);
// дальше вход — email + пароль, без кода. Забытый пароль меняется тем же путём: код из письма + новый пароль.
// Админ: только существующий аккаунт с role = 'admin', вход по коду из письма (роль выдаётся вручную в БД, через API её нельзя поменять).
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import type { SqlClient } from '../db/sql';
import type { MailPort } from '../mail/port';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_COOLDOWN_MS = 60 * 1000;
export const CODES_PER_HOUR = 5;
export const MAX_CODE_ATTEMPTS = 5;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;
/** Неудачных входов по паролю на одну почту за окно, после которых вход временно закрыт. */
export const MAX_LOGIN_FAILURES = 10;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

export type AuthPurpose = 'user' | 'admin';

export interface AuthUser {
  userId: string;
  email: string;
  role: string;
}

export type VerifyResult =
  | ({ ok: true; token: string } & AuthUser)
  | {
      ok: false;
      code: 'INVALID_EMAIL' | 'INVALID_CODE' | 'CODE_EXPIRED' | 'TOO_MANY_ATTEMPTS' | 'NOT_ADMIN' | 'BANNED' | 'WEAK_PASSWORD';
    };

export type LoginResult =
  | ({ ok: true; token: string } & AuthUser)
  | { ok: false; code: 'INVALID_CREDENTIALS' | 'TOO_MANY_ATTEMPTS' | 'BANNED' };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 } as const;

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Хеш пароля: `scrypt$N$r$p$соль$ключ` (всё в base64url/числах). Пароль в базе в открытом виде не хранится. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const key = await scrypt(password, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isAcceptablePassword(password: unknown): password is string {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class AuthService {
  constructor(
    private readonly sql: SqlClient,
    private readonly mail: MailPort,
    /** Секрет для HMAC кодов (AUTH_SECRET). Без него коды не выдаются. */
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!secret) throw new Error('Задайте AUTH_SECRET для входа по коду');
  }

  private codeHash(email: string, purpose: AuthPurpose, code: string): string {
    return createHmac('sha256', this.secret).update(`${email}|${purpose}|${code}`).digest('hex');
  }

  /**
   * Отправляет код. Всегда отвечает одинаково (SENT), чтобы не раскрывать, есть ли аккаунт и не спам ли это:
   * при превышении лимитов или для неизвестного админа письмо просто не уходит.
   */
  async requestCode(rawEmail: string, purpose: AuthPurpose): Promise<'SENT' | 'INVALID_EMAIL'> {
    const email = normalizeEmail(rawEmail);
    if (!email) return 'INVALID_EMAIL';
    const now = this.now();

    const hourly = await this.sql.query(
      `SELECT count(*)::int AS n FROM auth_codes WHERE email = $1 AND created_at > $2::timestamptz`,
      [email, new Date(now.getTime() - 60 * 60 * 1000).toISOString()],
    );
    if (Number(hourly.rows[0]?.n ?? 0) >= CODES_PER_HOUR) return 'SENT';

    const last = await this.sql.query(
      `SELECT created_at FROM auth_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    const lastAt = last.rows[0]?.created_at ? new Date(last.rows[0].created_at).getTime() : 0;
    if (now.getTime() - lastAt < CODE_COOLDOWN_MS) return 'SENT';

    if (purpose === 'admin') {
      const admin = await this.sql.query(
        `SELECT 1 FROM app_profiles WHERE email = $1 AND role = 'admin' AND is_banned = false`,
        [email],
      );
      if (admin.rows.length === 0) return 'SENT';
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    // created_at пишем из того же источника времени, что и проверки (this.now), а не из now() базы.
    await this.sql.query(
      `INSERT INTO auth_codes (email, purpose, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [
        email,
        purpose,
        this.codeHash(email, purpose, code),
        new Date(now.getTime() + CODE_TTL_MS).toISOString(),
        now.toISOString(),
      ],
    );
    await this.mail.send({
      to: email,
      subject: 'Код входа в «Буху»',
      text: `Ваш код: ${code}\n\nКод действует 10 минут. Если вы его не запрашивали, просто проигнорируйте письмо.`,
    });
    return 'SENT';
  }

  /**
   * Проверяет код; при успехе создаёт аккаунт (для user, если его нет) и сессию.
   * Для user нужен пароль: он проверяется до кода (слабый пароль не сжигает код) и сохраняется после подтверждения.
   * Если аккаунт уже есть, пароль заменяется на новый (так работает «Забыли пароль?»), а остальные сессии закрываются.
   */
  async verifyCode(rawEmail: string, code: string, purpose: AuthPurpose, password?: string): Promise<VerifyResult> {
    const email = normalizeEmail(rawEmail);
    if (!email) return { ok: false, code: 'INVALID_EMAIL' };
    if (purpose === 'user' && !isAcceptablePassword(password)) return { ok: false, code: 'WEAK_PASSWORD' };
    const now = this.now();

    const found = await this.sql.query(
      `SELECT id, code_hash, expires_at, attempts FROM auth_codes
        WHERE email = $1 AND purpose = $2 AND consumed = false
        ORDER BY created_at DESC LIMIT 1`,
      [email, purpose],
    );
    const row = found.rows[0];
    if (!row || new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, code: 'CODE_EXPIRED' };
    if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) return { ok: false, code: 'TOO_MANY_ATTEMPTS' };

    await this.sql.query(`UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    const expected = Buffer.from(String(row.code_hash), 'hex');
    const actual = Buffer.from(this.codeHash(email, purpose, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, code: 'INVALID_CODE' };

    await this.sql.query(`UPDATE auth_codes SET consumed = true WHERE id = $1`, [row.id]);

    let profile = await this.findProfile(email);
    let isNewAccount = false;
    if (purpose === 'admin') {
      if (!profile || profile.role !== 'admin') return { ok: false, code: 'NOT_ADMIN' };
    } else if (!profile) {
      profile = await this.createAccount(email);
      isNewAccount = true;
    }
    if (profile.is_banned) return { ok: false, code: 'BANNED' };

    if (purpose === 'user' && password) {
      await this.setPassword(profile.id, password);
      // Пароль сменили через код из письма: старые сессии (возможно, чужие) закрываем.
      if (!isNewAccount) await this.sql.query(`DELETE FROM auth_sessions WHERE user_id = $1::uuid`, [profile.id]);
      await this.sql.query(`DELETE FROM auth_login_failures WHERE email = $1`, [email]);
    }

    const token = await this.createSession(profile.id, now);
    return { ok: true, token, userId: profile.id, email, role: profile.role };
  }

  /**
   * Вход по почте и паролю (без кода). Ошибка всегда одна и та же (INVALID_CREDENTIALS) — по ответу нельзя понять,
   * есть ли такая почта. Админов здесь нет: они входят по коду через отдельный вход (purpose = 'admin').
   */
  async loginWithPassword(rawEmail: string, password: string): Promise<LoginResult> {
    const email = normalizeEmail(rawEmail);
    if (!email || typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }
    const now = this.now();

    const failures = await this.sql.query(
      `SELECT count(*)::int AS n FROM auth_login_failures WHERE email = $1 AND created_at > $2::timestamptz`,
      [email, new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS).toISOString()],
    );
    if (Number(failures.rows[0]?.n ?? 0) >= MAX_LOGIN_FAILURES) return { ok: false, code: 'TOO_MANY_ATTEMPTS' };

    const { rows } = await this.sql.query(
      `SELECT p.id, p.role, p.is_banned, pw.password_hash
         FROM app_profiles p JOIN auth_passwords pw ON pw.user_id = p.id
        WHERE p.email = $1`,
      [email],
    );
    const row = rows[0];
    // Для неизвестной почты всё равно считаем хеш: время ответа не выдаёт, есть ли аккаунт.
    const matches = await verifyPassword(password, row ? String(row.password_hash) : await this.decoyHash());
    if (!row || !matches || row.role === 'admin') {
      await this.sql.query(`INSERT INTO auth_login_failures (email, created_at) VALUES ($1, $2::timestamptz)`, [email, now.toISOString()]);
      return { ok: false, code: 'INVALID_CREDENTIALS' };
    }
    if (row.is_banned) return { ok: false, code: 'BANNED' };

    await this.sql.query(`DELETE FROM auth_login_failures WHERE email = $1`, [email]);
    const token = await this.createSession(row.id, now);
    return { ok: true, token, userId: row.id, email, role: row.role };
  }

  private decoy: Promise<string> | null = null;
  private decoyHash(): Promise<string> {
    this.decoy ??= hashPassword(randomBytes(16).toString('hex'));
    return this.decoy;
  }

  private async setPassword(userId: string, password: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO auth_passwords (user_id, password_hash, updated_at) VALUES ($1::uuid, $2, $3::timestamptz)
       ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at`,
      [userId, await hashPassword(password), this.now().toISOString()],
    );
  }

  private async createSession(userId: string, now: Date): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.sql.query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1, $2::uuid, $3::timestamptz)`,
      [sha256Hex(token), userId, new Date(now.getTime() + SESSION_TTL_MS).toISOString()],
    );
    return token;
  }

  /** Пользователь по токену сессии (cookie). Забаненный и просроченный — null. */
  async userForToken(token: string): Promise<AuthUser | null> {
    const { rows } = await this.sql.query(
      `SELECT p.id, p.email, p.role
         FROM auth_sessions s JOIN app_profiles p ON p.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > $2::timestamptz AND p.is_banned = false`,
      [sha256Hex(token), this.now().toISOString()],
    );
    const r = rows[0];
    return r ? { userId: r.id, email: r.email, role: r.role } : null;
  }

  async logout(token: string): Promise<void> {
    await this.sql.query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [sha256Hex(token)]);
  }

  private async findProfile(email: string): Promise<{ id: string; role: string; is_banned: boolean } | null> {
    const { rows } = await this.sql.query(`SELECT id, role, is_banned FROM app_profiles WHERE email = $1`, [email]);
    return rows[0] ?? null;
  }

  /** Новый аккаунт: строка в auth.users; профиль создаёт триггер handle_new_user (роль всегда 'user'). */
  private async createAccount(email: string): Promise<{ id: string; role: string; is_banned: boolean }> {
    const id = randomUUID();
    await this.sql.query(`INSERT INTO auth.users (id, raw_user_meta_data) VALUES ($1::uuid, '{}'::jsonb)`, [id]);
    await this.sql.query(`UPDATE app_profiles SET email = $2 WHERE id = $1::uuid`, [id, email]);
    return { id, role: 'user', is_banned: false };
  }
}
