import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { PipelineCompleted } from '@passport/contracts';
import { BrandMark } from '../../shared/ui/Logo/Logo';
import { env } from '../../shared/config/env';
import { loadFlow } from '../../shared/state/flow';
import { STUDY_CERTIFICATE_WARNING } from '@passport/passport-core';
import { useCabinetState } from '../../shared/state/cabinet';
import { openGapsCount } from '../../shared/state/cabinetView';
import type { CabinetState } from '../../shared/api/cabinet';
import type { FounderInput } from '../../shared/api/profile';
import { downloadPassport } from '../../shared/api/exportSections';
import './Result.css';

// Экран «Итог» (F8: допуск и чек-лист). Эталон: design/project/Result.dc.html.
// Стоп-факторы, пункты, которые не одобрил аудит, и документы к подаче сведены в один список «Что сделать перед подачей»,
// отсортированный по блокам. В живом режиме список и вердикт строятся из ответа пайплайна COMPLETED,
// в демо — переключатель статуса прототипа, как в эталоне.

type Verdict = 'ok' | 'warn' | 'bad' | 'fatal';
type TodoKind = 'stop' | 'audit';

const VARIANTS: { id: Verdict; label: string }[] = [
  { id: 'ok', label: 'Допуск' },
  { id: 'warn', label: 'Уточнить' },
  { id: 'bad', label: 'Стоп' },
  { id: 'fatal', label: 'Тема' },
];

const HEROES: Record<Verdict, { title: string; text: string }> = {
  ok: {
    title: 'Можно готовить заявку',
    text: 'Формальные требования программы выполнены, все факты подтверждены документами.',
  },
  warn: {
    title: 'Нужно уточнить',
    text: 'Стоп-факторов нет, но часть фактов не подтверждена документами, а новизна описана не полностью. Закройте пункты чек-листа.',
  },
  bad: {
    title: 'Есть стоп-факторы',
    text: 'С текущими сведениями заявку не допустят к конкурсу. Исправьте пункты ниже и проверьте паспорт заново.',
  },
  fatal: {
    title: 'Тема не подходит программе',
    text: 'Аудит нашёл причину, по которой ФСИ не поддержит проект в нынешнем виде. Это не исправить мелкими правками: нужно пересмотреть суть проекта.',
  },
};

const TAGS: Record<TodoKind, string> = {
  stop: 'Стоп-фактор',
  audit: 'Нужно доработать',
};

interface TodoItem {
  id: string;
  /** Номер блока для сортировки; смета и пункты без блока — в конце. */
  n: number;
  block: string;
  to: string;
  text: string;
  kind?: TodoKind;
  fix?: string;
}

// Пункты эталона для демо-режима.
const POOL: Record<string, TodoItem> = {
  study: { id: 'study', n: 1, block: 'Блок 1', to: '/passport', text: 'Загрузить справку об обучении в вузе — она подтверждает статус обучающегося' },
  dir: { id: 'dir', n: 4, block: 'Блок 4', to: '/passport', kind: 'stop', text: 'Выбрать вызов из направления проекта: вызов № 189 относится к Н4, а выбрано Н1' },
  fatal: {
    id: 'fatal',
    n: 4,
    block: 'Блоки 4, 6',
    to: '/passport',
    kind: 'stop',
    text: 'Нет научно-технической основы: проект описывает перепродажу и сервис без собственной разработки',
    fix: 'ФСИ поддерживает только технологические проекты. Опишите, что именно команда разрабатывает и какую технологическую задачу решает.',
  },
  analog: { id: 'analog', n: 6, block: 'Блок 6', to: '/passport', kind: 'audit', text: 'Добавить второй аналог и способ измерить отличие' },
  analogStop: { id: 'analogStop', n: 6, block: 'Блок 6', to: '/passport', kind: 'stop', text: 'Добавить второй аналог и способ измерить отличие: новизна не подтверждена' },
  proof: { id: 'proof', n: 7, block: 'Блок 7', to: '/passport', text: 'Приложить материалы двух фокус-групп и подтверждение выручки 10 000 ₽' },
  rid: { id: 'rid', n: 9, block: 'Блок 9', to: '/passport', kind: 'audit', text: 'Проверить совпадение заявителя и правообладателя по свидетельству РИД' },
  sk: { id: 'sk', n: 10, block: 'Блок 10', to: '/passport', text: 'Приложить оригинал уведомления о статусе участника Сколково' },
  budget: { id: 'budget', n: 99, block: 'Смета', to: '/gaps', kind: 'audit', text: 'Исправить смету по замечаниям аудита' },
  budgetStop: { id: 'budgetStop', n: 99, block: 'Смета', to: '/gaps', kind: 'stop', text: 'Уменьшить расходы 1-го этапа: сейчас 25 000 ₽, лимит — 20 000 ₽' },
};

const SETS: Record<Verdict, string[]> = {
  ok: [],
  warn: ['study', 'analog', 'proof', 'rid', 'sk', 'budget'],
  bad: ['study', 'dir', 'analogStop', 'proof', 'rid', 'sk', 'budgetStop'],
  fatal: ['fatal'],
};

interface Confirmation {
  doc: number;
  nodoc: number;
  plan: number;
}

// Подтверждённость в демо — числа эталона.
const DEMO_CONFIRMATION: Confirmation = { doc: 6, nodoc: 7, plan: 9 };

const byBlock = (a: TodoItem, b: TodoItem) => a.n - b.n;

function blockLabel(sections: number[]): string {
  const list = [...sections].sort((a, b) => a - b);
  return list.length === 1 ? `Блок ${list[0]}` : `Блоки ${list.join(', ')}`;
}

/** Список «Что сделать перед подачей» из ответа COMPLETED: стоп-факторы, неодобренные блоки и смета, документы и предупреждения. */
export function todoFromCompleted(res: PipelineCompleted): TodoItem[] {
  const items: TodoItem[] = [];
  (res.fatal_stop_factors ?? []).forEach((f, i) => {
    const sections = f.affected_sections.length > 0 ? f.affected_sections : [4];
    items.push({ id: `fatal-${i}`, n: Math.min(...sections), block: blockLabel(sections), to: '/passport', kind: 'stop', text: f.reason, fix: f.how_to_fix });
  });
  (res.block_audits ?? [])
    .filter((a) => a.status === 'needs_review')
    .forEach((a) => {
      items.push({
        id: `audit-${a.section_id}`,
        n: a.section_id,
        block: `Блок ${a.section_id}`,
        to: '/passport',
        kind: 'audit',
        text: a.remark ?? `Доработать блок ${a.section_id} по замечаниям аудита`,
        fix: a.how_to_fix ?? undefined,
      });
    });
  if (res.budget_audit && res.budget_audit.status !== 'approved') {
    items.push({
      id: 'budget',
      n: 99,
      block: 'Смета',
      to: '/gaps',
      kind: 'audit',
      text: res.budget_audit.remark ?? 'Исправить смету по замечаниям аудита',
      fix: res.budget_audit.how_to_fix ?? undefined,
    });
  }
  res.warnings.forEach((w, i) => items.push({ id: `warn-${i}`, n: 98, block: 'Паспорт', to: '/passport', text: w }));
  res.checklist.forEach((c, i) => items.push({ id: `doc-${i}`, n: 98, block: 'Паспорт', to: '/passport', text: c }));
  return items.sort(byBlock);
}

function verdictFromCompleted(res: PipelineCompleted): Verdict {
  if ((res.fatal_stop_factors ?? []).length > 0) return 'fatal';
  if (res.eligibility_status === 'NOT_ELIGIBLE') return 'bad';
  if (res.eligibility_status === 'NEEDS_CLARIFICATION' || !res.export_ready) return 'warn';
  return 'ok';
}

/** Утверждения паспорта по трём цветам: с документом, без документа (и слова команды), план или гипотеза. */
function confirmationFromCompleted(res: PipelineCompleted): Confirmation {
  const counts: Confirmation = { doc: 0, nodoc: 0, plan: 0 };
  for (const field of res.passport) {
    for (const claim of field.claims) {
      if (claim.claim_type === 'plan' || claim.claim_type === 'hypothesis') counts.plan += 1;
      else if (claim.claim_type === 'fact' && claim.source_id) counts.doc += 1;
      else counts.nodoc += 1;
    }
  }
  return counts;
}

/** Итог последней проверки из состояния кабинета (живой режим, ответа COMPLETED нет в этой вкладке). */
export function completedFromState(state: CabinetState): PipelineCompleted | undefined {
  if (!state.result) return undefined;
  const required = state.passport.filter((f) => !(f.section_id === 4 && f.field_key === 'tech_challenge'));
  const ready = required.length > 0 && required.every((f) => f.review_status === 'approved') && state.budget_audit?.status === 'approved';
  return {
    status: 'COMPLETED',
    export_ready: ready,
    not_approved: [],
    eligibility_status: state.result.eligibility_status,
    summary: state.result.summary,
    checklist: state.result.checklist,
    warnings: state.result.warnings,
    passport: state.passport,
    block_audits: state.block_audits,
    budget_audit: state.budget_audit ?? undefined,
    fatal_stop_factors: [],
  };
}

/** exportReady — все блоки и смета одобрены аудитом (демо-режим). В живом режиме берётся из COMPLETED.export_ready. */
export function Result({ exportReady = false }: { exportReady?: boolean } = {}) {
  const last = env.liveApi ? loadFlow().last : undefined;
  const cabinet = useCabinetState();
  const lastOrState = last?.status === 'COMPLETED' ? last : cabinet ? completedFromState(cabinet) : undefined;
  // Справку загрузили после проверки: её предупреждение больше не показываем (на итог оно не влияет).
  const completed =
    lastOrState && cabinet?.study_certificate
      ? { ...lastOrState, warnings: lastOrState.warnings.filter((w) => w !== STUDY_CERTIFICATE_WARNING) }
      : lastOrState;

  const [demoVerdict, setDemoVerdict] = useState<Verdict>('warn');
  const [checks, setChecks] = useState<Record<string, boolean>>(env.liveApi ? {} : { study: true });
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const verdict = completed ? verdictFromCompleted(completed) : env.liveApi ? 'warn' : demoVerdict;
  const openGaps = cabinet ? openGapsCount(cabinet.passport) : 0;
  const items = completed
    ? todoFromCompleted(completed)
    : env.liveApi
      ? [{ id: 'gaps', n: 0, block: 'Паспорт', to: '/gaps', kind: 'audit' as const, text: `Ответить на вопросы в «Пробелах»${openGaps > 0 ? ` (осталось ${openGaps})` : ''} — после этого Буха проверит паспорт целиком` }]
      : SETS[demoVerdict].map((id) => POOL[id]).sort(byBlock);
  const confirmation = completed
    ? confirmationFromCompleted(completed)
    : env.liveApi
      ? confirmationFromCompleted({ passport: cabinet?.passport ?? [] } as unknown as PipelineCompleted)
      : DEMO_CONFIRMATION;
  const ready = completed ? completed.export_ready : env.liveApi ? false : demoVerdict === 'ok' || exportReady;
  const hero = HEROES[verdict];
  const doneCount = items.filter((t) => checks[t.id]).length;

  async function onDownloadDocx() {
    const founder = (cabinet?.founder as FounderInput | undefined) ?? loadFlow().founder;
    if (!founder?.full_name || !completed) {
      setDownloadError('Сначала заполните данные основателя и дождитесь готового паспорта.');
      return;
    }
    setDownloadError(await downloadPassport(founder, completed.passport));
  }

  const heroIcon = verdict === 'bad' || verdict === 'fatal' ? 'bad' : verdict;

  return (
    <div className="result">
      <div className="result__head">
        <h1 className="result__title">Итог</h1>
        {!env.liveApi && (
          <div role="group" aria-label="Вариант статуса для прототипа" className="result__switch">
            <span className="result__switch-label">Прототип:</span>
            {VARIANTS.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={demoVerdict === v.id}
                onClick={() => setDemoVerdict(v.id)}
                className={demoVerdict === v.id ? 'result__variant result__variant--on' : 'result__variant'}
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <section className={`result__hero result__hero--${heroIcon}`}>
        <span className={`result__hero-icon result__hero-icon--${heroIcon}${verdict === 'fatal' ? ' result__hero-icon--fatal' : ''}`}>
          {heroIcon === 'ok' && (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12l5 5 9-10" />
            </svg>
          )}
          {heroIcon === 'warn' && (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
              <path d="M12 7v6M12 17h.01" />
            </svg>
          )}
          {heroIcon === 'bad' && (
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true">
              <path d="M7 7l10 10M17 7L7 17" />
            </svg>
          )}
        </span>
        <div className="result__hero-text">
          <h2 className="result__hero-title">{hero.title}</h2>
          <p className="result__hero-desc">{hero.text}</p>
        </div>
        <Link to="/generating" className="result__recheck">Проверить заново</Link>
      </section>

      <div className="result__grid">
        <div className="result__main">
          <section aria-labelledby="todo-title" className="result__panel result__panel--checklist">
            <div className="result__check-head">
              <BrandMark size={40} />
              <div className="result__check-head-text">
                <h2 id="todo-title" className="result__check-title">Что сделать перед подачей</h2>
                {items.length > 0 && <span className="result__check-count">Сделано {doneCount} из {items.length}</span>}
              </div>
            </div>
            {items.length === 0 && (
              <p className="result__all-done">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12l5 5 9-10" />
                </svg>
                Всё готово: стоп-факторов нет, блоки и смета одобрены аудитом
              </p>
            )}
            <ul className="result__checks">
              {items.map((item) => {
                const done = Boolean(checks[item.id]);
                const textClass = ['result__check-text', done ? 'result__check-text--done' : item.kind === 'stop' ? 'result__check-text--stop' : ''].filter(Boolean).join(' ');
                return (
                  <li key={item.id} className={item.kind === 'stop' ? 'result__check result__check--stop' : 'result__check'}>
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={() => setChecks({ ...checks, [item.id]: !done })}
                      aria-label={item.text}
                      className="result__checkbox"
                    />
                    <span className="result__check-body">
                      {item.kind && <span className={`result__tag result__tag--${item.kind}`}>{TAGS[item.kind]}</span>}
                      <span className={textClass}>{item.text}</span>
                      {item.fix && <span className="result__check-fix">{item.fix}</span>}
                    </span>
                    <Link to={item.to} className="result__check-link">{item.block}</Link>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <div className="result__side">
          <section className="result__panel result__panel--confirm">
            <h2 className="result__side-title">Насколько паспорт подтверждён</h2>
            <div aria-hidden="true" className="result__stack">
              <span className="result__seg result__seg--doc" style={{ flex: confirmation.doc }} />
              <span className="result__seg result__seg--nodoc" style={{ flex: confirmation.nodoc }} />
              <span className="result__seg result__seg--plan" style={{ flex: confirmation.plan }} />
            </div>
            <ul className="result__legend">
              <li className="result__legend-item">
                <span className="result__swatch result__swatch--doc" />
                <span className="result__legend-name">Подтверждено документом</span>
                <b>{confirmation.doc}</b>
              </li>
              <li className="result__legend-item">
                <span className="result__swatch result__swatch--nodoc" />
                <span className="result__legend-name">Без документа</span>
                <b>{confirmation.nodoc}</b>
              </li>
              <li className="result__legend-item">
                <span className="result__swatch result__swatch--plan" />
                <span className="result__legend-name">Планы и гипотезы</span>
                <b>{confirmation.plan}</b>
              </li>
            </ul>
            <Link to="/passport" className="result__link">Открыть паспорт</Link>
          </section>

          <section className="result__panel result__panel--passport">
            <h2 className="result__side-subtitle">Паспорт</h2>
            {ready ? (
              <p className="result__ready">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12l5 5 9-10" />
                </svg>
                Все блоки и смета одобрены аудитом
              </p>
            ) : (
              <p className="result__approve-note">Скачать можно, когда будут закрыты все пункты списка «Что сделать перед подачей».</p>
            )}
            {downloadError && <p role="alert" className="result__download-error">{downloadError}</p>}
            <div className="result__downloads">
              <button type="button" className="result__download" disabled={!ready} onClick={() => void onDownloadDocx()}>Скачать DOCX</button>
              <button type="button" className="result__download" disabled={!ready}>Скачать PDF</button>
            </div>
            <p className="result__fine">Скачивание не означает подачу. Заявка подаётся в системе фонда.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
