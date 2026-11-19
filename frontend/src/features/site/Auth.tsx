import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { PillLink, SegmentedControl } from '../../shared/ui';
import { SiteBrand } from '../../shared/layout/SiteLayout';
import { env } from '../../shared/config/env';
import { useSessionState } from '../../shared/auth/useSession';
import { Mascot } from './SiteArt';
import { AuthField as Field } from './AuthField';
import { CodeLogin } from './CodeLogin';
import { PasswordLogin } from './PasswordLogin';
import './Auth.css';

// Вход и регистрация: design/project/Auth.dc.html. Тексты дословно из эталона.
// Экран без шапки и подвала: слева форма, справа оранжевая панель с шагами.

type Mode = 'signup' | 'login';

const MODE_OPTIONS = [
  { id: 'signup', label: 'Регистрация' },
  { id: 'login', label: 'Вход' },
];

const STEPS = [
  'Заполните профиль основателя',
  'Расскажите об идее или загрузите презентацию',
  'Ответьте на вопросы по пробелам',
];

function SignupForm() {
  return (
    <div className="auth__stack">
      <div className="auth__heading">
        <h1 className="t-screen-title">Создайте аккаунт</h1>
      </div>
      <Field id="su-email" label="Электронная почта" type="email" placeholder="name@university.ru" />
      <Field id="su-pass" label="Пароль" type="password" placeholder="Не меньше 8 символов" />
      <label className="auth__consent">
        <input type="checkbox" defaultChecked className="auth__checkbox" />
        <span>
          Согласен с <a href="#">условиями сервиса</a> и <a href="#">обработкой персональных данных</a>, в том числе с передачей текстов проекта языковой модели для разбора
        </span>
      </label>
      <PillLink to="/onboarding" variant="brand" size="md">Зарегистрироваться</PillLink>
    </div>
  );
}

function LoginForm() {
  return (
    <div className="auth__stack">
      <h1 className="t-screen-title">С возвращением</h1>
      <Field id="li-email" label="Электронная почта" type="email" defaultValue="ivan@university.ru" />
      <Field
        id="li-pass"
        label="Пароль"
        type="password"
        defaultValue="password123"
        aside={<a href="#" className="auth__aside-link">Забыли пароль?</a>}
      />
      <PillLink to="/passport" variant="brand" size="md">Войти</PillLink>
      <div className="auth__proto">
        <span className="auth__proto-title">Для прототипа</span>
        <Link to="/states" className="auth__proto-link">Аккаунт заблокирован (экран 403)</Link>
      </div>
    </div>
  );
}

export function Auth() {
  const [mode, setMode] = useState<Mode>('signup');
  // «Забыли пароль?» на вкладке «Вход»: тот же путь, что и регистрация (почта, пароль, код из письма), только без согласия.
  const [resetting, setResetting] = useState(false);
  const navigate = useNavigate();
  const session = useSessionState();

  // Уже вошли (например, вернулись с лендинга по логотипу): заново входить не нужно, ведём в кабинет.
  if (session === 'in') return <Navigate to="/passport" replace />;

  return (
    <div className="auth">
      <div className="auth__form-side">
        <SiteBrand className="auth__brand" />

        <div className="auth__form">
          <SegmentedControl
            mode="tabs"
            block
            ariaLabel="Вход или регистрация"
            options={MODE_OPTIONS}
            value={mode}
            onChange={(id) => {
              setMode(id as Mode);
              setResetting(false);
            }}
          />
          {env.liveApi ? (
            <div className="auth__stack" key={`${mode}-${resetting}`}>
              <div className="auth__heading">
                <h1 className="t-screen-title">{mode === 'signup' ? 'Создайте аккаунт' : 'С возвращением'}</h1>
              </div>
              {mode === 'signup' ? (
                <CodeLogin
                  purpose="user"
                  consent
                  withPassword
                  submitLabel="Зарегистрироваться"
                  onSuccess={() => navigate('/onboarding', { replace: true })}
                />
              ) : resetting ? (
                <CodeLogin purpose="user" withPassword submitLabel="Войти" onSuccess={() => navigate('/passport', { replace: true })} />
              ) : (
                <PasswordLogin onSuccess={() => navigate('/passport', { replace: true })} onForgot={() => setResetting(true)} />
              )}
            </div>
          ) : mode === 'signup' ? (
            <SignupForm />
          ) : (
            <LoginForm />
          )}
        </div>
      </div>

      <div className="auth__panel">
        <Mascot size={148} variant="tile" />
        <h2 className="auth__panel-title">Через 10 минут у вас будет черновик паспорта</h2>
        <ul className="auth__steps">
          {STEPS.map((step, index) => (
            <li key={step} className="auth__step">
              <span className="auth__step-num">{index + 1}</span>
              {step}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
