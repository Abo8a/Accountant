import { useCallback, useEffect, useId, useState } from 'react';
import { useCabinetState } from '../../shared/state/cabinet';
import { fetchMe } from '../../shared/api/auth';
import { useCabinetShell } from '../../shared/layout/CabinetLayout';
import { DEFAULT_PLAN_ID, FLAGS } from '../../shared/config/flags';
import { PillLink } from '../../shared/ui';
import {
  CREDITS_EXPLAINED,
  FREE_AI_CREDITS,
  SERVICES,
  SERVICE_REQUEST_PATH,
  formatRub,
  getPlan,
  packAction,
  planOrFree,
  pluralCredits,
  pluralDays,
  type PlanId,
} from '../../shared/data/plans';
import { PlansModal } from './PlansModal';
import './Billing.css';

// Экран «Тариф и оплата» (F12). Оболочка и классы — design/project/Billing.dc.html; содержание — монетизация v2:
// бесплатный тариф (20 ИИ-кредитов один раз), «Пакет ИИ» (499 ₽ / 30 дней / 60 кредитов, без автопродления)
// и услуги специалистов. Эталона под новую модель нет — решение владельца: «в текущем стиле».
// Пока нет платёжного шлюза (FLAGS.HIDE_PAYMENT_GATEWAY = TRUE): окно оплаты, баннеры результата
// и строка нового платежа не рендерятся; кнопка «Подключить» открывает окно «Тарифы».

type PayResult = 'ok' | 'fail' | 'pending';

export interface BillingProps {
  /** Текущий пакет (живой режим — из состояния пользователя; по умолчанию — пример). */
  subscription?: { validUntil: string; daysLeft: number; filesUsed: number; filesLimit: number };
  /** ИИ-кредиты: остаток и из них платные (из «Пакета ИИ»). */
  credits?: { balance: number; paidBalance: number };
  /** Почта для чека. */
  email?: string;
  /** Показывать историю платежей (демо-строки). В живом режиме платежей пока нет. */
  showHistory?: boolean;
  /** Текущий тариф. По умолчанию — DEFAULT_PLAN_ID (бесплатный). */
  currentPlan?: PlanId;
}

const PACK = getPlan('ai_pack');

// Демо-значения для режима без бэкенда (витрина экранов).
const SUBSCRIPTION = { validUntil: '1 декабря 2026', daysLeft: 23, filesUsed: 3, filesLimit: 5 };
const CREDITS = { balance: 14, paidBalance: 0 };
const PAID_UNTIL = '31 декабря 2026';
const CHECKOUT_EMAIL = 'ivan@university.ru';
const NEW_PAYMENT_DATE = '8 ноября 2026';
const PREVIOUS_PAYMENT = { date: '1 ноября 2026', plan: PACK.name, sum: formatRub(PACK.price_rub) };

/** Живой режим: тариф, срок и ИИ-кредиты пользователя. */
export function LiveBilling() {
  const state = useCabinetState();
  const [email, setEmail] = useState('');
  useEffect(() => {
    void fetchMe().then((me) => setEmail(me?.email ?? ''));
  }, []);
  if (!state) return null;
  const until = state.plan_expires_at ? new Date(state.plan_expires_at) : null;
  const daysLeft = until ? Math.max(0, Math.ceil((until.getTime() - Date.now()) / 86_400_000)) : 0;
  return (
    <Billing
      currentPlan={planOrFree(state.plan_id).id}
      email={email}
      showHistory={false}
      credits={{ balance: state.ai_credits?.balance ?? 0, paidBalance: state.ai_credits?.paid_balance ?? 0 }}
      subscription={{
        validUntil: until ? until.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '') : '',
        daysLeft,
        filesUsed: state.files_used,
        filesLimit: state.files_limit,
      }}
    />
  );
}

const PAY_STATUS: Record<PayResult, { label: string; chip: string }> = {
  ok: { label: 'Оплачен', chip: 'billing__chip--ok' },
  fail: { label: 'Не прошёл', chip: 'billing__chip--fail' },
  pending: { label: 'Ожидает', chip: 'billing__chip--pending' },
};

/** Подпись под названием тарифа: срок пакета или остаток бесплатных кредитов. */
function heroSubtitle(plan: PlanId, subscription: NonNullable<BillingProps['subscription']>, credits: NonNullable<BillingProps['credits']>): string {
  if (plan === 'free') {
    return `Бесплатные ИИ-кредиты: осталось ${credits.balance} из ${FREE_AI_CREDITS}. Выдаются один раз.`;
  }
  const tail = plan === 'ai_pack' ? ' Автопродления нет.' : '';
  return `Действует до ${subscription.validUntil} · осталось ${subscription.daysLeft} ${pluralDays(subscription.daysLeft)}.${tail}`;
}

export function Billing({
  currentPlan = DEFAULT_PLAN_ID,
  subscription = SUBSCRIPTION,
  credits = CREDITS,
  email = CHECKOUT_EMAIL,
  showHistory = true,
}: BillingProps = {}) {
  // Отступы main из эталона Billing.dc.html (36px 48px 64px); остальное — значения шелла по умолчанию.
  useCabinetShell({ mainPadding: 'var(--space-36) var(--space-48) var(--space-64)' });

  const titleId = useId();
  const [checkout, setCheckout] = useState(false);
  const [result, setResult] = useState<PayResult | null>(null);
  const [plansOpen, setPlansOpen] = useState(false);
  const closePlans = useCallback(() => setPlansOpen(false), []);

  const paymentEnabled = !FLAGS.HIDE_PAYMENT_GATEWAY;
  const checkoutOpen = paymentEnabled && checkout;
  const payResult = paymentEnabled ? result : null;

  const plan = getPlan(currentPlan);
  const action = packAction(currentPlan, subscription.daysLeft);

  const pay = (next: PayResult) => {
    setCheckout(false);
    setResult(next);
  };

  // При включённом шлюзе — оплата пакета, пока шлюза нет — окно «Тарифы».
  const onConnect = () => (paymentEnabled ? setCheckout(true) : setPlansOpen(true));

  return (
    <div className="billing">
      <div className="billing__head">
        <h1 className="billing__title">Тариф и оплата</h1>
        <button type="button" className="billing__plans-open" onClick={() => setPlansOpen(true)}>
          Тарифы
        </button>
      </div>

      {payResult === 'ok' && (
        <div role="status" className="billing__banner billing__banner--ok">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#15803D" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="billing__banner-icon">
            <path d="M5 12l5 5 9-10" />
          </svg>
          <span className="billing__banner-text">
            <b className="billing__banner-strong">Оплата прошла.</b> {PACK.name} действует до {PAID_UNTIL}.
          </span>
          <button type="button" className="billing__banner-action" onClick={() => setResult(null)}>
            Закрыть
          </button>
        </div>
      )}

      {payResult === 'fail' && (
        <div role="alert" className="billing__banner billing__banner--fail">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#B91C1C" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" className="billing__banner-icon">
            <path d="M7 7l10 10M17 7L7 17" />
          </svg>
          <span className="billing__banner-text">
            <b className="billing__banner-strong">Платёж не прошёл.</b> Деньги не списаны. Попробуйте другую карту или СБП.
          </span>
          <button
            type="button"
            className="billing__banner-action billing__banner-action--retry"
            onClick={() => {
              setResult(null);
              setCheckout(true);
            }}
          >
            Повторить
          </button>
        </div>
      )}

      {payResult === 'pending' && (
        <div role="status" className="billing__banner billing__banner--pending">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#B45309" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="billing__banner-icon">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span className="billing__banner-text">
            <b className="billing__banner-strong">Ждём подтверждение от банка.</b> Обычно это пара минут — доступ откроется сам, страницу можно закрыть.
          </span>
          <button type="button" className="billing__banner-action" onClick={() => setResult(null)}>
            Скрыть
          </button>
        </div>
      )}

      <section className="billing__hero">
        <div className="billing__hero-main">
          <span className="billing__caption">Текущий тариф</span>
          <h2 className="billing__hero-title">{plan.name}</h2>
          <span className="billing__hero-sub">{heroSubtitle(currentPlan, subscription, credits)}</span>
        </div>
        <div className="billing__credits">
          <span className="billing__caption">ИИ-кредиты</span>
          <span className="billing__credits-value">{credits.balance}</span>
          <span className="billing__hero-sub">
            {credits.paidBalance > 0
              ? `из них ${credits.paidBalance} ${pluralCredits(credits.paidBalance)} пакета`
              : `${pluralCredits(credits.balance)} осталось`}
          </span>
        </div>
      </section>

      <p className="billing__plan-desc">{CREDITS_EXPLAINED}</p>

      <section className="billing__section">
        <h2 className="billing__section-title">Больше работы ИИ</h2>
        <div className="billing__plans">
          <div className="billing__plan">
            <h3 className="billing__plan-name">{PACK.name}</h3>
            <p className="billing__plan-desc">{PACK.description}</p>
            <p className="billing__plan-price">
              {formatRub(PACK.price_rub)} <span className="billing__plan-price-unit">за {PACK.duration_days} {pluralDays(PACK.duration_days)}</span>
            </p>
            {action.kind === 'note' ? (
              <span className="billing__plan-note">{action.text}</span>
            ) : (
              <button type="button" className="billing__plan-buy" onClick={onConnect}>
                {action.label}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="billing__section">
        <h2 className="billing__section-title">Услуги специалистов</h2>
        <div className="billing__plans">
          {SERVICES.map((service) => (
            <div key={service.id} className="billing__plan">
              <h3 className="billing__plan-name">{service.name}</h3>
              <p className="billing__plan-desc">{service.description}</p>
              <p className="billing__plan-price">
                {service.price} <span className="billing__plan-price-unit">{service.priceNote}</span>
              </p>
              <PillLink to={SERVICE_REQUEST_PATH} variant="outline" size="sm">
                Оставить заявку
              </PillLink>
            </div>
          ))}
        </div>
        <p className="billing__plan-note">Услуги оформляются отдельным договором и выбираются по желанию. Отказ от них не закрывает доступ к паспорту и материалам.</p>
      </section>

      {showHistory && (
        <section className="billing__section">
          <h2 className="billing__section-title">История платежей</h2>
          <div className="billing__table-wrap">
            <table className="billing__table">
              <thead>
                <tr>
                  <th scope="col">Дата</th>
                  <th scope="col">Тариф</th>
                  <th scope="col">Сумма</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Чек</th>
                </tr>
              </thead>
              <tbody>
                {payResult && (
                  <tr>
                    <td>{NEW_PAYMENT_DATE}</td>
                    <td>{PACK.name}</td>
                    <td>{formatRub(PACK.price_rub)}</td>
                    <td>
                      <span className={`billing__chip ${PAY_STATUS[payResult].chip}`}>{PAY_STATUS[payResult].label}</span>
                    </td>
                    <td className="billing__muted">—</td>
                  </tr>
                )}
                <tr>
                  <td>{PREVIOUS_PAYMENT.date}</td>
                  <td>{PREVIOUS_PAYMENT.plan}</td>
                  <td>{PREVIOUS_PAYMENT.sum}</td>
                  <td>
                    <span className="billing__chip billing__chip--ok">Оплачен</span>
                  </td>
                  <td>
                    <a href="#">Открыть</a>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {checkoutOpen && (
        <div className="billing__overlay">
          <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="billing__dialog">
            <div className="billing__dialog-head">
              <h2 id={titleId} className="billing__dialog-title">Оплата пакета</h2>
              <button type="button" aria-label="Закрыть" className="billing__close" onClick={() => setCheckout(false)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#17171C" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <dl className="billing__summary">
              <dt>Тариф</dt>
              <dd className="billing__summary-strong">{PACK.name}</dd>
              <dt>Период</dt>
              <dd>
                {PACK.duration_days} {pluralDays(PACK.duration_days)}
              </dd>
              <dt>ИИ-кредиты</dt>
              <dd>{PACK.ai_credits}</dd>
              <dt className="billing__total-label">К оплате</dt>
              <dd className="billing__total-value">{formatRub(PACK.price_rub)}</dd>
            </dl>
            <p className="billing__legal">
              Вы перейдёте на защищённую страницу ЮKassa. Автопродления нет. Чек придёт на {email}.
            </p>
            <button type="button" className="billing__pay" onClick={() => pay('ok')}>
              Перейти к оплате
            </button>
            <div className="billing__proto">
              <span>Прототип — исход оплаты:</span>
              <button type="button" className="billing__proto-btn" onClick={() => pay('fail')}>
                ошибка
              </button>
              <button type="button" className="billing__proto-btn" onClick={() => pay('pending')}>
                ожидание
              </button>
            </div>
          </div>
        </div>
      )}

      {plansOpen && <PlansModal onClose={closePlans} />}
    </div>
  );
}
