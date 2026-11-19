import type { ReactNode } from 'react';
import { PillLink } from '../../shared/ui';
import './PricingCards.css';

// Три карточки тарифов: design/project/Pricing.dc.html и блок «Тарифы» в design/project/Main.dc.html.
// Разметка в обоих эталонах одна; отличается только уровень заголовка карточки (h2 на странице тарифов, h3 на лендинге).

export type Period = 'first' | 'renew';

export const PERIOD_OPTIONS = [
  { id: 'first', label: 'Первая оплата' },
  { id: 'renew', label: 'Продление' },
];

function Check({ off = false }: { off?: boolean }) {
  return off ? (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="plans__icon plans__icon--off">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ) : (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="plans__icon">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function Item({ children, off = false }: { children: ReactNode; off?: boolean }) {
  return (
    <li className={off ? 'plans__item plans__item--off' : 'plans__item'}>
      <Check off={off} />
      {children}
    </li>
  );
}

export interface PricingCardsProps {
  period: Period;
  /** Уровень заголовка с названием тарифа. */
  headingLevel: 2 | 3;
  className?: string;
}

export function PricingCards({ period, headingLevel, className }: PricingCardsProps) {
  const renew = period === 'renew';
  const proPrice = renew ? '841 ₽' : '990 ₽';
  const premPrice = renew ? '4 491 ₽' : '4 990 ₽';
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <div className={['plans', className].filter(Boolean).join(' ')}>
      <div className="plans__card">
        <div className="plans__head">
          <Heading className="plans__name">Базовый</Heading>
          <p className="plans__desc">Чтобы описать идею и увидеть, чего не хватает</p>
        </div>
        <p className="plans__price">0 ₽</p>
        <ul className="plans__list">
          <Item>Паспорт по 10 блокам</Item>
          <Item>Анкета и вопросы по пробелам</Item>
          <Item>Проверка стоп-факторов и чек-лист</Item>
          <Item>Загрузка документов — до 5 файлов</Item>
        </ul>
        <PillLink to="/auth" variant="outline" size="sm" className="plans__cta">Начать бесплатно</PillLink>
      </div>

      <div className="plans__card plans__card--featured">
        <span className="plans__badge">Рекомендуем</span>
        <div className="plans__head">
          <Heading className="plans__name">Профессиональный</Heading>
          <p className="plans__desc">Когда уже есть презентация или описание проекта</p>
        </div>
        <div className="plans__price-row">
          <p className="plans__price">{proPrice}</p>
          <span className="plans__period">за 30 дней</span>
        </div>
        {renew && <span className="plans__discount">Скидка 15% при продлении</span>}
        <ul className="plans__list">
          <Item>Всё из Базового</Item>
          <Item>Разбор PDF, DOCX, PPTX и сканов</Item>
          <Item>До 10 файлов</Item>
          <Item>Проверка новизны и аналогов</Item>
        </ul>
        <PillLink to="/auth" variant="brand" size="sm" className="plans__cta">Выбрать Профессиональный</PillLink>
      </div>

      <div className="plans__card">
        <div className="plans__head">
          <Heading className="plans__name">Премиум</Heading>
          <p className="plans__desc">Много материалов и помощь консультанта</p>
        </div>
        <div className="plans__price-row">
          <p className="plans__price">{premPrice}</p>
          <span className="plans__period">за 30 дней</span>
        </div>
        {renew && <span className="plans__discount">Скидка 10% при продлении</span>}
        <ul className="plans__list">
          <Item>Всё из Профессионального</Item>
          <Item>До 50 файлов</Item>
          <Item>Консультант</Item>
        </ul>
        <PillLink to="/auth" variant="outline" size="sm" className="plans__cta">Выбрать Премиум</PillLink>
      </div>
    </div>
  );
}
