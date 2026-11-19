import type { ReactNode } from 'react';
import { PillLink } from '../../shared/ui';
import { CREDITS_EXPLAINED, SERVICES, SERVICE_REQUEST_PATH, type ServiceOffer } from '../../shared/data/plans';
import './PricingCards.css';

// Карточки тарифов и услуг (монетизация v2). Вёрстка — в стиле прежних карточек design/project/Pricing.dc.html
// (те же классы, отступы и токены); эталона под новую модель в design/project нет — решение владельца: «в текущем стиле».
// Тарифы: бесплатный (20 ИИ-кредитов один раз) и «Пакет ИИ» (499 ₽ за 30 дней, 60 кредитов, без автопродления).
// Услуги: сопровождение после результата (5%, максимум 50 000 ₽) и отчёт по этапу (от 14 900 ₽).

function Check() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="plans__icon">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

function Item({ children }: { children: ReactNode }) {
  return (
    <li className="plans__item">
      <Check />
      {children}
    </li>
  );
}

export interface PricingCardsProps {
  /** Уровень заголовка с названием тарифа. */
  headingLevel: 2 | 3;
  className?: string;
}

export function PricingCards({ headingLevel, className }: PricingCardsProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <div className={['plans-wrap', className].filter(Boolean).join(' ')}>
      <div className="plans plans--two">
        <div className="plans__card">
          <div className="plans__head">
            <Heading className="plans__name">Бесплатно</Heading>
            <p className="plans__desc">Чтобы собрать паспорт и увидеть, чего не хватает</p>
          </div>
          <p className="plans__price">0 ₽</p>
          <ul className="plans__list">
            <Item>Один проект и паспорт по 10 блокам</Item>
            <Item>Анкета, вопросы по пробелам, стоп-факторы и чек-лист</Item>
            <Item>Ручное редактирование, сохранение и экспорт</Item>
            <Item>Загрузка документов — до 5 файлов</Item>
            <Item>20 ИИ-кредитов — один раз</Item>
          </ul>
          <PillLink to="/auth" variant="outline" size="sm" className="plans__cta">Начать бесплатно</PillLink>
        </div>

        <div className="plans__card plans__card--featured">
          <div className="plans__head">
            <Heading className="plans__name">Пакет ИИ</Heading>
            <p className="plans__desc">Когда нужно доработать разделы, проверить и подготовить материалы</p>
          </div>
          <div className="plans__price-row">
            <p className="plans__price">499 ₽</p>
            <span className="plans__period">за 30 дней</span>
          </div>
          <span className="plans__discount">Без автопродления</span>
          <ul className="plans__list">
            <Item>Всё из бесплатного</Item>
            <Item>60 ИИ-кредитов на 30 дней</Item>
            <Item>До 10 файлов</Item>
            <Item>После окончания паспорт и тексты остаются у вас</Item>
          </ul>
          <PillLink to="/auth" variant="brand" size="sm" className="plans__cta">Подключить пакет</PillLink>
        </div>
      </div>
      <p className="plans__footnote">{CREDITS_EXPLAINED}</p>
    </div>
  );
}

export interface ServiceCardsProps {
  headingLevel: 2 | 3;
  className?: string;
}

function ServiceCard({ service, Heading }: { service: ServiceOffer; Heading: 'h2' | 'h3' }) {
  return (
    <div className="plans__card">
      <div className="plans__head">
        <Heading className="plans__name">{service.name}</Heading>
        <p className="plans__desc">{service.description}</p>
      </div>
      <div className="plans__price-row">
        <p className="plans__price">{service.price}</p>
        <span className="plans__period">{service.priceNote}</span>
      </div>
      <ul className="plans__list">
        {service.items.map((item) => (
          <Item key={item}>{item}</Item>
        ))}
      </ul>
      <PillLink to={SERVICE_REQUEST_PATH} variant="outline" size="sm" className="plans__cta">Оставить заявку</PillLink>
    </div>
  );
}

/** Услуги специалистов: отдельный договор, цена и условия видны до решения. */
export function ServiceCards({ headingLevel, className }: ServiceCardsProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={['plans-wrap', className].filter(Boolean).join(' ')}>
      <div className="plans plans--two">
        {SERVICES.map((service) => (
          <ServiceCard key={service.id} service={service} Heading={Heading} />
        ))}
      </div>
      <p className="plans__footnote">
        Услуги оформляются отдельным договором и выбираются по желанию. Отказ от них не закрывает доступ к паспорту и материалам.
      </p>
    </div>
  );
}
