import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from '../../features/site/Auth';
import { Main } from '../../features/site/Main';
import { AdminLayout } from '../layout/AdminLayout';
import { CabinetLayout } from '../layout/CabinetLayout';

// Живой режим: вход переживает уход на лендинг, «Выйти» закрывает сессию, регистрация и вход по паролю.
vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { env: { ...actual.env, liveApi: true, pipelineUrl: '/pipeline' } };
});
vi.mock('../state/cabinet', () => ({ useCabinetState: () => null, refreshCabinetState: vi.fn() }));
vi.mock('../../features/consultant/ConsultantWidget', () => ({ ConsultantWidget: () => null }));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const USER = { status: 'OK', userId: 'u-1', email: 'a@b.ru', role: 'user' };

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/" element={<Main />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/onboarding" element={<p>экран онбординга</p>} />
        <Route element={<CabinetLayout />}>
          <Route path="/passport" element={<p>экран паспорта</p>} />
        </Route>
        <Route element={<AdminLayout />}>
          <Route path="/admin-panel/users" element={<p>экран админки</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('сессия не теряется при уходе на лендинг', () => {
  it('вошедшему на лендинге нет «Войти», а «Собрать паспорт» ведёт в кабинет', async () => {
    stubFetch((url) => (url === '/auth/me' ? json(200, USER) : json(404, {})));
    renderApp('/');

    const cta = await screen.findAllByRole('link', { name: 'Собрать паспорт' });
    await vi.waitFor(() => expect(screen.queryByRole('link', { name: 'Войти' })).not.toBeInTheDocument());
    expect(cta[0]).toHaveAttribute('href', '/passport');
  });

  it('без входа на лендинге всё как раньше: «Войти» и «Собрать паспорт» ведут на /auth', async () => {
    stubFetch(() => json(401, { status: 'UNAUTHORIZED' }));
    renderApp('/');

    expect(await screen.findByRole('link', { name: 'Войти' })).toHaveAttribute('href', '/auth');
    expect(screen.getAllByRole('link', { name: 'Собрать паспорт' })[0]).toHaveAttribute('href', '/auth');
  });

  it('вошедший, открыв /auth, сразу попадает в кабинет и форму входа не видит', async () => {
    stubFetch((url) => (url === '/auth/me' ? json(200, USER) : json(404, {})));
    renderApp('/auth');

    expect(await screen.findByText('экран паспорта')).toBeInTheDocument();
    expect(where()).toBe('/passport');
  });

  it('невошедший на /auth видит форму регистрации', async () => {
    stubFetch(() => json(401, { status: 'UNAUTHORIZED' }));
    renderApp('/auth');
    expect(await screen.findByRole('heading', { level: 1, name: 'Создайте аккаунт' })).toBeInTheDocument();
    expect(where()).toBe('/auth');
  });
});

describe('«Выйти» закрывает сессию на сервере', () => {
  it('из кабинета: запрос /auth/logout, затем главная', async () => {
    const fetchMock = stubFetch((url) => (url === '/auth/logout' ? json(200, { status: 'OK' }) : json(404, {})));
    renderApp('/passport');

    await userEvent.click(screen.getByRole('link', { name: 'Выйти' }));

    await vi.waitFor(() => expect(where()).toBe('/'));
    const calls = fetchMock.mock.calls.map(([url]) => url);
    expect(calls).toContain('/auth/logout');
  });

  it('из админки: запрос /auth/logout, затем экран входа', async () => {
    const fetchMock = stubFetch((url) => (url === '/auth/logout' ? json(200, { status: 'OK' }) : json(401, {})));
    renderApp('/admin-panel/users');

    await userEvent.click(screen.getByRole('link', { name: 'Выйти' }));

    await vi.waitFor(() => expect(where()).toBe('/auth'));
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/auth/logout');
  });
});

describe('экран входа и регистрации в живом режиме', () => {
  it('регистрация: почта, пароль, согласие, затем код из письма, затем онбординг', async () => {
    stubFetch((url) => {
      if (url === '/auth/me') return json(401, {});
      if (url === '/auth/code/request') return json(200, { status: 'SENT' });
      if (url === '/auth/code/verify') return json(200, USER);
      return json(404, {});
    });
    renderApp('/auth');

    await userEvent.type(await screen.findByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'correct-horse-1');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await userEvent.type(await screen.findByLabelText('Код из письма'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));

    expect(await screen.findByText('экран онбординга')).toBeInTheDocument();
  });

  it('вход: только почта и пароль, без кода; после входа открывается кабинет', async () => {
    let signedIn = false;
    const fetchMock = stubFetch((url) => {
      if (url === '/auth/me') return signedIn ? json(200, USER) : json(401, {});
      if (url === '/auth/login') {
        signedIn = true;
        return json(200, USER);
      }
      return json(404, {});
    });
    renderApp('/auth');

    await userEvent.click(await screen.findByRole('tab', { name: 'Вход' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'correct-horse-1');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('экран паспорта')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/auth/code/request');
  });

  it('«Забыли пароль?»: почта, новый пароль и код из письма, после чего кабинет', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === '/auth/me') return json(401, {});
      if (url === '/auth/code/request') return json(200, { status: 'SENT' });
      if (url === '/auth/code/verify') return json(200, USER);
      return json(404, {});
    });
    renderApp('/auth');

    await userEvent.click(await screen.findByRole('tab', { name: 'Вход' }));
    await userEvent.click(screen.getByRole('link', { name: 'Забыли пароль?' }));
    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'new-password-2');
    await userEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await userEvent.type(await screen.findByLabelText('Код из письма'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByText('экран паспорта')).toBeInTheDocument();
    const verifyCall = fetchMock.mock.calls.find(([url]) => url === '/auth/code/verify')!;
    expect(JSON.parse(String(verifyCall[1]?.body))).toMatchObject({ password: 'new-password-2', purpose: 'user' });
  });
});
