import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PASSPORT_SECTIONS, type PipelineResponse } from '@passport/contracts';
import { env } from '../../shared/config/env';
import { callPassportPipeline } from '../../shared/api/pipeline';
import { loadFlow, saveFlow } from '../../shared/state/flow';
import { refreshCabinetState } from '../../shared/state/cabinet';
import { openGapsCount } from '../../shared/state/cabinetView';
import { OnboardingHeader } from './OnboardingHeader';
import './common.css';
import './Generating.css';

// Сборка паспорта — design/project/Generating.dc.html. Шаги идут по таймеру; «показать ошибку» останавливает их.

const STEPS_TOTAL = 6;
const STEP_INTERVAL_MS = 1800;

const STEPS = [
  'Проверяем тариф и лимиты',
  'Распознаём документы',
  'Раскладываем по блокам 2–10',
  'Фиксируем якорь проекта',
  'Проводим аудит',
  'Ищем пробелы',
];

// Утверждения по трём цветам: максимум в конце сборки, сейчас масштабируются по шагу.
const CLAIM_TYPES: { kind: 'doc' | 'nodoc' | 'plan'; label: string; max: number }[] = [
  { kind: 'doc', label: 'Подтверждено документом', max: 6 },
  { kind: 'nodoc', label: 'Без документа', max: 5 },
  { kind: 'plan', label: 'План или гипотеза', max: 7 },
];

// Итог сборки плитками (эталон: 7 из 9 заполнено, 3 из 9 одобрено, 7 пробелов).
const BLOCKS_TOTAL = 9;
const BLOCKS_FILLED = 7;
const BLOCKS_APPROVED = 3;
const GAPS_LEFT = 7;

// Живой режим: сборка по брифу идёт 1–3 минуты. Этапы идут медленнее и ждут ответа на последнем.
const LIVE_STEP_INTERVAL_MS = 12_000;

// Один запрос на бриф, даже если экран смонтирован дважды (StrictMode) или студент обновил страницу во время сборки.
let inflight: { text: string; promise: Promise<PipelineResponse> } | null = null;
function sendBrief(text: string): Promise<PipelineResponse> {
  if (inflight?.text !== text) {
    const promise = callPassportPipeline({ action: 'init_or_upload', text_input: text });
    inflight = { text, promise };
    promise.catch(() => undefined).finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  }
  return inflight.promise;
}

interface LiveTotals {
  filled: number;
  approved: number;
  gaps: number;
  claims: Record<'doc' | 'nodoc' | 'plan', number>;
}

/** Итог сборки из ответа пайплайна: заполненные и одобренные блоки, пробелы, утверждения по трём цветам. */
export function totalsFromResponse(res: PipelineResponse | undefined): LiveTotals {
  const passport = res && 'passport' in res && Array.isArray(res.passport) ? res.passport : [];
  const audits = res && 'block_audits' in res && Array.isArray(res.block_audits) ? res.block_audits : [];
  const filled = PASSPORT_SECTIONS.filter((s) =>
    s.fields
      .filter((f) => !(s.id === 4 && f === 'tech_challenge'))
      .every((f) => passport.some((p) => p.section_id === s.id && p.field_key === f && p.value?.trim())),
  ).length;
  const claims = { doc: 0, nodoc: 0, plan: 0 };
  for (const c of passport.flatMap((p) => p.claims)) {
    if (c.claim_type === 'plan' || c.claim_type === 'hypothesis') claims.plan++;
    else if (c.source_id) claims.doc++;
    else claims.nodoc++;
  }
  return { filled, approved: audits.filter((b) => b.status === 'approved').length, gaps: openGapsCount(passport), claims };
}

export function Generating() {
  const live = env.liveApi;
  const navigate = useNavigate();
  const [step, setStep] = useState(live ? 0 : 2);
  const [error, setError] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Живой режим: ответ сборки. Если брифа в очереди нет (обновили страницу после сборки) — последний ответ.
  const [result, setResult] = useState<PipelineResponse | undefined>(() => (live && !loadFlow().pendingBrief ? loadFlow().last : undefined));

  useEffect(() => {
    if (!live) return undefined;
    const text = loadFlow().pendingBrief;
    if (!text) {
      if (!loadFlow().last) navigate('/brief', { replace: true });
      return undefined;
    }
    let cancelled = false;
    setError(false);
    sendBrief(text)
      .then((res) => {
        if (cancelled) return;
        if (res.status === 'ERROR' || res.status === 'BLOCKED_PROJECT_SWAP') {
          setErrorText(res.message);
          setError(true);
          return;
        }
        if (res.status === 'WAITING_FOR_INITIAL_BRIEF' && (res.fatal_stop_factors?.length || res.rejection_reason)) {
          // Стоп-фактор виден уже по брифу: возвращаем на бриф с причиной и тем, что изменить
          const refusal = res.fatal_stop_factors?.length
            ? res.fatal_stop_factors.map((f) => ({ reason: f.reason, how_to_fix: f.how_to_fix }))
            : [{ reason: res.rejection_reason ?? '', how_to_fix: '' }];
          saveFlow({ pendingBrief: undefined, briefRefusal: refusal, last: res });
          navigate('/brief', { replace: true });
          return;
        }
        saveFlow({ pendingBrief: undefined, briefDraft: undefined, briefRefusal: undefined, last: res });
        void refreshCabinetState();
        setResult(res);
      })
      .catch(() => {
        if (cancelled) return;
        setErrorText(null);
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [live, attempt, navigate]);

  // Шаг прибавляется по таймеру, пока нет ошибки и сборка не закончена. В живом режиме последний этап ждёт ответа.
  const lastStep = live && !result ? STEPS_TOTAL - 1 : STEPS_TOTAL;
  useEffect(() => {
    if (error || step >= lastStep) return;
    const timer = window.setTimeout(() => setStep((s) => s + 1), live ? LIVE_STEP_INTERVAL_MS : STEP_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [step, error, lastStep, live]);
  useEffect(() => {
    if (live && result) setStep(STEPS_TOTAL);
  }, [live, result]);

  const done = step >= STEPS_TOTAL && !error;
  const scale = Math.min(step, STEPS_TOTAL) / STEPS_TOTAL;
  const totals = live ? totalsFromResponse(result) : null;
  const counts = CLAIM_TYPES.map((c) => ({ ...c, n: totals ? (done ? totals.claims[c.kind] : 0) : Math.round(c.max * scale) }));
  const total = counts.reduce((sum, c) => sum + c.n, 0);
  const blocksFilled = totals ? totals.filled : BLOCKS_FILLED;
  const blocksApproved = totals ? totals.approved : BLOCKS_APPROVED;
  const gapsLeft = totals ? totals.gaps : GAPS_LEFT;
  const retry = () => {
    setError(false);
    if (live) setAttempt((a) => a + 1);
  };

  return (
    <div className="ob-page">
      <OnboardingHeader
        current={3}
        trailing={
          live ? undefined : (
            <button type="button" onClick={() => setError((v) => !v)} className="gen-proto">
              Прототип: {error ? 'убрать ошибку' : 'показать ошибку'}
            </button>
          )
        }
      />

      <main className="gen-main">
        <section className="gen-left">
          <div className="gen-tile" aria-hidden="true">
            <svg width="88" height="88" viewBox="0 0 40 40">
              <path d="M7 7 L12 11 M33 7 L28 11" stroke="#17171C" strokeWidth="2.5" strokeLinecap="round" />
              <g className="gen-mark__eyes">
                <circle cx="13.5" cy="18" r="7" fill="#FFFFFF" />
                <circle cx="26.5" cy="18" r="7" fill="#FFFFFF" />
                <circle cx="15" cy="17" r="3" fill="#17171C" />
                <circle cx="28" cy="17" r="3" fill="#17171C" />
              </g>
              <path d="M17.5 27 L20 31 L22.5 27 Z" fill="#17171C" />
            </svg>
          </div>

          {!done && (
            <div className="gen-heading">
              <h1 className="ob-title ob-title--tight">Буха читает материалы</h1>
              <p className="ob-lead">Обычно это занимает 2–4 минуты. Можно закрыть страницу — результат сохранится в кабинете.</p>
            </div>
          )}

          {done && (
            <div className="gen-heading gen-heading--done">
              <h1 className="ob-title ob-title--tight">Черновик паспорта готов</h1>
              <ul aria-label="Итог сборки" className="gen-tiles">
                <li className="gen-tile-stat">
                  <span className="gen-tile-stat__label">Заполнено блоков</span>
                  <span className="gen-tile-stat__value">
                    <b className="gen-tile-stat__n">{blocksFilled}</b>
                    <span className="gen-tile-stat__of">из {BLOCKS_TOTAL}</span>
                  </span>
                  <span aria-hidden="true" className="gen-tile-stat__bar">
                    <span className="gen-tile-stat__fill" style={{ width: `${((blocksFilled / BLOCKS_TOTAL) * 100).toFixed(1)}%` }} />
                  </span>
                </li>
                <li className="gen-tile-stat">
                  <span className="gen-tile-stat__label">Одобрено аудитом</span>
                  <span className="gen-tile-stat__value">
                    <b className="gen-tile-stat__n gen-tile-stat__n--ok">{blocksApproved}</b>
                    <span className="gen-tile-stat__of">из {BLOCKS_TOTAL}</span>
                  </span>
                  <span aria-hidden="true" className="gen-tile-stat__bar">
                    <span className="gen-tile-stat__fill gen-tile-stat__fill--ok" style={{ width: `${((blocksApproved / BLOCKS_TOTAL) * 100).toFixed(1)}%` }} />
                  </span>
                </li>
                <li className="gen-tile-stat gen-tile-stat--warn">
                  <span className="gen-tile-stat__label">Осталось пробелов</span>
                  <span className="gen-tile-stat__value">
                    <b className="gen-tile-stat__n gen-tile-stat__n--warn">{gapsLeft}</b>
                  </span>
                  <span className="gen-tile-stat__note">включая направление и смету</span>
                </li>
              </ul>
              <div className="gen-actions">
                <Link to="/gaps" className="gen-cta gen-cta--primary">
                  Ответить на вопросы
                </Link>
                <Link to="/passport" className="gen-cta gen-cta--outline">
                  Сначала посмотреть паспорт
                </Link>
              </div>
            </div>
          )}

          {error && (
            <div role="alert" className="gen-error">
              <h2 className="gen-error__title">Не получилось разобрать блоки</h2>
              <p className="gen-error__text">{errorText ?? 'Сервис ИИ не ответил. Загруженные файлы сохранены, повтор ничего не потеряет.'}</p>
              <button type="button" onClick={retry} className="gen-error__retry">
                Повторить
              </button>
            </div>
          )}
        </section>

        <section className="gen-right">
          <ol aria-label="Этапы сборки" className="gen-steps">
            {STEPS.map((title, index) => {
              const isDone = index < step && !(error && index === step);
              const isActive = index === step && !error;
              const isPending = !isDone && !isActive;
              const rowClass = `gen-step${isActive ? ' gen-step--active' : ''}`;
              const titleClass = `gen-step__title${isPending ? ' gen-step__title--pending' : ''}`;
              return (
                <li key={title} className={rowClass}>
                  {isDone && (
                    <span className="gen-step__icon gen-step__icon--done">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#15803D" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12l5 5 9-10" />
                      </svg>
                    </span>
                  )}
                  {isActive && (
                    <span className="gen-step__icon">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="gen-spinner">
                        <circle cx="12" cy="12" r="9" className="gen-spinner__track" strokeWidth="3" />
                        <path d="M12 3a9 9 0 0 1 9 9" stroke="#FF6B1A" strokeWidth="3" strokeLinecap="round" />
                      </svg>
                    </span>
                  )}
                  {isPending && <span className="gen-step__icon gen-step__icon--pending" />}
                  <span className={titleClass}>{title}</span>
                </li>
              );
            })}
          </ol>

          <div className="gen-claims">
            <div className="gen-claims__head">
              <h2 className="gen-claims__title">Найдено утверждений</h2>
              <span className="gen-claims__total">{total}</span>
            </div>
            <div className="gen-claims__grid">
              {counts.map((c) => (
                <div key={c.kind} className="gen-claim">
                  <span className={`gen-swatch gen-swatch--${c.kind}`} aria-hidden="true" />
                  <span className="gen-claim__label">{c.label}</span>
                  <span className="gen-claim__n">{c.n}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
