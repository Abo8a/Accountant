import { createContext, useCallback, useContext, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { Logo } from '../ui/Logo/Logo';
import { NavIcon } from '../ui/NavIcon/NavIcon';
import type { SideNavItem } from '../ui/SideNav/SideNav';
import '../ui/SideNav/SideNav.css';
import { env } from '../config/env';
import { useSignOut } from '../auth/useSession';
import { useCabinetState } from '../state/cabinet';
import { liveShell } from '../state/cabinetView';
import './CabinetLayout.css';

/** Пока состояние грузится, в живом режиме не показываем пример из макета (чужой проект, «Профессиональный»). */
const LOADING_SHELL = {
  project: { name: '', program: 'Студенческий стартап' },
  plan: { name: '', validUntil: '', files: '', credits: '', fillPercent: 0 },
  user: { name: '', initials: '' },
  gapsCount: null,
};

// Пункты кабинета из user-flows §1 и Passport.dc.html. Раздела «Пробелы» нет: пробелы дорабатываются в блоках паспорта.
export const CABINET_NAV: SideNavItem[] = [
  { to: '/passport', label: 'Паспорт', icon: 'passport' },
  { to: '/result', label: 'Итог', icon: 'result' },
  { to: '/files', label: 'Материалы', icon: 'files' },
  { to: '/billing', label: 'Тариф', icon: 'billing' },
  { to: '/profile', label: 'Профиль', icon: 'profile' },
];

// Меню собрано здесь, а не через SideNav из shared/ui: тому не нужен счётчик, а общие компоненты не меняем.
// Счётчик открытых пробелов показываем у «Паспорта»: пробелы дорабатываются в его блоках (в эталоне счётчик был у «Пробелов»).

export interface CabinetProject {
  name: string;
  program: string;
}

export interface CabinetPlan {
  name: string;
  validUntil: string;
  files: string;
  /** Остаток ИИ-кредитов («ИИ-кредиты: 18»); пусто — строка не выводится. */
  credits?: string;
  /** Заполнение полоски, проценты 0–100. */
  fillPercent: number;
}

export interface CabinetUser {
  initials: string;
  name: string;
}

/** Настройки шелла, которые зависят от экрана. */
export interface CabinetShellSettings {
  /** Счётчик открытых пробелов у пункта «Паспорт». null — счётчик не показывается. */
  gapsCount: number | null;
  /** CSS padding области экрана. */
  mainPadding: string;
  /** CSS gap между блоками экрана. */
  mainGap: string;
  /** Показывать блок тарифа внизу меню. В эталоне Files.dc.html его нет. */
  showPlan: boolean;
}

export interface CabinetLayoutProps {
  project?: Partial<CabinetProject>;
  plan?: Partial<CabinetPlan>;
  user?: Partial<CabinetUser>;
  /** Счётчик пробелов по умолчанию (до переопределения экраном через useCabinetShell). */
  gapsCount?: number | null;
}

// Значения по умолчанию — данные-пример из Passport.dc.html.
// TODO(G3): брать проект, тариф и пользователя из Supabase вместо значений по умолчанию.
const DEFAULT_PROJECT: CabinetProject = { name: 'Monetrix', program: 'Студенческий стартап' };
const DEFAULT_PLAN: CabinetPlan = {
  name: 'Профессиональный',
  validUntil: 'до 1 декабря 2026',
  files: 'Файлы: 3 из 10',
  fillPercent: 30,
};
const DEFAULT_USER: CabinetUser = { initials: 'ИИ', name: 'Иван Иванов' };

// Шелл по умолчанию — как в Passport.dc.html (отступы совпадают с токенами CabinetLayout.css).
const SHELL_DEFAULTS: CabinetShellSettings = {
  gapsCount: 1,
  mainPadding: '28px 32px 56px',
  mainGap: '20px',
  showPlan: true,
};

// Значения по маршруту из эталона Result.dc.html.
// Отступы 36px 48px 64px и зазор 28px вне токенов (значения из inline-стилей эталонов).
// На /result счётчика нет (в Result.dc.html он без счётчика).
const ROUTE_SHELL: Record<string, Partial<CabinetShellSettings>> = {
  '/result': { gapsCount: null, mainPadding: '36px 48px 64px', mainGap: '28px' },
  '/files': { showPlan: false },
  '/billing': { showPlan: false },
  '/profile': { showPlan: false },
};

type ShellSetter = (patch: Partial<CabinetShellSettings>) => void;
const CabinetShellContext = createContext<ShellSetter | null>(null);

/**
 * Экран переопределяет настройки шелла (счётчик пробелов, отступы main) на время своей жизни.
 * При уходе с экрана переопределения сбрасываются, и действуют значения маршрута и по умолчанию.
 */
export function useCabinetShell(settings: Partial<CabinetShellSettings>): void {
  const setShell = useContext(CabinetShellContext);
  const key = JSON.stringify(settings);
  useEffect(() => {
    if (!setShell) return undefined;
    setShell(JSON.parse(key) as Partial<CabinetShellSettings>);
    return () => setShell({});
  }, [setShell, key]);
}

export function CabinetLayout({
  project,
  plan,
  user,
  gapsCount,
}: CabinetLayoutProps = {}) {
  const { pathname } = useLocation();
  const signOut = useSignOut('/');
  const [overrides, setOverrides] = useState<Partial<CabinetShellSettings>>({});
  const setShell = useCallback<ShellSetter>((patch) => setOverrides(patch), []);
  const contextValue = useMemo(() => setShell, [setShell]);

  // Живой режим: проект, тариф, пользователь и счётчик пробелов — из состояния пользователя, а не пример из макета
  const cabinet = useCabinetState();
  const live = env.liveApi ? (cabinet ? liveShell(cabinet) : LOADING_SHELL) : null;
  const p = { ...DEFAULT_PROJECT, ...live?.project, ...project };
  const pl = { ...DEFAULT_PLAN, ...live?.plan, ...plan };
  const u = { ...DEFAULT_USER, ...live?.user, ...user };
  const shell: CabinetShellSettings = {
    ...SHELL_DEFAULTS,
    ...(live ? { gapsCount: live.gapsCount } : {}),
    ...(gapsCount !== undefined ? { gapsCount } : {}),
    ...ROUTE_SHELL[pathname],
    ...overrides,
  };
  const mainStyle = {
    '--cabinet-main-padding': shell.mainPadding,
    '--cabinet-main-gap': shell.mainGap,
  } as CSSProperties;

  return (
    <CabinetShellContext.Provider value={contextValue}>
      <div className="cabinet">
        <aside className="cabinet__aside">
          <Logo variant="cabinet" to="/" ariaLabel="Буха — на главную" />

          <div className="cabinet__card">
            <span className="cabinet__caption">Проект</span>
            <span className="cabinet__project-name">{p.name}</span>
            <span className="cabinet__meta">{p.program}</span>
          </div>

          <nav aria-label="Разделы кабинета" className="sidenav sidenav--light">
            {CABINET_NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className="sidenav__link">
                <NavIcon name={item.icon} />
                <span className="sidenav__label">{item.label}</span>
                {item.icon === 'passport' && shell.gapsCount !== null && (
                  <span className="cabinet__badge" aria-hidden="true">{shell.gapsCount}</span>
                )}
              </NavLink>
            ))}
          </nav>

          {shell.showPlan && (
          <div className="cabinet__card cabinet__plan">
            <span className="cabinet__plan-name">{pl.name}</span>
            <span className="cabinet__meta">{pl.validUntil}</span>
            {pl.credits && <span className="cabinet__meta">{pl.credits}</span>}
            <span className="cabinet__meta">{pl.files}</span>
            <span className="cabinet__bar" aria-hidden="true">
              <span className="cabinet__bar-fill" style={{ width: `${pl.fillPercent}%` }} />
            </span>
          </div>
          )}

          <div className="cabinet__user">
            <span className="cabinet__avatar" aria-hidden="true">{u.initials}</span>
            <span className="cabinet__user-name">{u.name}</span>
            <Link to="/" className="cabinet__logout" onClick={signOut}>Выйти</Link>
          </div>
        </aside>

        <main className="cabinet__main" style={mainStyle}>
          <Outlet />
        </main>
      </div>
    </CabinetShellContext.Provider>
  );
}
