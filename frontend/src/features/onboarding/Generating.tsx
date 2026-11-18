import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
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

export function Generating() {
  const [step, setStep] = useState(2);
  const [error, setError] = useState(false);

  // Шаг прибавляется каждые 1800 мс, пока нет ошибки и сборка не закончена.
  useEffect(() => {
    if (error || step >= STEPS_TOTAL) return;
    const timer = window.setTimeout(() => setStep((s) => s + 1), STEP_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [step, error]);

  const done = step >= STEPS_TOTAL && !error;
  const scale = Math.min(step, STEPS_TOTAL) / STEPS_TOTAL;
  const counts = CLAIM_TYPES.map((c) => ({ ...c, n: Math.round(c.max * scale) }));
  const total = counts.reduce((sum, c) => sum + c.n, 0);

  return (
    <div className="ob-page">
      <OnboardingHeader
        current={3}
        trailing={
          <button type="button" onClick={() => setError((v) => !v)} className="gen-proto">
            Прототип: {error ? 'убрать ошибку' : 'показать ошибку'}
          </button>
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
                    <b className="gen-tile-stat__n">{BLOCKS_FILLED}</b>
                    <span className="gen-tile-stat__of">из {BLOCKS_TOTAL}</span>
                  </span>
                  <span aria-hidden="true" className="gen-tile-stat__bar">
                    <span className="gen-tile-stat__fill" style={{ width: `${((BLOCKS_FILLED / BLOCKS_TOTAL) * 100).toFixed(1)}%` }} />
                  </span>
                </li>
                <li className="gen-tile-stat">
                  <span className="gen-tile-stat__label">Одобрено аудитом</span>
                  <span className="gen-tile-stat__value">
                    <b className="gen-tile-stat__n gen-tile-stat__n--ok">{BLOCKS_APPROVED}</b>
                    <span className="gen-tile-stat__of">из {BLOCKS_TOTAL}</span>
                  </span>
                  <span aria-hidden="true" className="gen-tile-stat__bar">
                    <span className="gen-tile-stat__fill gen-tile-stat__fill--ok" style={{ width: `${((BLOCKS_APPROVED / BLOCKS_TOTAL) * 100).toFixed(1)}%` }} />
                  </span>
                </li>
                <li className="gen-tile-stat gen-tile-stat--warn">
                  <span className="gen-tile-stat__label">Осталось пробелов</span>
                  <span className="gen-tile-stat__value">
                    <b className="gen-tile-stat__n gen-tile-stat__n--warn">{GAPS_LEFT}</b>
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
              <p className="gen-error__text">Сервис ИИ не ответил. Загруженные файлы сохранены, повтор ничего не потеряет.</p>
              <button type="button" onClick={() => setError(false)} className="gen-error__retry">
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
