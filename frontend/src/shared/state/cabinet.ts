import { useEffect, useState } from 'react';
import { fetchCabinetState, type CabinetState } from '../api/cabinet';
import { env } from '../config/env';

// Общее состояние кабинета в живом режиме: один запрос на все экраны, обновление после изменений (ответ, справка).
// В демо-режиме (без VITE_PIPELINE_URL) состояние не запрашивается: экраны показывают пример из макета.

let cached: CabinetState | null = null;
let inflight: Promise<CabinetState | null> | null = null;
const listeners = new Set<(s: CabinetState | null) => void>();

function publish(next: CabinetState | null) {
  cached = next;
  for (const l of listeners) l(next);
}

/** Перечитывает состояние с бэкенда (после ответа на пробел, загрузки справки и т. п.). */
export function refreshCabinetState(): Promise<CabinetState | null> {
  if (!env.liveApi) return Promise.resolve(null);
  inflight ??= fetchCabinetState().then((s) => {
    inflight = null;
    publish(s);
    return s;
  });
  return inflight;
}

/** Только для тестов: сбросить кэш между сценариями. */
export function resetCabinetState(): void {
  cached = null;
  inflight = null;
}

/** Состояние кабинета: undefined — ещё грузится, null — недоступно (демо-режим или нет сессии). */
export function useCabinetState(): CabinetState | null | undefined {
  const [state, setState] = useState<CabinetState | null | undefined>(env.liveApi ? (cached ?? undefined) : null);
  useEffect(() => {
    if (!env.liveApi) return undefined;
    listeners.add(setState);
    if (!cached) void refreshCabinetState();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
