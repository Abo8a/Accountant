import { useState } from 'react';
import { SegmentedControl } from '../../shared/ui';
import { SiteLayout } from '../../shared/layout/SiteLayout';
import { PERIOD_OPTIONS, PricingCards, type Period } from './PricingCards';
import './Pricing.css';

// Тарифы: design/project/Pricing.dc.html. Тексты дословно из эталона; без подвала, как в эталоне.

// Строки таблицы сравнения: значение для Базового, Профессионального и Премиума. "off" — серое «Нет» или «—».
interface Cell {
  text: string;
  off?: boolean;
}
const YES: Cell = { text: 'Да' };
const NO: Cell = { text: 'Нет', off: true };

const COMPARISON: { feature: string; base: Cell; pro: Cell; premium: Cell }[] = [
  { feature: 'Паспорт по 10 блокам и разметка утверждений', base: YES, pro: YES, premium: YES },
  { feature: 'Анкета и вопросы по пробелам с примерами', base: YES, pro: YES, premium: YES },
  { feature: 'Стоп-факторы, статус допуска и чек-лист', base: YES, pro: YES, premium: YES },
  { feature: 'Экспорт в DOCX и PDF', base: YES, pro: YES, premium: YES },
  { feature: 'Разбор документов ИИ (PDF, DOCX, PPTX, сканы)', base: NO, pro: YES, premium: YES },
  { feature: 'Файлов в проекте', base: { text: '0' }, pro: { text: '10' }, premium: { text: '50' } },
  { feature: 'Проверка научно-технической новизны', base: NO, pro: YES, premium: YES },
  { feature: 'Консультант', base: NO, pro: NO, premium: YES },
  { feature: 'Скидка при продлении', base: { text: '—', off: true }, pro: { text: '15%' }, premium: { text: '10%' } },
];

export function Pricing() {
  const [period, setPeriod] = useState<Period>('first');

  return (
    <SiteLayout withFooter={false}>
      <section className="pricing__intro">
        <h1 className="pricing__title">Тарифы и цены</h1>
        <div className="pricing__toggle">
          <SegmentedControl
            mode="buttons"
            ariaLabel="Период оплаты"
            options={PERIOD_OPTIONS}
            value={period}
            onChange={(id) => setPeriod(id as Period)}
          />
        </div>
      </section>

      <section className="pricing__cards">
        <PricingCards period={period} headingLevel={2} />
      </section>

      <section className="pricing__table-section">
        <h2 className="t-screen-title">Сравнение возможностей</h2>
        <div className="pricing__table-wrap">
          <table className="pricing__table">
            <thead>
              <tr className="pricing__table-head">
                <th scope="col">Возможность</th>
                <th scope="col" className="pricing__th-center">Базовый</th>
                <th scope="col" className="pricing__th-center pricing__th-pro">Профессиональный</th>
                <th scope="col" className="pricing__th-center">Премиум</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.feature} className="pricing__table-row">
                  <th scope="row" className="pricing__row-title">{row.feature}</th>
                  <td className={row.base.off ? 'pricing__cell pricing__cell--off' : 'pricing__cell'}>{row.base.text}</td>
                  <td className={row.pro.off ? 'pricing__cell pricing__cell--off' : 'pricing__cell'}>{row.pro.text}</td>
                  <td className={row.premium.off ? 'pricing__cell pricing__cell--off' : 'pricing__cell'}>{row.premium.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </SiteLayout>
  );
}
