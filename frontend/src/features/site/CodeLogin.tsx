import { useState, type FormEvent } from 'react';
import { requestCode, verifyCode, type AuthPurpose, type CurrentUser } from '../../shared/api/auth';
import { Button } from '../../shared/ui';
import { AuthField } from './AuthField';

// Два шага: почта → 6-значный код из письма.
// Регистрация пользователя (withPassword): на первом шаге ещё пароль, он уходит на сервер вместе с кодом.
// Тот же путь (без согласия) меняет забытый пароль: код из письма подтверждает, что почта ваша.
// Для админки используется тот же компонент с purpose = 'admin' и без пароля: сервер пускает только role = 'admin'.

export const MIN_PASSWORD_LENGTH = 8;

export interface CodeLoginProps {
  purpose: AuthPurpose;
  onSuccess: (user: CurrentUser) => void;
  /** Показать согласие с условиями (регистрация). Без согласия код не запрашивается. */
  consent?: boolean;
  /** Спросить пароль на первом шаге (регистрация и смена пароля пользователя). */
  withPassword?: boolean;
  submitLabel?: string;
}

export function CodeLogin({ purpose, onSuccess, consent = false, withPassword = false, submitLabel = 'Войти' }: CodeLoginProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [agreed, setAgreed] = useState(!consent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agreed) return;
    if (withPassword && password.length < MIN_PASSWORD_LENGTH) {
      setError('Пароль не короче 8 символов');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await requestCode(email.trim(), purpose);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setStep('code');
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('Введите 6 цифр из письма');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await verifyCode(email.trim(), code, purpose, withPassword ? password : undefined);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSuccess(result.value);
  }

  if (step === 'email') {
    return (
      <form className="auth__stack" onSubmit={sendCode} noValidate>
        <AuthField
          id={`${purpose}-email`}
          label="Электронная почта"
          type="email"
          autoComplete="email"
          placeholder="name@university.ru"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {withPassword && (
          <AuthField
            id={`${purpose}-password`}
            label="Пароль"
            type="password"
            autoComplete="new-password"
            placeholder="Не меньше 8 символов"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        )}
        {consent && (
          <label className="auth__consent">
            <input type="checkbox" className="auth__checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              Согласен с <a href="#">условиями сервиса</a> и <a href="#">обработкой персональных данных</a>, в том числе с передачей текстов проекта языковой модели для разбора
            </span>
          </label>
        )}
        {error && <p role="alert" className="auth__hint">{error}</p>}
        <Button type="submit" variant="primary" disabled={busy || !agreed}>
          Получить код
        </Button>
      </form>
    );
  }

  return (
    <form className="auth__stack" onSubmit={confirm} noValidate>
      <div className="auth__field">
        <label htmlFor={`${purpose}-code`} className="auth__label">
          Код из письма
        </label>
        <input
          id={`${purpose}-code`}
          className="auth__input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="6 цифр"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          required
        />
      </div>
      <p className="auth__hint">Код отправлен на {email.trim()}. Он действует 10 минут.</p>
      {error && <p role="alert" className="auth__hint">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy}>
        {submitLabel}
      </Button>
      <Button type="button" variant="outline" onClick={() => { setStep('email'); setCode(''); setError(null); }}>
        Другой адрес или новый код
      </Button>
    </form>
  );
}
