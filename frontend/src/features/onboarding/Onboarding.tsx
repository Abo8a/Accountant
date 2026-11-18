import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { env } from '../../shared/config/env';
import { callPassportPipeline } from '../../shared/api/pipeline';
import { saveFounder } from '../../shared/api/profile';
import { saveFlow } from '../../shared/state/flow';
import { OnboardingHeader } from './OnboardingHeader';
import './common.css';
import './Onboarding.css';

// Экран «Профиль основателя» — design/project/Onboarding.dc.html (блок 1 паспорта).
// Внизу профиля — анкета допуска «Условия участия»: отдельного экрана допуска больше нет.

// Вопросы допуска, нужные ответы, причины отказа и способы исправления — как в manifest.json бэкенда (eligibility).
// Подсказки под вопросами — из эталона. В живом режиме решение и причины отказа приходят с бэкенда.
interface EligibilityQuestion {
  key: string;
  text: string;
  hint: string;
  need: boolean;
  reason: string;
  fix: string;
}

const ELIGIBILITY: EligibilityQuestion[] = [
  {
    key: 'is_student_or_postgraduate',
    text: 'Вы являетесь студентом или аспирантом?',
    hint: 'Для участия нужно быть студентом или аспирантом.',
    need: true,
    reason: 'Нет статуса студента или аспиранта.',
    fix: 'Участвовать в программе могут только студенты и аспиранты.',
  },
  {
    key: 'has_open_fsi_contracts_or_applications',
    text: 'Есть ли у вас открытые договоры или заявки в Фонде содействия инновациям (ФСИ)?',
    hint: 'У вас не должно быть открытых договоров и заявок в Фонде.',
    need: false,
    reason: 'Есть открытые договоры или заявки в ФСИ.',
    fix: 'Участие возможно только при отсутствии открытых договоров и заявок в Фонде.',
  },
  {
    key: 'has_prior_student_startup_grant',
    text: 'Получали ли вы ранее грант «Студенческий стартап»?',
    hint: 'Участвовать можно, только если вы раньше не получали этот грант.',
    need: false,
    reason: 'Ранее вы получали грант «Студенческий стартап».',
    fix: 'Повторно получить этот грант нельзя.',
  },
  {
    key: 'ready_to_open_llc_after_win',
    text: 'Готовы ли вы открыть новое ООО после победы в конкурсе?',
    hint: 'Это обязательное условие участия в конкурсе: грант получает новое ООО, зарегистрированное после победы.',
    need: true,
    reason: 'Вы не готовы открыть новое ООО после победы.',
    fix: 'Грант предполагает регистрацию нового ООО после победы. Без этого участие невозможно.',
  },
];

interface RejectReason {
  key: string;
  reason: string;
  fix: string;
}

// Ответы для переключателя «Прототип: Допуск / Отказ» из эталона.
const DEMO_PASS: Record<string, boolean> = {
  is_student_or_postgraduate: true,
  has_open_fsi_contracts_or_applications: false,
  has_prior_student_startup_grant: false,
  ready_to_open_llc_after_win: true,
};
const DEMO_FAIL: Record<string, boolean> = { ...DEMO_PASS, has_open_fsi_contracts_or_applications: true };

function localReasons(answers: Record<string, boolean>): RejectReason[] {
  return ELIGIBILITY.filter((q) => answers[q.key] !== undefined && answers[q.key] !== q.need).map((q) => ({ key: q.key, reason: q.reason, fix: q.fix }));
}

function ArrowRight() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

interface CheckToggleProps {
  checked: boolean;
  onToggle: () => void;
  variant: 'lg' | 'sm';
  children: string;
}

function CheckToggle({ checked, onToggle, variant, children }: CheckToggleProps) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} onClick={onToggle} className={`ob-check ob-check--${variant}`}>
      <span className="ob-check__box">
        {checked && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#17171C" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12l5 5 9-10" />
          </svg>
        )}
      </span>
      {children}
    </button>
  );
}

export function Onboarding() {
  const navigate = useNavigate();
  const [studying, setStudying] = useState(true);
  const [noMiddle, setNoMiddle] = useState(false);
  const [middleName, setMiddleName] = useState('Иванович');
  const [understood, setUnderstood] = useState(true);
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [rejected, setRejected] = useState<RejectReason[] | null>(null);
  const [busy, setBusy] = useState(false);

  const answered = ELIGIBILITY.filter((q) => answers[q.key] !== undefined).length;
  const allAnswered = answered === ELIGIBILITY.length;
  const answer = (key: string, value: boolean) => setAnswers((prev) => ({ ...prev, [key]: value }));

  // Валидация — нативная (атрибуты required у полей): без заполненных обязательных полей переход не происходит.
  const [saveError, setSaveError] = useState<string | null>(null);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!allAnswered) return;
    if (!env.liveApi) {
      const reasons = localReasons(answers);
      if (reasons.length > 0) setRejected(reasons);
      else navigate('/brief');
      return;
    }
    // Живой режим: сохраняем данные основателя, затем отправляем ответы допуска. Решение принимает бэкенд.
    const form = event.currentTarget;
    const value = (id: string) => (form.querySelector<HTMLInputElement>(`#${id}`)?.value ?? '').trim();
    const founder = {
      full_name: [value('lastName'), value('firstName'), noMiddle ? '' : middleName.trim()].filter(Boolean).join(' '),
      contacts: [value('phone'), value('tg')].filter(Boolean).join(', ') || undefined,
      university: value('uni') || undefined,
    };
    setSaveError(null);
    setBusy(true);
    try {
      const ok = await saveFounder(founder);
      if (!ok) {
        setSaveError('Не удалось сохранить данные. Попробуйте ещё раз.');
        return;
      }
      saveFlow({ founder });
      const eligibility = Object.fromEntries(ELIGIBILITY.map((q) => [q.key, answers[q.key]]));
      const res = await callPassportPipeline({ action: 'init_or_upload', eligibility });
      if (res.status === 'REJECTED') {
        setRejected(res.reasons.map((r) => ({ key: r.key, reason: r.reason, fix: r.how_to_fix })));
        return;
      }
      if (res.status === 'ERROR') {
        setSaveError(res.message);
        return;
      }
      saveFlow({ last: res });
      navigate('/brief');
    } catch {
      setSaveError('Не удалось отправить ответы. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  const demoSwitch = env.liveApi ? null : (
    <div role="group" aria-label="Вариант для прототипа" className="onb-proto">
      <span className="onb-proto__label">Прототип:</span>
      <button
        type="button"
        aria-pressed={!rejected}
        className="onb-proto__btn"
        onClick={() => {
          setRejected(null);
          setAnswers(DEMO_PASS);
        }}
      >
        Допуск
      </button>
      <button
        type="button"
        aria-pressed={!!rejected}
        className="onb-proto__btn"
        onClick={() => {
          setAnswers(DEMO_FAIL);
          setRejected(localReasons(DEMO_FAIL));
        }}
      >
        Отказ
      </button>
    </div>
  );

  const heading = (
    <div className="onb-top">
      <div className="onb-heading">
        <p className="onb-eyebrow">Блок 1 паспорта</p>
        <h1 className="ob-title">Расскажите о себе</h1>
      </div>
      {demoSwitch}
    </div>
  );

  if (rejected) {
    return (
      <div className="ob-page">
        <OnboardingHeader current={1} trailing={<span className="obh__email">ivan@university.ru</span>} />
        <main className="onb-main onb-main--stack">
          {heading}
          <section role="alert" className="onb-reject">
            <div className="onb-reject__head">
              <span className="onb-reject__icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M7 7l10 10M17 7L7 17" />
                </svg>
              </span>
              <div className="onb-reject__titles">
                <h2 className="onb-reject__title">Проект не проходит проверку допуска</h2>
                <p className="onb-reject__lead">Решение окончательное: с этими ответами собрать паспорт для программы нельзя.</p>
              </div>
            </div>
            <ul className="onb-reject__list">
              {rejected.map((r) => (
                <li key={r.key} className="onb-reject__item">
                  <span className="onb-reject__reason">{r.reason}</span>
                  <span className="onb-reject__fix">{r.fix}</span>
                </li>
              ))}
            </ul>
            <p className="onb-reject__note">Ответили по ошибке? Напишите в поддержку — проверим вручную.</p>
            <div className="onb-reject__actions">
              <Link to="/support" className="onb-reject__support">
                Написать в поддержку
              </Link>
              <Link to="/" className="onb-reject__home">
                На главную
              </Link>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="ob-page">
      <OnboardingHeader current={1} trailing={<span className="obh__email">ivan@university.ru</span>} />
      <main className="onb-main">
        <form className="onb-form" onSubmit={onSubmit}>
          {heading}

          <section className="onb-fields">
            <fieldset aria-label="ФИО" className="onb-name">
              <div className="onb-name__row">
                <div className="ob-field">
                  <label htmlFor="lastName" className="ob-label">
                    Фамилия<span aria-hidden="true" className="ob-required"> *</span>
                  </label>
                  <input id="lastName" className="ob-input" required aria-required="true" type="text" defaultValue="Иванов" autoComplete="family-name" />
                </div>
                <div className="ob-field">
                  <label htmlFor="firstName" className="ob-label">
                    Имя<span aria-hidden="true" className="ob-required"> *</span>
                  </label>
                  <input id="firstName" className="ob-input" required aria-required="true" type="text" defaultValue="Иван" autoComplete="given-name" />
                </div>
                <div className="ob-field">
                  <label htmlFor="middleName" className="ob-label">
                    Отчество
                    {!noMiddle && (
                      <span aria-hidden="true" className="ob-required"> *</span>
                    )}
                  </label>
                  <input
                    id="middleName"
                    className="ob-input"
                    type="text"
                    required={!noMiddle}
                    aria-required={noMiddle ? undefined : true}
                    disabled={noMiddle}
                    value={noMiddle ? '' : middleName}
                    placeholder={noMiddle ? 'Не указывается' : undefined}
                    onChange={(event) => setMiddleName(event.target.value)}
                    autoComplete="additional-name"
                  />
                  <CheckToggle variant="sm" checked={noMiddle} onToggle={() => setNoMiddle((v) => !v)}>
                    Нет отчества
                  </CheckToggle>
                </div>
              </div>
              <span className="onb-hint">После создания проекта ФИО можно изменить только через поддержку.</span>
            </fieldset>

            <div className="ob-field">
              <label htmlFor="phone" className="ob-label ob-label--strong">
                Телефон<span aria-hidden="true" className="ob-required"> *</span>
              </label>
              <input id="phone" className="ob-input" required aria-required="true" type="tel" placeholder="+7 900 000-00-00" />
            </div>

            <div className="ob-field">
              <label htmlFor="tg" className="ob-label ob-label--strong">
                Telegram
              </label>
              <input id="tg" className="ob-input" type="text" placeholder="@username" />
            </div>

            <fieldset className="onb-study">
              <legend className="onb-study__legend">Обучение</legend>
              <CheckToggle variant="lg" checked={studying} onToggle={() => setStudying((v) => !v)}>
                Учусь в настоящее время
              </CheckToggle>

              {studying && (
                <div className="onb-study__panel">
                  <div className="ob-field onb-study__uni">
                    <label htmlFor="uni" className="ob-label">
                      Вуз<span aria-hidden="true" className="ob-required"> *</span>
                    </label>
                    <input id="uni" className="ob-input" type="text" placeholder="Полное название вуза" required aria-required="true" />
                  </div>
                  <div className="ob-field">
                    <label htmlFor="level" className="ob-label">
                      Уровень<span aria-hidden="true" className="ob-required"> *</span>
                    </label>
                    <select id="level" className="ob-select" required aria-required="true" defaultValue="">
                      <option value="">Выберите</option>
                      <option>Бакалавриат</option>
                      <option>Специалитет</option>
                      <option>Магистратура</option>
                      <option>Аспирантура</option>
                    </select>
                  </div>
                  <div className="ob-field">
                    <label htmlFor="course" className="ob-label">
                      Курс<span aria-hidden="true" className="ob-required"> *</span>
                    </label>
                    <select id="course" className="ob-select" required aria-required="true" defaultValue="">
                      <option value="">—</option>
                      <option>1</option>
                      <option>2</option>
                      <option>3</option>
                      <option>4</option>
                      <option>5</option>
                      <option>6</option>
                    </select>
                  </div>
                </div>
              )}

              {!studying && (
                <div role="status" className="onb-warning">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="onb-warning__icon">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v5M12 16h.01" />
                  </svg>
                  <span>Участвовать в «Студенческом стартапе» могут только студенты и аспиранты.</span>
                </div>
              )}
            </fieldset>

            <div className="ob-field">
              <label htmlFor="region" className="ob-label ob-label--strong">
                Регион<span aria-hidden="true" className="ob-required"> *</span>
              </label>
              <select id="region" className="ob-select" required aria-required="true" defaultValue="">
                <option value="">Выберите регион</option>
                <option>Москва</option>
                <option>Санкт-Петербург</option>
                <option>Республика Татарстан</option>
              </select>
            </div>
          </section>

          <section className="onb-programs">
            <h2 className="onb-programs__title">Программа поддержки</h2>
            <div className="onb-programs__grid">
              <button type="button" aria-pressed="true" className="onb-program onb-program--active">
                <span className="onb-program__head">
                  <span className="onb-program__name">Студенческий стартап</span>
                  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="12" cy="12" r="11" fill="#FF6B1A" />
                    <path d="M7 12l3.5 3.5L17 9" fill="none" stroke="#17171C" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="onb-program__sub">ФСИ · грант для студентов и аспирантов</span>
              </button>
              <div aria-disabled="true" className="onb-program onb-program--disabled">
                <span className="onb-program__head">
                  <span className="onb-program__name">Старт-1</span>
                  <span className="onb-badge">Скоро</span>
                </span>
                <span className="onb-program__sub-plain">ФСИ · для малых инновационных компаний</span>
              </div>
              <div aria-disabled="true" className="onb-program onb-program--disabled">
                <span className="onb-program__head">
                  <span className="onb-program__name">Сколково</span>
                  <span className="onb-badge">Скоро</span>
                </span>
                <span className="onb-program__sub-plain">Статус участника и микрогранты</span>
              </div>
            </div>
          </section>

          <section aria-labelledby="elig-title" className="onb-elig">
            <h2 id="elig-title" className="onb-elig__title">
              Условия участия<span aria-hidden="true" className="ob-required"> *</span>
            </h2>
            <div className="onb-elig__list">
              {ELIGIBILITY.map((q, index) => (
                <fieldset key={q.key} className="onb-elig__item">
                  <legend className="onb-elig__legend">{q.text}</legend>
                  <span aria-hidden="true" className="onb-elig__question">
                    <span className="onb-elig__num">{index + 1}</span>
                    <span className="onb-elig__texts">
                      <span>{q.text}</span>
                      <span className="onb-elig__hint">{q.hint}</span>
                    </span>
                  </span>
                  <span className="onb-elig__answers">
                    <button type="button" aria-pressed={answers[q.key] === true} onClick={() => answer(q.key, true)} className="onb-elig__btn">
                      Да
                    </button>
                    <button type="button" aria-pressed={answers[q.key] === false} onClick={() => answer(q.key, false)} className="onb-elig__btn">
                      Нет
                    </button>
                  </span>
                </fieldset>
              ))}
            </div>
          </section>

          <section className="onb-owner">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="onb-owner__icon">
              <rect x="4" y="10" width="16" height="11" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            <div className="onb-owner__body">
              <h2 className="onb-owner__title">Один аккаунт — один проект</h2>
              <p className="onb-owner__text">Первое описание станет «якорем» проекта. Материалы другого проекта система не примет, а ФИО закрепится за этим проектом.</p>
              <label className="onb-owner__ack">
                <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} className="onb-owner__checkbox" />
                Понятно
              </label>
            </div>
          </section>

          <div className="onb-footer">
            <p className="onb-legend">
              <span className="ob-required">*</span> — обязательные поля
            </p>
            <span className="onb-footer__actions">
              {!allAnswered && <span className="onb-footer__count">Условия участия: {answered} из 4</span>}
              <button type="submit" className="ob-btn-primary" disabled={!allAnswered || busy}>
                Продолжить
                <ArrowRight />
              </button>
            </span>
          </div>
          {saveError && (
            <p role="alert" className="onb-error">
              {saveError}
            </p>
          )}
        </form>
      </main>
    </div>
  );
}
