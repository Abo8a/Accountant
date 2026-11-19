import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeLogin } from '../../features/site/CodeLogin';
import { PasswordLogin } from '../../features/site/PasswordLogin';
import { AdminGate } from '../../features/admin/AdminGate';
import { RequireSession } from './RequireSession';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('вход по коду (CodeLogin)', () => {
  it('почта → код из письма → успешный вход отдаёт пользователя наверх', async () => {
    const onSuccess = vi.fn();
    stubFetch((url) => {
      if (url === '/auth/code/request') return json(200, { status: 'SENT' });
      if (url === '/auth/code/verify') return json(200, { status: 'OK', userId: 'u-1', email: 'a@b.ru', role: 'user' });
      return json(404, {});
    });
    render(<CodeLogin purpose="user" onSuccess={onSuccess} />);

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await userEvent.type(await screen.findByLabelText('Код из письма'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(onSuccess).toHaveBeenCalledWith({ userId: 'u-1', email: 'a@b.ru', role: 'user' });
  });

  it('неверный код показывает сообщение от сервера и не пускает дальше', async () => {
    const onSuccess = vi.fn();
    stubFetch((url) => {
      if (url === '/auth/code/request') return json(200, { status: 'SENT' });
      return json(400, { status: 'ERROR', code: 'INVALID_CODE', message: 'Неверный код' });
    });
    render(<CodeLogin purpose="user" onSuccess={onSuccess} />);

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await userEvent.type(await screen.findByLabelText('Код из письма'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный код');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('при согласии на регистрацию без галочки код не запрашивается', async () => {
    const fetchMock = stubFetch(() => json(200, { status: 'SENT' }));
    render(<CodeLogin purpose="user" consent onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    expect(screen.getByRole('button', { name: 'Получить код' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('регистрация с паролем (CodeLogin withPassword)', () => {
  it('почта + пароль → код из письма: пароль уходит на сервер вместе с кодом', async () => {
    const onSuccess = vi.fn();
    const fetchMock = stubFetch((url) => {
      if (url === '/auth/code/request') return json(200, { status: 'SENT' });
      if (url === '/auth/code/verify') return json(200, { status: 'OK', userId: 'u-1', email: 'a@b.ru', role: 'user' });
      return json(404, {});
    });
    render(<CodeLogin purpose="user" consent withPassword submitLabel="Зарегистрироваться" onSuccess={onSuccess} />);

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'correct-horse-1');
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await userEvent.type(await screen.findByLabelText('Код из письма'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Зарегистрироваться' }));

    expect(onSuccess).toHaveBeenCalledWith({ userId: 'u-1', email: 'a@b.ru', role: 'user' });
    const verifyCall = fetchMock.mock.calls.find(([url]) => url === '/auth/code/verify')!;
    expect(JSON.parse(String(verifyCall[1]?.body))).toEqual({ email: 'a@b.ru', code: '123456', purpose: 'user', password: 'correct-horse-1' });
    // Пароль не уходит на запрос кода: он нужен только при подтверждении.
    const requestCall = fetchMock.mock.calls.find(([url]) => url === '/auth/code/request')!;
    expect(JSON.parse(String(requestCall[1]?.body))).toEqual({ email: 'a@b.ru', purpose: 'user' });
  });

  it('пароль короче 8 символов: код не запрашивается, показана подсказка', async () => {
    const fetchMock = stubFetch(() => json(200, { status: 'SENT' }));
    render(<CodeLogin purpose="user" withPassword onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), '1234567');
    await userEvent.click(screen.getByRole('button', { name: 'Получить код' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Пароль не короче 8 символов');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('вход админа (purpose = admin) без пароля: поля пароля нет, на сервер пароль не уходит', async () => {
    const fetchMock = stubFetch((url) => {
      if (url === '/auth/code/request') return json(200, { status: 'SENT' });
      return json(200, { status: 'OK', userId: 'u-9', email: 'boss@b.ru', role: 'admin' });
    });
    render(<CodeLogin purpose="admin" onSuccess={vi.fn()} />);
    expect(screen.queryByLabelText('Пароль')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'boss@b.ru');
    await userEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await userEvent.type(await screen.findByLabelText('Код из письма'), '654321');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    const verifyCall = fetchMock.mock.calls.find(([url]) => url === '/auth/code/verify')!;
    expect(JSON.parse(String(verifyCall[1]?.body))).toEqual({ email: 'boss@b.ru', code: '654321', purpose: 'admin' });
  });
});

describe('вход по паролю (PasswordLogin)', () => {
  it('почта + пароль → сессия, без запроса кода', async () => {
    const onSuccess = vi.fn();
    const fetchMock = stubFetch((url) =>
      url === '/auth/login' ? json(200, { status: 'OK', userId: 'u-1', email: 'a@b.ru', role: 'user' }) : json(404, {}),
    );
    render(<PasswordLogin onSuccess={onSuccess} onForgot={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'correct-horse-1');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(onSuccess).toHaveBeenCalledWith({ userId: 'u-1', email: 'a@b.ru', role: 'user' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ email: 'a@b.ru', password: 'correct-horse-1' });
  });

  it('неверный пароль: сообщение сервера, наверх ничего не уходит', async () => {
    const onSuccess = vi.fn();
    stubFetch(() => json(401, { status: 'ERROR', code: 'INVALID_CREDENTIALS', message: 'Неверная почта или пароль' }));
    render(<PasswordLogin onSuccess={onSuccess} onForgot={vi.fn()} />);

    await userEvent.type(screen.getByLabelText('Электронная почта'), 'a@b.ru');
    await userEvent.type(screen.getByLabelText('Пароль'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Неверная почта или пароль');
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('«Забыли пароль?» вызывает onForgot и не отправляет форму', async () => {
    const onForgot = vi.fn();
    const fetchMock = stubFetch(() => json(200, {}));
    render(<PasswordLogin onSuccess={vi.fn()} onForgot={onForgot} />);

    await userEvent.click(screen.getByRole('link', { name: 'Забыли пароль?' }));
    expect(onForgot).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('пока почта или пароль пустые, «Войти» недоступна', () => {
    stubFetch(() => json(200, {}));
    render(<PasswordLogin onSuccess={vi.fn()} onForgot={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Войти' })).toBeDisabled();
  });
});

describe('защита кабинета (RequireSession)', () => {
  it('без сессии отправляет на /auth', async () => {
    stubFetch(() => json(401, { status: 'UNAUTHORIZED' }));
    render(
      <MemoryRouter initialEntries={['/passport']}>
        <Routes>
          <Route path="/passport" element={<RequireSession><p>кабинет</p></RequireSession>} />
          <Route path="/auth" element={<p>экран входа</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('экран входа')).toBeInTheDocument();
    expect(screen.queryByText('кабинет')).not.toBeInTheDocument();
  });

  it('с сессией показывает кабинет', async () => {
    stubFetch(() => json(200, { status: 'OK', userId: 'u-1', email: 'a@b.ru', role: 'user' }));
    render(
      <MemoryRouter initialEntries={['/passport']}>
        <Routes>
          <Route path="/passport" element={<RequireSession><p>кабинет</p></RequireSession>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('кабинет')).toBeInTheDocument();
  });
});

describe('вход в админку (AdminGate)', () => {
  it('обычный пользователь видит форму входа админа и не видит админку', async () => {
    stubFetch(() => json(200, { status: 'OK', userId: 'u-1', email: 'a@b.ru', role: 'user' }));
    render(
      <MemoryRouter>
        <AdminGate>
          <p>секретная админка</p>
        </AdminGate>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Вход администратора' })).toBeInTheDocument();
    expect(screen.queryByText('секретная админка')).not.toBeInTheDocument();
  });

  it('аккаунт с role = admin открывает админку сразу', async () => {
    stubFetch(() => json(200, { status: 'OK', userId: 'u-9', email: 'boss@b.ru', role: 'admin' }));
    render(
      <MemoryRouter>
        <AdminGate>
          <p>секретная админка</p>
        </AdminGate>
      </MemoryRouter>,
    );
    expect(await screen.findByText('секретная админка')).toBeInTheDocument();
  });
});
