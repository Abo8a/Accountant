import { useState, type FormEvent } from 'react';
import { loginWithPassword, type CurrentUser } from '../../shared/api/auth';
import { Button } from '../../shared/ui';
import { AuthField } from './AuthField';

// Вход после регистрации: почта и пароль, без кода из письма (design/project/Auth.dc.html, вкладка «Вход»).

export interface PasswordLoginProps {
  onSuccess: (user: CurrentUser) => void;
  /** «Забыли пароль?»: открывает смену пароля по коду из письма. */
  onForgot: () => void;
}

export function PasswordLogin({ onSuccess, onForgot }: PasswordLoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await loginWithPassword(email.trim(), password);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSuccess(result.value);
  }

  return (
    <form className="auth__stack" onSubmit={submit} noValidate>
      <AuthField
        id="login-email"
        label="Электронная почта"
        type="email"
        autoComplete="email"
        placeholder="name@university.ru"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <AuthField
        id="login-password"
        label="Пароль"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aside={
          <a
            href="#"
            className="auth__aside-link"
            onClick={(e) => {
              e.preventDefault();
              onForgot();
            }}
          >
            Забыли пароль?
          </a>
        }
        required
      />
      {error && <p role="alert" className="auth__hint">{error}</p>}
      <Button type="submit" variant="primary" disabled={busy || email.trim() === '' || password === ''}>
        Войти
      </Button>
    </form>
  );
}
