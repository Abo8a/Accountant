import type { PipelinePassportField } from '@passport/contracts';
import type { CabinetState } from '../api/cabinet';
import { PLANS } from '../data/plans';

// Данные шапки и меню кабинета из состояния пользователя (живой режим). Чистые функции — их проверяют тесты.

/** Необязательные поля паспорта: не считаются пробелом. */
const OPTIONAL = new Set(['4/tech_challenge']);

/** Пробелы паспорта: пустое обязательное поле или поле с замечанием. */
export function openGapsCount(passport: readonly PipelinePassportField[]): number {
  return passport.filter((f) => !OPTIONAL.has(`${f.section_id}/${f.field_key}`) && (!f.value?.trim() || f.review_status === 'needs_review')).length;
}

/** «до 1 декабря 2026» для оплаченного тарифа; пусто для бесплатного. */
export function formatPlanUntil(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `до ${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '')}`;
}

/** Название проекта для шапки: суть продукта из блока 4 (первая фраза, до 40 знаков). Пока её нет — «Мой проект». */
export function projectTitle(passport: readonly PipelinePassportField[]): string {
  const summary = passport.find((f) => f.section_id === 4 && f.field_key === 'product_summary')?.value?.trim();
  if (!summary) return 'Мой проект';
  const first = summary.split(/(?<=[.!?])\s|[,;:—(]/)[0].trim();
  return first.length > 40 ? `${first.slice(0, 39).trimEnd()}…` : first;
}

/** «Иванов Иван» и «ИИ» из ФИО (фамилия, имя, отчество). */
export function userBadge(fullName: string | undefined): { name: string; initials: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { name: 'Профиль', initials: '·' };
  const name = parts.slice(0, 2).join(' ');
  const initials = parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  return { name, initials };
}

export function liveShell(state: CabinetState) {
  const plan = PLANS.find((p) => p.id === state.plan_id) ?? PLANS[0]!;
  const limit = state.files_limit;
  return {
    project: { name: projectTitle(state.passport), program: 'Студенческий стартап' },
    plan: {
      name: plan.name,
      validUntil: formatPlanUntil(state.plan_expires_at),
      files: `Файлы: ${state.files_used} из ${limit}`,
      fillPercent: limit > 0 ? Math.min(100, Math.round((state.files_used / limit) * 100)) : 0,
    },
    user: userBadge(state.founder.full_name),
    gapsCount: state.passport.length > 0 ? openGapsCount(state.passport) : null,
  };
}
