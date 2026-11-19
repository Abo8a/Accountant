import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BrandMark } from '../../shared/ui/Logo/Logo';
import { env } from '../../shared/config/env';
import { getPlan } from '../../shared/data/plans';
import { loadFlow, saveFlow } from '../../shared/state/flow';
import { OnboardingHeader } from './OnboardingHeader';
import { ConsultantWidget } from '../consultant/ConsultantWidget';
import './common.css';
import './Brief.css';

// Стартовый бриф — design/project/Brief.dc.html. Три состояния: «есть файлы?» (ask),
// «Материалы загружены» (files) и анкета (form). Загрузка открыта на любом тарифе: бесплатный — до 5 файлов,
// «Пакет ИИ» — до 10 (в эталоне у «Базового» был пейволл — политика тарифов изменена по решению владельца, монетизация v2).

type Step = 'ask' | 'files' | 'form';
type Plan = 'free' | 'ai_pack';
type FileKind = 'ready' | 'scan' | 'duplicate';

interface UploadedFile {
  id: string;
  name: string;
  meta: string;
  kind: FileKind;
}

// Состояние прототипа из эталона: один файл распознан, один скан, один дубликат (не считается в лимит).
const INITIAL_FILES: UploadedFile[] = [
  { id: 'f1', name: 'Monetrix_presentation_02.11.pdf', meta: '15 страниц · 4,2 МБ', kind: 'ready' },
  { id: 'f2', name: 'Svidetelstvo_RID_scan.pdf', meta: 'Скан · 2 страницы', kind: 'scan' },
  { id: 'f3', name: 'Monetrix_presentation_02.11 (1).pdf', meta: 'Этот файл уже загружен — повторно не разбираем и в лимит не считаем', kind: 'duplicate' },
];

const QUESTIONS = [
  { id: 'q1', n: 1, q: 'Какую проблему решает проект и для кого?', ex: 'Сведения о мерах поддержки распределены между разными источниками; пользователю трудно собрать последовательность действий.' },
  { id: 'q2', n: 2, q: 'Что делает продукт?', ex: 'Единый профиль потребности, проверяемый справочник, подготовка черновика обращения и передача сложного вопроса координатору.' },
  { id: 'q3', n: 3, q: 'Что уже сделано, а что в планах?', ex: 'Есть макеты интерфейса; рабочий прототип планируется к концу первого этапа.' },
  { id: 'q4', n: 4, q: 'Кто в команде и чем занимается?', ex: 'Иван Иванов — руководитель проекта и продуктовая аналитика; разработчик — бэкенд и ИИ-модуль.' },
];

export function Brief() {
  const navigate = useNavigate();
  // Живой режим: разбор файлов к бэкенду пока не подключён (нет хранилища файлов), поэтому сразу анкета.
  const [step, setStep] = useState<Step>(env.liveApi ? 'form' : 'ask');
  const [draft] = useState<Record<string, string>>(() => (env.liveApi ? loadFlow().briefDraft ?? {} : {}));
  const [refusal] = useState(() => (env.liveApi ? loadFlow().briefRefusal ?? null : null));
  const [plan, setPlan] = useState<Plan>('ai_pack');
  const [files, setFiles] = useState<UploadedFile[]>(INITIAL_FILES);

  const free = plan === 'free';
  // Загрузка доступна на любом тарифе; различается только лимит файлов (бесплатный — 5, «Пакет ИИ» — 10).
  const fileLimit = getPlan(plan).file_uploads_limit;
  const current: Step = step;
  const canUpload = !env.liveApi;
  const used = files.filter((f) => f.kind !== 'duplicate').length;
  const submitLabel = current === 'files' ? 'Собрать паспорт по файлам' : 'Собрать паспорт';

  // Валидация анкеты — нативная (required у вопросов): без ответов переход не происходит.
  const [briefError, setBriefError] = useState<string | null>(null);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!env.liveApi) {
      navigate('/generating');
      return;
    }
    // Живой режим: сборка идёт 1–3 минуты, поэтому бриф не ждёт ответа — его отправляет экран сборки с прогрессом.
    // Ответы остаются в полях: если сборка вернёт студента на бриф (стоп-фактор), набирать их заново не придётся.
    const areas = Array.from(event.currentTarget.querySelectorAll('textarea'));
    const text = areas
      .map((t) => t.value.trim())
      .filter(Boolean)
      .join('\n\n');
    setBriefError(null);
    saveFlow({ pendingBrief: text, briefRefusal: undefined, briefDraft: Object.fromEntries(areas.map((t) => [t.id, t.value])) });
    navigate('/generating');
  };

  const removeFile = (id: string) => setFiles((list) => list.filter((f) => f.id !== id));

  return (
    <div className="ob-page">
      <OnboardingHeader
        current={2}
        profileLink="/onboarding"
        trailing={
          env.liveApi ? undefined : (
          <div role="group" aria-label="Тариф для прототипа" className="brief-proto">
            <span className="brief-proto__label">Прототип:</span>
            <button type="button" aria-pressed={free} onClick={() => setPlan('free')} className="brief-proto__btn">
              Бесплатный
            </button>
            <button type="button" aria-pressed={!free} onClick={() => setPlan('ai_pack')} className="brief-proto__btn">
              Пакет ИИ
            </button>
          </div>
          )
        }
      />

      <main className="brief-main">
        <form className="brief-form" onSubmit={onSubmit}>
          {current === 'ask' && (
            <>
              <div className="brief-heading">
                <h1 className="ob-title">Есть материалы о проекте?</h1>
                <p className="ob-lead brief-heading__lead">Презентация, описание, бизнес-план, свидетельство на РИД — загрузите всё, что есть. Буха сама найдёт факты и внесёт их в паспорт, а чего не хватит, спросит потом.</p>
              </div>

              <section className="brief-ask">
                {canUpload && (
                  <button type="button" onClick={() => setStep('files')} className="brief-drop">
                    <span className="brief-drop__icon">
                      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 16V4M7 9l5-5 5 5" />
                        <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                      </svg>
                    </span>
                    <span className="brief-drop__title">Перетащите файлы сюда</span>
                    <span className="brief-drop__or">
                      или <span className="brief-drop__link">загрузите с устройства</span>
                    </span>
                    <span className="brief-drop__hint">PDF, DOCX, PPTX, сканы — до {fileLimit} файлов</span>
                  </button>
                )}

                <aside className="brief-aside">
                  <BrandMark size={48} />
                  <h2 className="brief-aside__title">Файлов пока нет?</h2>
                  <p className="brief-aside__text">Это нормально. Ответьте на несколько вопросов о проекте — займёт минут 10.</p>
                  <button type="button" onClick={() => setStep('form')} className="brief-aside__btn">
                    У меня нет файлов
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                </aside>
              </section>
            </>
          )}

          {current === 'files' && (
            <>
              <div className="brief-heading">
                <h1 className="ob-title">Материалы загружены</h1>
                <p className="ob-lead brief-heading__lead">Этого достаточно, чтобы собрать паспорт. Анкету заполнять не нужно: если в документах чего-то не хватит, Буха соберёт вопросы в разделе «Пробелы».</p>
              </div>

              <section className="brief-files">
                <ul className="brief-files__list">
                  {files.map((file) => (
                    <FileRow key={file.id} file={file} onRemove={() => removeFile(file.id)} />
                  ))}
                </ul>
                <button type="button" className="brief-files__add">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#C2410C" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Добавить ещё файл <span className="brief-files__count">· использовано {used} из {fileLimit}</span>
                </button>
              </section>
            </>
          )}

          {current === 'form' && (
            <>
              <div className="brief-heading">
                <h1 className="ob-title">Расскажите о проекте</h1>
                <p className="ob-lead brief-heading__lead">
                  Отвечайте как получится, коротко — тоже хорошо.{' '}
                  {canUpload && (
                    <button type="button" onClick={() => setStep('ask')} className="brief-form__upload-link">
                      Нашлись файлы? Загрузить
                    </button>
                  )}
                </p>
              </div>

              {refusal && refusal.length > 0 && (
                <section role="alert" className="brief-refusal">
                  <h2 className="brief-refusal__title">Фонд не поддержит проект в таком виде</h2>
                  {refusal.map((f) => (
                    <div key={f.reason} className="brief-refusal__item">
                      <p className="brief-refusal__reason">{f.reason}</p>
                      {f.how_to_fix && <p className="brief-refusal__fix">{f.how_to_fix}</p>}
                    </div>
                  ))}
                </section>
              )}

              <section className="brief-questions">
                {QUESTIONS.map((item) => (
                  <div key={item.id} className="brief-question">
                    <label htmlFor={item.id} className="brief-question__label">
                      {item.n}. {item.q}
                      <span aria-hidden="true" className="ob-required"> *</span>
                    </label>
                    <textarea id={item.id} className="ob-textarea brief-textarea" required aria-required="true" rows={3} defaultValue={draft[item.id]} />
                    <details>
                      <summary className="brief-question__summary">Как обычно отвечают</summary>
                      <p className="brief-question__example">{item.ex}</p>
                    </details>
                  </div>
                ))}

                <div className="brief-extra">
                  <label htmlFor="extra" className="brief-extra__label">
                    Что ещё важно знать о проекте?
                  </label>
                  <span className="brief-extra__hint">Всё, что не поместилось в вопросы выше: пилоты, партнёры, награды, планы, сомнения.</span>
                  <textarea
                    id="extra"
                    className="ob-textarea brief-textarea brief-textarea--extra"
                    rows={5}
                    defaultValue={draft.extra}
                    placeholder="Например: в октябре договорились о пилоте с центром соцподдержки, письмо пока не подписано"
                  />
                </div>
              </section>
            </>
          )}

          <div className="brief-footer">
            {current === 'form' && (
              <p className="brief-legend">
                <span className="ob-required">*</span> — обязательные вопросы
              </p>
            )}
            <div className="brief-footer__actions">
              {current === 'ask' && (
                <Link to="/onboarding" className="brief-back">
                  Назад
                </Link>
              )}
              {current !== 'ask' && env.liveApi && (
                <Link to="/onboarding" className="brief-back">
                  Назад
                </Link>
              )}
              {current !== 'ask' && !env.liveApi && (
                <button type="button" onClick={() => setStep('ask')} className="brief-back brief-back--button">
                  Назад
                </button>
              )}
              {current !== 'ask' && (
                <button type="submit" className="ob-btn-primary">
                  {submitLabel}
                </button>
              )}
            </div>
          </div>
          {briefError && (
            <p role="alert" className="brief-error">
              {briefError}
            </p>
          )}
        </form>
      </main>
      <ConsultantWidget />
    </div>
  );
}

interface FileRowProps {
  file: UploadedFile;
  onRemove: () => void;
}

// Строка файла: иконка PDF, имя и подпись, статус (распознан / скан / дубликат), удаление.
function FileRow({ file, onRemove }: FileRowProps) {
  const isDuplicate = file.kind === 'duplicate';
  return (
    <li className={`brief-file${isDuplicate ? ' brief-file--duplicate' : ''}`}>
      <span className={`brief-file__chip brief-file__chip--${file.kind}`}>PDF</span>
      <span className="brief-file__info">
        <span className="brief-file__name">{file.name}</span>
        <span className={`brief-file__meta${isDuplicate ? ' brief-file__meta--warn' : ''}`}>{file.meta}</span>
      </span>
      {file.kind === 'ready' && <span className="brief-file__status brief-file__status--ready">Текст распознан</span>}
      {file.kind === 'scan' && (
        <span className="brief-file__status brief-file__status--scan">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3F3F46" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 9 9" />
          </svg>
          Распознаём скан
        </span>
      )}
      {isDuplicate ? (
        <button type="button" onClick={onRemove} className="brief-file__remove-text">
          Убрать
        </button>
      ) : (
        <button type="button" aria-label="Удалить файл" onClick={onRemove} className="brief-file__delete">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#71717A" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </li>
  );
}
