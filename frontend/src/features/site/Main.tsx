import { Link } from 'react-router-dom';
import { PillLink } from '../../shared/ui';
import { SiteLayout } from '../../shared/layout/SiteLayout';
import { PricingCards, ServiceCards } from './PricingCards';
import { Mascot } from './SiteArt';
import './Main.css';

// Лендинг: design/project/Main.dc.html. Тексты дословно из эталона.

const STEPS = [
  { n: '01', title: 'Расскажите о проекте', text: 'Загрузите презентацию или описание в PDF, DOCX, PPTX. Либо заполните анкету о проекте.' },
  { n: '02', title: 'Буха собирает паспорт', text: 'Раскладывает сведения по 10 блокам и размечает каждое утверждение.' },
  { n: '03', title: 'Закрываете пробелы', text: 'Отвечаете на точные вопросы и видите пример, как обычно пишут в заявках.' },
  { n: '04', title: 'Получаете итог', text: 'Паспорт проекта в DOCX и PDF, оформленный по шаблону и требованиям ФСИ, проверка на стоп-факторы и чек-лист документов.' },
];

// Фрагмент паспорта в блоке «Эксперт фонда»: три цвета утверждений.
const SAMPLE_CLAIMS = [
  { text: 'Провели две фокус-группы, 24 участника', label: 'Подтверждено документом', kind: 'doc' },
  { text: 'Над проектом работаем с марта 2026 года', label: 'Без документа', kind: 'nodoc' },
  { text: 'Запуск продаж — III квартал 2027 года', label: 'План или гипотеза', kind: 'plan' },
];

const PASSPORT_POINTS = [
  { title: 'Видно, что доказано, а что — слова', text: 'У каждого утверждения свой цвет: подтверждено документом, без документа, план или гипотеза.' },
  { title: 'ИИ не дописывает достижения', text: 'Нет в материалах охвата, выручки или пилота — Буха не придумает их, а спросит.' },
  { title: 'Новизна — минимум два аналога', text: 'Сравнение по конкретным параметрам и способ измеримой проверки, как требует фонд.' },
];

const FAQ = [
  { q: 'Буха гарантирует победу в конкурсе?', a: 'Нет. Буха помогает честно и полно описать проект и заранее увидеть формальные стоп-факторы. Решение принимает фонд.' },
  { q: 'Почему один аккаунт — один проект?', a: 'Паспорт привязан к описанию вашего проекта. Если загрузить материалы другого проекта, система их не примет — так паспорт не смешивает чужие факты с вашими.' },
  { q: 'Какие файлы можно загрузить?', a: 'PDF, DOCX и PPTX, включая сканы. Бесплатно — до 5 файлов, с «Пакетом ИИ» — до 10.' },
  { q: 'Что будет, когда закончатся ИИ-кредиты?', a: 'Паспорт, материалы, ручное редактирование и экспорт останутся. Работу ИИ можно продолжить с «Пакетом ИИ» — 499 ₽ за 30 дней, без автопродления.' },
  { q: 'Нужно ли платить процент после победы?', a: 'Нет, если вы готовили заявку сами. 5% от полученного финансирования — только за сопровождение по отдельному договору, заключённому заранее, и не из средств гранта.' },
  { q: 'Это официальный сервис фонда?', a: 'Нет. Буха — независимый сервис подготовки. Заявка подаётся в официальной системе фонда.' },
];

// Иконка из линий эталона: 56 px, обводка акцентным оранжевым (класс main__feature-icon).
function FeatureIcon({ paths }: { paths: string[] }) {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="main__feature-icon">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function Main() {
  return (
    <SiteLayout>
      <section className="main__hero">
        <div className="main__hero-text">
          <h1 className="t-display main__hero-title">Сервис быстрого описания проекта для грантов</h1>
          <p className="main__hero-lead">Расскажите идею или загрузите презентацию. Буха соберёт паспорт проекта по шаблону и требованиям фонда — в том виде, в котором его подают на конкурс. Найдёт пробелы и покажет, что мешает допуску.</p>
          <div className="main__hero-actions">
            <PillLink to="/auth" size="xl">
              Собрать паспорт бесплатно
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="main__arrow">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </PillLink>
            <Link to="/pricing" className="main__text-link">Посмотреть тарифы</Link>
          </div>
        </div>

        <div className="main__visual">
          <div className="main__visual-bg" />
          <div className="main__visual-mark">
            <Mascot size={96} variant="bare" />
          </div>
          <div className="main__visual-card">
            <div className="main__visual-card-head">
              <span className="main__visual-block">Блок 7 · Рынок, продажи и пилоты</span>
              <span className="main__visual-status">Нужна проверка</span>
            </div>
            <p className="main__visual-text">
              Команда получила <span className="main__mark main__mark--doc">выручку 10 000 рублей</span> и провела{' '}
              <span className="main__mark main__mark--nodoc">две фокус-группы по 25 участников</span>. В 2027 году{' '}
              <span className="main__mark main__mark--plan">планируются три платных пилота</span>.
            </p>
            <div className="main__tags">
              <span className="main__tag">Факт · презентация, стр. 10</span>
              <span className="main__tag">Без документа</span>
              <span className="main__tag">План или гипотеза</span>
            </div>
          </div>
          <div className="main__visual-warning">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="main__warning-icon">
              <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            <span>План продаж не попадёт в достижения</span>
          </div>
        </div>
      </section>

      <section className="main__features">
        <div className="main__feature">
          <FeatureIcon paths={['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5', 'M9 14l2 2 4-4']} />
          <h3 className="main__feature-title">Строго по шаблону фонда</h3>
          <p className="main__feature-text">Мы уже разобрались в требованиях конкурса за вас: паспорт собирается по форме фонда — с нужными разделами, порядком и объёмами.</p>
        </div>
        <div className="main__feature">
          <FeatureIcon paths={['M21.4 11.1l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8']} />
          <h3 className="main__feature-title">Источник у каждого факта</h3>
          <p className="main__feature-text">Файл, страница и цитата: видно, откуда взялась каждая цифра.</p>
        </div>
        <div className="main__feature">
          <FeatureIcon paths={['M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z', 'M12 8v5', 'M12 16h.01']} />
          <h3 className="main__feature-title">Стоп-факторы до подачи</h3>
          <p className="main__feature-text">Статус заявителя, права на РИД, аналоги — проверяем по правилам программы, чтобы вам не отказали уже после подачи.</p>
        </div>
      </section>

      <section id="how" className="main__section main__section--how">
        <h2 className="t-title">Как это работает</h2>
        <div className="main__steps">
          {STEPS.map((step, index) => (
            <div key={step.n} className={index === STEPS.length - 1 ? 'main__step main__step--accent' : 'main__step'}>
              <span className="main__step-num">{step.n}</span>
              <h3 className="main__step-title">{step.title}</h3>
              <p className="main__step-text">{step.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="passport" className="main__section main__section--passport">
        <div className="main__passport-head">
          <h2 className="t-title main__passport-title">Эксперт фонда заметит приукрашивание. Буха — раньше</h2>
          <p className="main__passport-lead">ИИ работает только с тем, что вы дали. Всё, чего нет в материалах, превращается в вопрос, а не в красивую фразу.</p>
        </div>
        <div className="main__passport-grid">
          <figure className="main__sample">
            <div className="main__sample-sheet">
              <figcaption className="main__sample-caption">Блок 7 · Фрагмент паспорта</figcaption>
              <ul className="main__sample-claims">
                {SAMPLE_CLAIMS.map((claim) => (
                  <li key={claim.kind} className="main__sample-claim">
                    <span className={`main__sample-text main__sample-text--${claim.kind}`}>{claim.text}</span>
                    <span className={`main__sample-label main__sample-label--${claim.kind}`}>{claim.label}</span>
                  </li>
                ))}
              </ul>
              <div className="main__sample-question">
                <span className="main__sample-struck">Сервисом воспользуются 10 000 человек</span>
                <span className="main__sample-ask">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" aria-hidden="true" className="main__sample-ask-icon">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v5M12 16h.01" />
                  </svg>
                  Нет в материалах. Вопрос: сколько пользователей уже прошло пилот?
                </span>
              </div>
            </div>
          </figure>
          <div className="main__points">
            {PASSPORT_POINTS.map((point) => (
              <div key={point.title} className="main__point">
                <h3 className="main__point-title">{point.title}</h3>
                <p className="main__point-text">{point.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="main__section main__section--tariffs">
        <div className="main__tariffs-head">
          <h2 className="t-title">Тарифы</h2>
          <Link to="/pricing" className="main__compare-link">
            Подробнее о тарифах
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14" />
              <path d="M13 6l6 6-6 6" />
            </svg>
          </Link>
        </div>
        <PricingCards headingLevel={3} className="main__plans" />
        <h3 className="t-screen-title main__services-title">Услуги специалистов</h3>
        <ServiceCards headingLevel={3} className="main__plans" />
      </section>

      <section id="faq" className="main__section main__section--faq">
        <h2 className="t-title">Вопросы</h2>
        <div className="main__faq">
          {FAQ.map((item) => (
            <details key={item.q} className="main__faq-item">
              <summary className="main__faq-q">{item.q}</summary>
              <p className="main__faq-a">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="main__cta-wrap">
        <div className="main__cta">
          <div className="main__cta-text">
            <h2 className="t-title main__cta-title">Начните с того, что уже есть</h2>
            <p className="main__cta-lead">Пара абзацев об идее — и через несколько минут у вас черновик паспорта и список вопросов.</p>
            <PillLink to="/auth" variant="ink" size="lg" className="main__cta-button">Собрать паспорт бесплатно</PillLink>
          </div>
          <Mascot size={200} variant="tile" />
        </div>
      </section>
    </SiteLayout>
  );
}
