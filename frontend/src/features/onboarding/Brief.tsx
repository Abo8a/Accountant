import { useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BrandMark } from '../../shared/ui/Logo/Logo';
import { env } from '../../shared/config/env';
import { getPlan } from '../../shared/data/plans';
import { storeProjectFile, type StoredFile } from '../../shared/api/files';
import { useCabinetState } from '../../shared/state/cabinet';
import { loadFlow, saveFlow } from '../../shared/state/flow';
import { LIVE_ACCEPT } from '../account/Files.live';
import { extOf, formatMb } from '../account/Files.model';
import { OnboardingHeader } from './OnboardingHeader';
import { ConsultantWidget } from '../consultant/ConsultantWidget';
import './common.css';
import './Brief.css';

// Стартовый бриф — design/project/Brief.dc.html. Три состояния: «есть файлы?» (ask),
// «Материалы загружены» (files) и анкета (form). Загрузка открыта на любом тарифе: бесплатный — до 5 файлов,
// «Пакет ИИ» — до 10 (в эталоне у «Базового» был пейволл — политика тарифов изменена по решению владельца, монетизация v2).

type Step = 'ask' | 'files' | 'form';
type Plan = 'free' | 'ai_pack';
// uploaded — файл сохранён на сервере, но ещё не разобран: разбор запускает экран сборки, поэтому статуса «распознан» у него нет.
type FileKind = 'ready' | 'scan' | 'duplicate' | 'uploaded';

interface UploadedFile {
  id: string;
  name: string;
  meta: string;
  kind: FileKind;
  /** Расширение для плашки (в макете у всех PDF). */
  ext?: string;
  /** Файл на сервере: только он уходит в сборку. */
  stored?: StoredFile;
}

const DUPLICATE_META = 'Этот файл уже загружен — повторно не разбираем и в лимит не считаем';
// Текст для живого режима: в макете этого сообщения нет (лимит там не проверяется).
const LIMIT_REACHED = 'Лимит файлов исчерпан. Удалите ненужный файл.';

// Состояние прототипа из эталона: один файл распознан, один скан, один дубликат (не считается в лимит).
const INITIAL_FILES: UploadedFile[] = [
  { id: 'f1', name: 'Monetrix_presentation_02.11.pdf', meta: '15 страниц · 4,2 МБ', kind: 'ready' },
  { id: 'f2', name: 'Svidetelstvo_RID_scan.pdf', meta: 'Скан · 2 страницы', kind: 'scan' },
  { id: 'f3', name: 'Monetrix_presentation_02.11 (1).pdf', meta: DUPLICATE_META, kind: 'duplicate' },
];

/** Строка списка для файла, который уже лежит на сервере (после обновления страницы список восстанавливается из потока). */
function rowFromStored(file: StoredFile): UploadedFile {
  return { id: file.sha256_hash, name: file.file_name, meta: formatMb(file.size_bytes / 1048576), kind: 'uploaded', ext: extOf(file.file_name), stored: file };
}

const QUESTIONS = [
  { id: 'q1', n: 1, q: 'Какую проблему решает проект и для кого?', ex: 'Сведения о мерах поддержки распределены между разными источниками; пользователю трудно собрать последовательность действий.' },
  { id: 'q2', n: 2, q: 'Что делает продукт?', ex: 'Единый профиль потребности, проверяемый справочник, подготовка черновика обращения и передача сложного вопроса координатору.' },
  { id: 'q3', n: 3, q: 'Что уже сделано, а что в планах?', ex: 'Есть макеты интерфейса; рабочий прототип планируется к концу первого этапа.' },
  { id: 'q4', n: 4, q: 'Кто в команде и чем занимается?', ex: 'Иван Иванов — руководитель проекта и продуктовая аналитика; разработчик — бэкенд и ИИ-модуль.' },
];

export function Brief() {
  const navigate = useNavigate();
  const cabinet = useCabinetState();
  const [draft] = useState<Record<string, string>>(() => (env.liveApi ? loadFlow().briefDraft ?? {} : {}));
  const [refusal] = useState(() => (env.liveApi ? loadFlow().briefRefusal ?? null : null));
  // Живой режим: после отказа по стоп-фактору или с начатой анкетой — сразу анкета (там видны причина и ответы);
  // с загруженными, но ещё не отправленными файлами — список файлов; иначе вопрос «Есть материалы о проекте?».
  const [step, setStep] = useState<Step>(() => {
    if (!env.liveApi) return 'ask';
    if (refusal || Object.keys(draft).length > 0) return 'form';
    return (loadFlow().briefFiles?.length ?? 0) > 0 ? 'files' : 'ask';
  });
  const [plan, setPlan] = useState<Plan>('ai_pack');
  const [files, setFiles] = useState<UploadedFile[]>(() => (env.liveApi ? (loadFlow().briefFiles ?? []).map(rowFromStored) : INITIAL_FILES));
  const filesRef = useRef(files);
  const rowSeq = useRef(0);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const free = plan === 'free';
  // Загрузка доступна на любом тарифе; различается только лимит файлов (бесплатный — 5, «Пакет ИИ» — 10).
  // В живом режиме лимит берётся из тарифа пользователя на сервере.
  const fileLimit = env.liveApi ? (cabinet?.files_limit ?? getPlan('free').file_uploads_limit) : getPlan(plan).file_uploads_limit;
  const current: Step = step;
  const used = files.filter((f) => f.kind !== 'duplicate').length;
  const storedFiles = files.flatMap((f) => (f.stored ? [f.stored] : []));
  const submitLabel = current === 'files' ? 'Собрать паспорт по файлам' : 'Собрать паспорт';

  // Валидация анкеты — нативная (required у вопросов): без ответов переход не происходит.
  const [briefError, setBriefError] = useState<string | null>(null);
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!env.liveApi) {
      navigate('/generating');
      return;
    }
    setBriefError(null);
    // Ветка «Есть материалы»: сборку по файлам отправляет экран сборки (она идёт 1–3 минуты). Анкета не нужна.
    if (current === 'files') {
      if (storedFiles.length === 0 || uploading) return;
      saveFlow({ pendingFiles: storedFiles, pendingBrief: undefined, briefRefusal: undefined });
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
    saveFlow({
      pendingBrief: text,
      pendingFiles: undefined,
      briefFiles: undefined,
      briefRefusal: undefined,
      briefDraft: Object.fromEntries(areas.map((t) => [t.id, t.value])),
    });
    navigate('/generating');
  };

  /** Список файлов меняется только здесь: ref нужен циклу загрузки (состояние React в замыкании устаревает). */
  const commitFiles = (next: UploadedFile[]) => {
    filesRef.current = next;
    setFiles(next);
    if (env.liveApi) saveFlow({ briefFiles: next.flatMap((f) => (f.stored ? [f.stored] : [])) });
  };

  const removeFile = (id: string) => commitFiles(filesRef.current.filter((f) => f.id !== id));

  /** Живой режим: каждый файл сначала сохраняется на сервере (формат, размер, тариф, дубль), и только потом попадает в список. */
  const addFiles = async (picked: File[]) => {
    if (picked.length === 0 || uploading) return;
    setBriefError(null);
    setUploading(true);
    try {
      for (const file of picked) {
        const count = filesRef.current.filter((f) => f.kind !== 'duplicate').length;
        if (count >= fileLimit) {
          setBriefError(LIMIT_REACHED);
          break;
        }
        const result = await storeProjectFile(file);
        if (result.status === 'error') {
          setBriefError(result.message);
          // Лимит и тариф не зависят от файла: остальные из выбранных тоже не пройдут.
          if (result.code === 'FILE_QUOTA_EXCEEDED' || result.code === 'PLAN_UPGRADE_REQUIRED') break;
          continue;
        }
        const sha = result.status === 'stored' ? result.file.sha256_hash : null;
        const repeated = result.status === 'duplicate' || filesRef.current.some((f) => f.stored?.sha256_hash === sha);
        if (repeated || !('file' in result)) {
          commitFiles([...filesRef.current, { id: `dup-${(rowSeq.current += 1)}`, name: file.name, meta: DUPLICATE_META, kind: 'duplicate' }]);
          continue;
        }
        commitFiles([...filesRef.current, rowFromStored(result.file)]);
      }
    } finally {
      setUploading(false);
    }
    if (filesRef.current.length > 0) setStep('files');
  };

  const openPicker = () => pickerRef.current?.click();
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    void addFiles(picked);
  };
  const onDragOver = (e: DragEvent) => e.preventDefault();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    void addFiles(Array.from(e.dataTransfer.files));
  };

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
                {/* В макете клик открывает список файлов; в живом режиме — выбор файла, а список появляется после загрузки. */}
                <button
                  type="button"
                  onClick={env.liveApi ? openPicker : () => setStep('files')}
                  onDragOver={env.liveApi ? onDragOver : undefined}
                  onDrop={env.liveApi ? onDrop : undefined}
                  disabled={uploading}
                  className="brief-drop"
                >
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
                <button type="button" className="brief-files__add" onClick={env.liveApi ? openPicker : undefined} disabled={uploading}>
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
                  <button type="button" onClick={() => setStep('ask')} className="brief-form__upload-link">
                    Нашлись файлы? Загрузить
                  </button>
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
              {current !== 'ask' && (
                <button type="button" onClick={() => setStep('ask')} className="brief-back brief-back--button">
                  Назад
                </button>
              )}
              {current !== 'ask' && (
                <button type="submit" disabled={current === 'files' && env.liveApi && (storedFiles.length === 0 || uploading)} className="ob-btn-primary">
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
          {env.liveApi && (
            <input ref={pickerRef} type="file" multiple accept={LIVE_ACCEPT} hidden aria-label="Файлы для загрузки" onChange={onPick} />
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
      <span className={`brief-file__chip brief-file__chip--${file.kind === 'uploaded' ? 'ready' : file.kind}`}>{file.ext ?? 'PDF'}</span>
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
