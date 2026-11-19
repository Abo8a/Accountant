import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchMe, logout } from '../api/auth';
import { env } from '../config/env';

export type SessionState = 'checking' | 'in' | 'out';

// Есть ли вход (cookie сессии живёт 30 дней и переживает переходы по сайту, в том числе на лендинг).
// Публичные страницы по этому состоянию ведут вошедшего в кабинет, а не заставляют входить заново.
// В демо-режиме (без живого API) входа нет: всегда 'out', запросов не делаем.
export function useSessionState(): SessionState {
  const [state, setState] = useState<SessionState>(env.liveApi ? 'checking' : 'out');

  useEffect(() => {
    if (!env.liveApi) return;
    let cancelled = false;
    fetchMe().then((user) => {
      if (!cancelled) setState(user ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

// «Выйти»: закрывает сессию на сервере (cookie гасит ответ сервера) и только потом уходит на страницу `to`.
// Раньше «Выйти» просто вело по ссылке, и сессия оставалась живой. Теперь, когда лендинг помнит вход, это важно.
export function useSignOut(to: string) {
  const navigate = useNavigate();
  return useCallback(
    async (event: MouseEvent) => {
      event.preventDefault();
      if (env.liveApi) await logout();
      navigate(to);
    },
    [navigate, to],
  );
}
