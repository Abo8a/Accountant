import { Fragment, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { PipelineClaimOut, PipelinePassportField } from '@passport/contracts';
import { StatusPill } from '../../shared/ui';
import { callPassportPipeline } from '../../shared/api/pipeline';
import { STUDY_CERTIFICATE_ACCEPT, uploadStudyCertificate, type CabinetState } from '../../shared/api/cabinet';
import { downloadPassport } from '../../shared/api/exportSections';
import type { FounderInput } from '../../shared/api/profile';
import { refreshCabinetState, useCabinetState } from '../../shared/state/cabinet';
import { saveFlow } from '../../shared/state/flow';
import { ConsultantWidget } from '../consultant/ConsultantWidget';
import {
  ClaimPanel,
  FIELD_CHIP,
  KIND_CLASS,
  LEGEND,
  RISKY,
  SECTIONS,
  type ClaimType,
  type FieldStatus,
  type SectionDot,
  type VisKind,
} from './Passport';

// Паспорт пользователя в живом режиме: данные из состояния кабинета (GET /pipeline/state), оформление — как Passport.dc.html.
// Утверждения подсвечены по спанам из бэкенда; правка поля уходит в пайплайн (submit_form) и проходит проверку заново.

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

const OPTIONAL = new Set(['4/tech_challenge']);
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
      KIND_CLASS[v],
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

export function LivePassport() {
  const state = useCabinetState();
  const [sec, setSec] = useState(2);
  const [sel, setSel] = useState<string | null>(null);
  const [expert, setExpert] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
  const meta = SECTIONS.find((s) => s.id === sec) ?? SECTIONS[0]!;
  const fields = passport.filter((f) => f.section_id === sec);
  const audit = state.block_audits.find((b) => b.section_id === sec);
  const required = passport.filter((f) => !OPTIONAL.has(`${f.section_id}/${f.field_key}`));
  const allApproved = required.length > 0 && required.every((f) => f.review_status === 'approved') && state.budget_audit?.status === 'approved';
  const selectedClaim = findClaim(passport, sel);

  async function saveField(f: PipelinePassportField, value: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await callPassportPipeline({ action: 'submit_form', form: [{ section_id: f.section_id, field_key: f.field_key, value }] });
      if (res.status === 'ERROR' || res.status === 'BLOCKED_PROJECT_SWAP') {
        setMessage(res.message);
        return;
      }
      saveFlow({ last: res });
      await refreshCabinetState();
      setEditing(null);
    } catch {
      setMessage('Не удалось сохранить правку. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
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

  const hint = allApproved ? undefined : 'Скачать можно, когда все 10 блоков одобрены';
  const founderRows: [string, string][] = [
    ['ФИО', state.founder.full_name ?? '—'],
    ['Статус обучения', educationLabel(state)],
    ['Вуз', state.founder.university ?? '—'],
    ['Регион', state.founder.region ?? '—'],
    ['Контакты', state.founder.contacts ?? '—'],
  ];

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
          <button type="button" className="passport__btn" disabled={!allApproved || busy} title={hint} onClick={() => void onDownload()}>
            DOCX
          </button>
          <button type="button" className="passport__btn" disabled title={hint}>
            PDF
          </button>
          <Link to="/result" className="passport__btn-brand">Итог проверки</Link>
          {message && <span role="alert" className="passport__download-error">{message}</span>}
        </div>
      </div>

      <div className="passport__bar">
        <ul aria-label="Обозначения" className="passport__legend">
          {LEGEND.map((item) => (
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
                onClick={() => {
                  setSec(s.id);
                  setEditing(null);
                }}
                className={`passport__nav-item${current ? ' passport__nav-item--current' : ''}`}
              >
                <span className="passport__nav-num">{s.id}</span>
                <span className="passport__nav-label">{s.short}</span>
                <span className={`passport__nav-dot passport__nav-dot--${sectionDotOf(s.id, passport)}`} />
              </button>
            );
          })}
        </nav>

        <section className="passport__section">
          <div className="passport__sec-head">
            <span className="passport__eyebrow">Блок {meta.id}</span>
            <h2 className="passport__sec-title">{meta.name}</h2>
          </div>

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
            const chip = f.value?.trim() ? FIELD_CHIP[fs] : undefined;
            const isEditing = editing === key;
            const failed = audit?.status === 'needs_review' && audit.failed_fields.includes(f.field_key);
            return (
              <article key={key} className="passport__field">
                <div className="passport__field-head">
                  <div className="passport__field-title">
                    <h3 className="passport__field-name">{FIELD_LABELS[f.field_key] ?? f.field_key}</h3>
                    {chip && <StatusPill tone={chip.tone}>{chip.label}</StatusPill>}
                  </div>
                  {!isEditing && !CODE_FIELDS.has(key) && f.value?.trim() && (
                    <div className="passport__field-actions">
                      <button type="button" className="passport__btn-edit" disabled={busy} onClick={() => setEditing(key)}>
                        Править
                      </button>
                    </div>
                  )}
                </div>

                {!isEditing && f.value?.trim() && (
                  <p className="passport__text">{renderValue(f, expert, sel, setSel)}</p>
                )}
                {!isEditing && !f.value?.trim() && (
                  <p className="passport__note">
                    {OPTIONAL.has(key) ? 'Необязательное поле.' : 'Пока не заполнено.'}{' '}
                    {!OPTIONAL.has(key) && <Link to="/gaps">Ответить в «Пробелах»</Link>}
                  </p>
                )}

                {isEditing && (
                  <LiveFieldEditor
                    inputId={`edit-${f.section_id}-${f.field_key}`}
                    initialText={f.value ?? ''}
                    wasApproved={fs === 'approved'}
                    busy={busy}
                    onSave={(text) => void saveField(f, text)}
                    onCancel={() => setEditing(null)}
                  />
                )}

                {failed && audit?.remark && !isEditing && <p className="passport__note">{audit.remark}</p>}
              </article>
            );
          })}
        </section>

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
              origin="Слова пользователя"
              conf={1}
              onPickType={() => undefined}
              readOnly
            />
          )}
        </aside>
      </div>
      <ConsultantWidget activeSectionId={sec} />
    </div>
  );
}

interface LiveFieldEditorProps {
  inputId: string;
  initialText: string;
  wasApproved: boolean;
  busy: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}

function LiveFieldEditor({ inputId, initialText, wasApproved, busy, onSave, onCancel }: LiveFieldEditorProps) {
  const [draft, setDraft] = useState(initialText);
  return (
    <div className="passport__editor">
      <label htmlFor={inputId} className="passport__editor-hint">
        Правка текста поля. После сохранения Буха заново найдёт каждое утверждение в тексте.
      </label>
      <textarea id={inputId} rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} className="passport__textarea" />
      {wasApproved && <span className="passport__editor-warn">Поле согласовано. Правка снимет согласование.</span>}
      <div className="passport__editor-actions">
        <button type="button" className="passport__btn-save" disabled={busy || !draft.trim()} onClick={() => onSave(draft.trim())}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" className="passport__btn-cancel" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}
