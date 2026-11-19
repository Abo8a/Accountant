import { SiteLayout } from '../../shared/layout/SiteLayout';
import { PricingCards, ServiceCards } from './PricingCards';
import './Pricing.css';

// Тарифы: оболочка и таблица — по design/project/Pricing.dc.html; содержание — монетизация v2
// (бесплатно с 20 ИИ-кредитами один раз, «Пакет ИИ» 499 ₽ / 30 дней / 60 кредитов, услуги специалистов).
// Переключатель «Первая оплата / Продление» убран: скидок при продлении и автопродления больше нет.

// Строки таблицы сравнения: значение для бесплатного тарифа и «Пакета ИИ». "off" — серое «Нет» или «—».
interface Cell {
  text: string;
  off?: boolean;
}
const YES: Cell = { text: 'Да' };

const COMPARISON: { feature: string; free: Cell; pack: Cell }[] = [
  { feature: 'Паспорт по 10 блокам и разметка утверждений', free: YES, pack: YES },
  { feature: 'Анкета и вопросы по пробелам с примерами', free: YES, pack: YES },
  { feature: 'Стоп-факторы, статус допуска и чек-лист', free: YES, pack: YES },
  { feature: 'Ручное редактирование, сохранение и экспорт в DOCX и PDF', free: YES, pack: YES },
  { feature: 'Разбор документов ИИ (PDF, DOCX, PPTX, сканы)', free: YES, pack: YES },
  { feature: 'Проверка научно-технической новизны', free: YES, pack: YES },
  { feature: 'Консультант', free: YES, pack: YES },
  { feature: 'Файлов в проекте', free: { text: '5' }, pack: { text: '10' } },
  { feature: 'ИИ-кредиты', free: { text: '20 один раз' }, pack: { text: '60 на 30 дней' } },
  { feature: 'Автопродление', free: { text: '—', off: true }, pack: { text: 'Нет' } },
];

export function Pricing() {
  return (
    <SiteLayout withFooter={false}>
      <section className="pricing__intro">
        <h1 className="pricing__title">Тарифы и цены</h1>
        <p className="pricing__lead">Самостоятельная подготовка бесплатна. Работа ИИ ограничена кредитами, сопровождение — по отдельному договору.</p>
      </section>

      <section className="pricing__cards">
        <PricingCards headingLevel={2} />
      </section>

      <section className="pricing__table-section">
        <h2 className="t-screen-title">Сравнение возможностей</h2>
        <div className="pricing__table-wrap">
          <table className="pricing__table">
            <thead>
              <tr className="pricing__table-head">
                <th scope="col">Возможность</th>
                <th scope="col" className="pricing__th-center">Бесплатно</th>
                <th scope="col" className="pricing__th-center pricing__th-pro">Пакет ИИ</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.feature} className="pricing__table-row">
                  <th scope="row" className="pricing__row-title">{row.feature}</th>
                  <td className={row.free.off ? 'pricing__cell pricing__cell--off' : 'pricing__cell'}>{row.free.text}</td>
                  <td className={row.pack.off ? 'pricing__cell pricing__cell--off' : 'pricing__cell'}>{row.pack.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="pricing__table-section">
        <h2 className="t-screen-title">Услуги специалистов</h2>
        <ServiceCards headingLevel={3} />
      </section>
    </SiteLayout>
  );
}
