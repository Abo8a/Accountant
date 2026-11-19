import { Fragment, useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { BudgetItemInput, ClaimOrigin, PipelineClaimOut, PipelinePassportField, PipelineQuestion, PipelineRequest, PipelineResponse, TargetField } from '@passport/contracts';
import { StatusPill } from '../../shared/ui';
import { callPassportPipeline } from '../../shared/api/pipeline';
import { STUDY_CERTIFICATE_ACCEPT, uploadStudyCertificate, type CabinetState } from '../../shared/api/cabinet';
import { downloadPassport } from '../../shared/api/exportSections';
import type { FounderInput } from '../../shared/api/profile';
import { refreshCabinetState, useCabinetState } from '../../shared/state/cabinet';
import { loadFlow, saveFlow } from '../../shared/state/flow';
import { ConsultantWidget } from '../consultant/ConsultantWidget';
import { BudgetTable } from '../budget/BudgetTable';
import { AuditRemark } from './AuditRemark';
import { DirectionChallenge, type DirectionChallengeValue } from './DirectionChallenge';
import { FieldEditor } from './forms/FieldEditor';
import { FIELD_FORMS, teamFromData, type FormCtx } from './forms/schemas';
import {
  ClaimPanel,
  FIELD_CHIP,
  RISKY,
  SECTIONS,
  type ClaimType,
  type FieldStatus,
  type SectionDot,
  type VisKind,
} from './Passport';

// Паспорт пользователя в живом режиме: данные из состояния кабинета (GET /pipeline/state), оформление — как Passport.dc.html.
// Утверждения подсвечены по спанам из бэкенда. «Сохранить» в любом блоке (поле, направление, смета) пишет правку сразу,
// без моделей (save_draft). «Проверить» в правом верхнем углу отдаёт модели все сохранённые правки разом (review_edits):
// ИИ упаковывает текст, аудит перепроверяет изменённые блоки, замечания обновляются по всему паспорту.
// Доработка пробелов — прямо в блоках: в редакторе поля критерий фонда и пример заполнения («Как обычно пишут»).

/** Названия полей паспорта — как в выгрузке DOCX (backend/pipeline-api/src/pipeline/exportLabels.ts). */
const FIELD_LABELS: Record<string, string> = {
  team_members: 'Состав команды',
  competencies_and_experience: 'Компетенции и опыт команды',
  problem_description: 'Описание проблемы',
  target_audience: 'Целевая аудитория',
  product_summary: 'Кратко о продукте',
  core_features: 'Ключевые функции',
  tech_approach: 'Технологический подход',
  direction: 'Направление (Н1–Н7)',
  tech_challenge: 'Технологический вызов (№)',
  current_stage: 'Текущая стадия',
  existing_backlog_and_mvp: 'Задел и MVP',
  first_stage_result: 'Результат первого этапа',
  calendar_plan_stage_1: 'Календарный план: 1 этап',
  calendar_plan_stage_2: 'Календарный план: 2 этап',
  analogues_comparison: 'Аналоги и сравнение',
  novelty_hypothesis: 'Гипотеза отличия',
  verification_protocol: 'Протокол проверки',
  market_overview: 'Рынок',
  business_model_and_pricing: 'Бизнес-модель и цены',
  traction_and_pilots: 'Продажи и пилоты',
  legal_entity_info: 'Юридическое лицо',
  entity_roles: 'Роли организаций',
  ip_rights_and_authors: 'Авторы и права',
  rid_certificates: 'Свидетельства РИД',
  previous_grants_and_statuses: 'Предыдущие гранты и статусы',
  active_obligations: 'Действующие обязательства',
};

/** Три подчёркивания паспорта: чьи слова в тексте и что ещё нужно заполнить. Типы утверждений (документ, план) — в панели справа. */
const LIVE_LEGEND: { kind: 'user' | 'ai' | 'to-fill'; label: string }[] = [
  { kind: 'user', label: 'С ваших слов' },
  { kind: 'ai', label: 'Дописано ИИ' },
  { kind: 'to-fill', label: 'Заполнить' },
];

const ORIGIN_LABEL: Record<ClaimOrigin, string> = { user: 'Слова пользователя', ai: 'Дописано ИИ' };

const OPTIONAL = new Set(['4/tech_challenge']);
/** Правка сохранена, но ещё не прошла «Проверить». */
const PENDING_CHIP = { label: 'Не проверено', tone: 'info' } as const;
const PDF_HINT = 'Выгрузка в PDF пока не готова — скачайте DOCX';
const CODE_FIELDS = new Set(['4/direction', '4/tech_challenge']);

function visKindOf(c: PipelineClaimOut): VisKind {
  if (c.claim_type === 'plan') return 'plan';
  if (c.claim_type === 'hypothesis') return 'hyp';
  if (c.claim_type === 'client_statement') return 'client';
  return c.source_id ? 'ok' : 'nodoc';
}

const TYPE_OF: Record<string, ClaimType> = { fact: 'fact', client_statement: 'client', plan: 'plan', hypothesis: 'hyp' };

function fieldStatusOf(f: PipelinePassportField): FieldStatus {
  if (f.review_status === 'approved') return 'approved';
  if (f.review_status === 'needs_review') return 'needs';
  if (f.review_status === 'reviewed') return 'reviewed';
  return 'ai';
}

function sectionDotOf(sectionId: number, passport: readonly PipelinePassportField[]): SectionDot {
  if (sectionId === 1) return 'lock';
  const fields = passport.filter((f) => f.section_id === sectionId && !OPTIONAL.has(`${f.section_id}/${f.field_key}`));
  if (fields.some((f) => f.review_status === 'needs_review' || !f.value?.trim())) return 'needs';
  if (fields.length > 0 && fields.every((f) => f.review_status === 'approved')) return 'approved';
  return 'ai';
}

/** Текст поля с подсвеченными утверждениями (спаны бэкенда, 0-based, без пересечений). */
function renderValue(
  f: PipelinePassportField,
  expert: boolean,
  selected: string | null,
  onPick: (id: string) => void,
): ReactNode[] {
  const value = f.value ?? '';
  const spans = f.claims
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.span_start !== null && c.span_end !== null && c.span_end! <= value.length)
    .sort((a, b) => a.c.span_start! - b.c.span_start!);
  const out: ReactNode[] = [];
  let pos = 0;
  for (const { c, i } of spans) {
    if (c.span_start! < pos) continue;
    if (c.span_start! > pos) out.push(value.slice(pos, c.span_start!));
    const id = `${f.section_id}/${f.field_key}/${i}`;
    const v = visKindOf(c);
    const classes = [
      'passport-claim',
      `passport-claim--${c.origin === 'ai' ? 'ai' : 'user'}`,
      expert && !RISKY[v] ? 'passport-claim--muted' : '',
      expert && RISKY[v] ? 'passport-claim--risk' : '',
      selected === id ? 'passport-claim--selected' : '',
    ]
      .filter(Boolean)
      .join(' ');
    out.push(
      <a key={id} href="#claim-panel" className={classes} data-kind={v} onClick={() => onPick(id)}>
        {value.slice(c.span_start!, c.span_end!)}
      </a>,
    );
    pos = c.span_end!;
  }
  if (pos < value.length) out.push(value.slice(pos));
  return out;
}

function findClaim(passport: readonly PipelinePassportField[], id: string | null): PipelineClaimOut | null {
  if (!id) return null;
  const [sid, key, idx] = id.split('/');
  return passport.find((f) => String(f.section_id) === sid && f.field_key === key)?.claims[Number(idx)] ?? null;
}

function educationLabel(state: CabinetState): string {
  const who = state.founder.education_status === 'postgraduate' ? 'Аспирант' : 'Студент';
  return `${who} · ${state.study_certificate ? 'справка загружена' : 'справка не загружена'}`;
}

function isQuestion(res: PipelineResponse | undefined): res is PipelineQuestion {
  return !!res && (res.status === 'NEED_USER_INPUT' || res.status === 'STOP_NOV' || res.status === 'ANSWER_REJECTED');
}

/** Поле — пробел: обязательное и пустое или с замечанием аудита. Дорабатывается ответом с проверкой ИИ (submit_answer). */
function isGap(f: PipelinePassportField): boolean {
  return !OPTIONAL.has(`${f.section_id}/${f.field_key}`) && (!f.value?.trim() || f.review_status === 'needs_review');
}

/** Какой блок открыть: из ссылки (?block=6 или ?block=budget), иначе — блок текущего вопроса пайплайна, иначе блок 2. */
function initialSection(param: string | null, flow: PipelineResponse | undefined): Sec {
  if (param === 'budget') return 'budget';
  const n = Number(param);
  if (Number.isInteger(n) && n >= 1 && n <= 10) return n;
  if (isQuestion(flow) && flow.step === 'BUDGET_REVIEW') return 'budget';
  if (isQuestion(flow) && flow.target_field) return flow.target_field.section_id;
  return 2;
}

type Sec = number | 'budget';

/** Строка под кнопкой после «Проверить»: где остались замечания аудита. */
export function reviewSummary(s: CabinetState | null): string {
  if (!s) return 'Проверка завершена.';
  const blocks = s.block_audits.filter((b) => b.status === 'needs_review').map((b) => b.section_id).sort((a, b) => a - b);
  const parts = [
    ...(blocks.length > 0 ? [`${blocks.length === 1 ? 'блок' : 'блоки'} ${blocks.join(', ')}`] : []),
    ...(s.budget_audit && s.budget_audit.status !== 'approved' ? ['смета'] : []),
  ];
  return parts.length === 0 ? 'Проверка завершена: замечаний аудита нет.' : `Проверка завершена. Замечания аудита: ${parts.join(', ')}.`;
}

export function LivePassport() {
  const state = useCabinetState();
  const [params] = useSearchParams();
  const [flow, setFlow] = useState<PipelineResponse | undefined>(() => loadFlow().last);
  const [sec, setSec] = useState<Sec>(() => initialSection(params.get('block'), loadFlow().last));
  const [sel, setSel] = useState<string | null>(null);
  const [expert, setExpert] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState<string | null>(null);
  // «Не знаю — помогите» открывает ИИ-Консультанта.
  const [helpSignal, setHelpSignal] = useState(0);

  // Открыли паспорт в новой вкладке: текущего шага пайплайна нет — спрашиваем его (без текста модели не вызываются).
  useEffect(() => {
    if (flow) return;
    let alive = true;
    callPassportPipeline({ action: 'init_or_upload' })
      .then((res) => {
        if (!alive || res.status === 'ERROR') return;
        saveFlow({ last: res });
        setFlow(res);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === undefined) {
    return (
      <div className="passport">
        <p className="passport__panel-hint">Загружаем паспорт…</p>
      </div>
    );
  }
  if (state === null || state.passport.length === 0) {
    return (
      <div className="passport">
        <div className="passport__head">
          <div className="passport__title">
            <h1 className="passport__h1">Паспорт проекта</h1>
          </div>
        </div>
        <p className="passport__panel-hint">
          Паспорт появится после стартового брифа. <Link to="/brief">Описать проект</Link>
        </p>
      </div>
    );
  }

  const passport = state.passport;
  // Имена из анкеты команды — подсказки для опыта команды и авторов.
  const formCtx: FormCtx = { team: teamFromData(passport.find((f) => f.section_id === 2 && f.field_key === 'team_members')?.form_data) };
  const secId = sec === 'budget' ? null : sec;
  const meta = SECTIONS.find((s) => s.id === secId) ?? SECTIONS[0]!;
  const fields = passport.filter((f) => f.section_id === secId);
  const audit = state.block_audits.find((b) => b.section_id === secId);
  const required = passport.filter((f) => !OPTIONAL.has(`${f.section_id}/${f.field_key}`));
  const allApproved = required.length > 0 && required.every((f) => f.review_status === 'approved') && state.budget_audit?.status === 'approved';
  const selectedClaim = findClaim(passport, sel);
  const question = isQuestion(flow) ? flow : null;
  const budgetApproved = state.budget_audit?.status === 'approved';
  const pending = new Set(state.pending_review ?? []);
  const hints = state.field_hints ?? {};

  /** «Сохранить»: правка пишется сразу, без моделей (save_draft), и ждёт «Проверить». */
  async function save(body: Pick<PipelineRequest, 'form' | 'field_form' | 'budget_items'>) {
    setBusy(true);
    setMessage(null);
    setReviewNote(null);
    try {
      const res = await callPassportPipeline({ action: 'save_draft', ...body });
      if (res.status === 'ERROR' || res.status === 'BLOCKED_PROJECT_SWAP') {
        setMessage(res.message);
        return;
      }
      setEditing(null);
      await refreshCabinetState();
    } catch {
      setMessage('Не удалось сохранить правку. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  /** «Проверить»: модель по всем сохранённым правкам разом, затем аудит изменённых блоков (review_edits). */
  async function review() {
    setBusy(true);
    setReviewing(true);
    setMessage(null);
    setReviewNote(null);
    try {
      const res = await callPassportPipeline({ action: 'review_edits' });
      if (res.status === 'ERROR' || res.status === 'BLOCKED_PROJECT_SWAP') {
        setMessage(res.message);
        return;
      }
      saveFlow({ last: res });
      setFlow(res);
      setEditing(null);
      setReviewNote(reviewSummary(await refreshCabinetState()));
    } catch {
      setMessage('Не удалось проверить правки. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
      setReviewing(false);
    }
  }

  // Анкета (таблица, «да/нет») сохраняется вместе с текстом: ИИ на проверке переписывает текст, а форму потом открываем как была.
  function saveField(f: PipelinePassportField, value: string, form?: Record<string, unknown>) {
    const tf: TargetField = { section_id: f.section_id, field_key: f.field_key };
    void save({ form: [{ ...tf, value }], ...(form ? { field_form: { ...tf, data: form } } : {}) });
  }

  function saveDirection(v: DirectionChallengeValue) {
    void save({
      form: [{ section_id: 4, field_key: 'direction', value: v.direction }, ...(v.challenge ? [{ section_id: 4, field_key: 'tech_challenge', value: v.challenge }] : [])],
    });
  }

  function saveBudget(items: BudgetItemInput[]) {
    void save({ budget_items: items });
  }

  async function onDownload() {
    if (!state) return;
    const founder: FounderInput = { full_name: state.founder.full_name ?? '', ...state.founder } as FounderInput;
    setMessage(await downloadPassport(founder, passport));
  }

  async function onCertificate(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    const res = await uploadStudyCertificate(file);
    setBusy(false);
    if (!res.ok) setMessage(res.message);
    else await refreshCabinetState();
  }

  const pick = (next: Sec) => {
    setSec(next);
    setEditing(null);
  };

  // Скачать можно на любом этапе: незаполненные поля в файле остаются пустыми. PDF-выгрузки пока нет.
  const docxHint = allApproved ? undefined : 'Паспорт ещё не одобрен целиком: незаполненные поля в файле останутся пустыми';
  const founderRows: [string, string][] = [
    ['ФИО', state.founder.full_name ?? '—'],
    ['Статус обучения', educationLabel(state)],
    ['Вуз', state.founder.university ?? '—'],
    ['Регион', state.founder.region ?? '—'],
    ['Контакты', state.founder.contacts ?? '—'],
  ];

  const directionValue = passport.find((f) => f.section_id === 4 && f.field_key === 'direction')?.value?.trim() || undefined;
  const challengeValue = passport.find((f) => f.section_id === 4 && f.field_key === 'tech_challenge')?.value?.trim() || undefined;
  const directionAsked = question?.target_field?.section_id === 4 && (question.target_field.field_key === 'direction' || question.target_field.field_key === 'tech_challenge');

  return (
    <div className="passport">
      <div className="passport__head">
        <div className="passport__title">
          <h1 className="passport__h1">Паспорт проекта</h1>
          {allApproved ? (
            <StatusPill tone="success" size="md">Согласовано</StatusPill>
          ) : (
            <StatusPill tone="warning" size="md">На проверке</StatusPill>
          )}
        </div>
        <div className="passport__actions">
          <button type="button" className="passport__btn" disabled={busy} title={docxHint} onClick={() => void onDownload()}>
            DOCX
          </button>
          <button type="button" className="passport__btn" disabled title={PDF_HINT}>
            PDF
          </button>
          <button type="button" className="passport__btn-brand" disabled={busy} onClick={() => void review()}>
            {reviewing ? 'Проверяем…' : 'Проверить'}
          </button>
          {message && <span role="alert" className="passport__download-error">{message}</span>}
          {reviewNote && (
            <p role="status" className="passport__review-note">
              {reviewNote} <Link to="/result">Итог проверки</Link>
            </p>
          )}
        </div>
      </div>

      <div className="passport__bar">
        <ul aria-label="Обозначения" className="passport__legend">
          {LIVE_LEGEND.map((item) => (
            <li key={item.kind}>
              <span className={`passport__swatch passport__swatch--${item.kind}`} aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ul>
        <button type="button" aria-pressed={expert} onClick={() => setExpert((v) => !v)} className="passport__expert">
          Глазами эксперта
          <span className={`passport__switch${expert ? ' passport__switch--on' : ''}`} aria-hidden="true">
            <span className="passport__knob" />
          </span>
        </button>
      </div>

      <div className="passport__body">
        <nav aria-label="Блоки паспорта" className="passport__nav">
          {SECTIONS.map((s) => {
            const current = s.id === sec;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={current ? 'true' : 'false'}
                onClick={() => pick(s.id)}
                className={`passport__nav-item${current ? ' passport__nav-item--current' : ''}`}
              >
                <span className="passport__nav-num">{s.id}</span>
                <span className="passport__nav-label">{s.short}</span>
                <span className={`passport__nav-dot passport__nav-dot--${sectionDotOf(s.id, passport)}`} />
              </button>
            );
          })}
          {/* «Смета» под блоками — как в Passport.dc.html; в живом режиме смета правится здесь же. */}
          <button
            type="button"
            aria-current={sec === 'budget' ? 'true' : 'false'}
            onClick={() => pick('budget')}
            className={`passport__nav-item passport__nav-item--budget${sec === 'budget' ? ' passport__nav-item--current' : ''}`}
          >
            <span className="passport__nav-num" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 7h8" />
                <path d="M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" />
              </svg>
            </span>
            <span className="passport__nav-label">Смета</span>
            <span className={`passport__nav-dot passport__nav-dot--${budgetApproved && !pending.has('budget') ? 'approved' : 'needs'}`} />
          </button>
        </nav>

        {sec === 'budget' ? (
          <section className="passport__section">
            <div className="passport__sec-head">
              <h2 className="passport__sec-title">Смета</h2>
              {pending.has('budget') && <StatusPill tone={PENDING_CHIP.tone}>{PENDING_CHIP.label}</StatusPill>}
            </div>
            {budgetApproved && !pending.has('budget') && <p className="passport__note">Смета одобрена аудитом</p>}
            {!budgetApproved && state.budget_audit?.remark && <AuditRemark remark={state.budget_audit.remark} howToFix={state.budget_audit.how_to_fix} />}
            <BudgetTable
              busy={busy}
              violations={question?.step === 'BUDGET_REVIEW' && question.rejection_reason ? [question.rejection_reason] : []}
              onSubmit={saveBudget}
            />
          </section>
        ) : (
          <section className="passport__section">
            <div className="passport__sec-head">
              <span className="passport__eyebrow">Блок {meta.id}</span>
              <h2 className="passport__sec-title">{meta.name}</h2>
            </div>

            {audit?.status === 'needs_review' && audit.remark && <AuditRemark remark={audit.remark} howToFix={audit.how_to_fix} />}

            {meta.founder && (
              <div className="passport__founder">
                <dl className="passport__dl">
                  {founderRows.map(([term, value]) => (
                    <Fragment key={term}>
                      <dt>{term}</dt>
                      <dd>{value}</dd>
                    </Fragment>
                  ))}
                </dl>
                {!state.study_certificate && (
                  <p className="passport__note">Без справки об обучении фонд не примет заявку. Паспорт можно собрать и выгрузить и без неё.</p>
                )}
                <label className="passport__cert-pick">
                  <input type="file" accept={STUDY_CERTIFICATE_ACCEPT} onChange={(e) => void onCertificate(e)} disabled={busy} className="passport__cert-input" />
                  {state.study_certificate ? 'Заменить справку об обучении' : 'Загрузить справку об обучении'}
                </label>
                <Link to="/profile" className="passport__founder-link">Изменить в профиле</Link>
              </div>
            )}

            {fields.map((f) => {
              const key = `${f.section_id}/${f.field_key}`;
              const fs = fieldStatusOf(f);
              const filled = !!f.value?.trim();
              const isDirection = key === '4/direction';
              const chip = pending.has(key) ? PENDING_CHIP : filled ? FIELD_CHIP[fs] : undefined;
              const isEditing = editing === key;
              const gap = isGap(f);
              const hint = hints[key];
              // Выбор направления правит оба кода сразу, у вызова своей кнопки нет.
              const editable = !CODE_FIELDS.has(key) || isDirection;
              const asked = question?.target_field?.section_id === f.section_id && question.target_field.field_key === f.field_key ? question : null;
              return (
                <article key={key} className="passport__field">
                  <div className="passport__field-head">
                    <div className="passport__field-title">
                      <h3 className="passport__field-name">{FIELD_LABELS[f.field_key] ?? f.field_key}</h3>
                      {chip && <StatusPill tone={chip.tone}>{chip.label}</StatusPill>}
                    </div>
                    {!isEditing && editable && (
                      <div className="passport__field-actions">
                        <button type="button" className="passport__btn-edit" disabled={busy} onClick={() => setEditing(key)}>
                          {filled ? 'Править' : 'Заполнить'}
                        </button>
                      </div>
                    )}
                  </div>

                  {!isEditing && filled && <p className="passport__text">{renderValue(f, expert, sel, setSel)}</p>}
                  {!isEditing && !filled && (
                    <p className="passport__note">
                      {OPTIONAL.has(key) ? 'Необязательное поле.' : <span className="passport__to-fill">Пока не заполнено.</span>}
                    </p>
                  )}
                  {!isEditing && gap && asked?.question && <p className="passport__note">{asked.question}</p>}

                  {isEditing && isDirection && (
                    <DirectionChallenge
                      initialDirection={directionValue ?? (directionAsked ? question?.suggestion?.direction : undefined)}
                      initialChallenge={challengeValue ?? (directionAsked ? (question?.suggestion?.tech_challenge ?? undefined) : undefined)}
                      busy={busy}
                      onHelp={() => setHelpSignal((n) => n + 1)}
                      onSubmit={saveDirection}
                    />
                  )}
                  {isEditing && isDirection && (
                    <div className="passport__editor-actions">
                      <button type="button" className="passport__btn-cancel" disabled={busy} onClick={() => setEditing(null)}>
                        Отмена
                      </button>
                    </div>
                  )}

                  {isEditing && !isDirection && (
                    <FieldEditor
                      inputId={`edit-${f.section_id}-${f.field_key}`}
                      initialText={f.value ?? ''}
                      wasApproved={fs === 'approved'}
                      busy={busy}
                      question={gap ? asked?.question : undefined}
                      criteria={(gap ? asked?.criteria : undefined) || hint?.criteria || undefined}
                      example={(gap ? asked?.example : undefined) || hint?.example || undefined}
                      onHelp={gap ? () => setHelpSignal((n) => n + 1) : undefined}
                      spec={FIELD_FORMS[key]}
                      formData={f.form_data}
                      ctx={formCtx}
                      onSave={(text, form) => saveField(f, text, form)}
                      onCancel={() => setEditing(null)}
                    />
                  )}
                </article>
              );
            })}
          </section>
        )}

        <aside id="claim-panel" aria-label="Утверждение" className="passport__panel">
          {!selectedClaim && (
            <p className="passport__panel-hint">Нажмите на выделенный фрагмент текста — здесь появятся тип, источник и действия.</p>
          )}
          {selectedClaim && (
            <ClaimPanel
              text={selectedClaim.claim_text}
              kind={visKindOf(selectedClaim)}
              type={TYPE_OF[selectedClaim.claim_type] ?? 'fact'}
              source={selectedClaim.source_id ? 'Загруженный документ' : null}
              page={selectedClaim.source_locator?.page ?? null}
              quote={selectedClaim.source_locator?.quote ?? null}
              origin={ORIGIN_LABEL[selectedClaim.origin === 'ai' ? 'ai' : 'user']}
              conf={1}
              onPickType={() => undefined}
              readOnly
            />
          )}
        </aside>
      </div>
      <ConsultantWidget activeSectionId={secId ?? undefined} openSignal={helpSignal} />
    </div>
  );
}
