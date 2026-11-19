import { useState } from 'react';
import { AuditRemark } from '../AuditRemark';
import { FieldForm } from './FieldForm';
import { emptyForm, formFromData, formToSave, type FieldFormSpec, type FormCtx, type FormValue } from './schemas';
import './FieldForm.css';

// Редактор поля паспорта в блоке: интерактивная анкета (если она есть для поля) или текст.
// Форма открывается сразу, когда поле пустое или уже сохранено из формы; текст, который написали словами
// (или собрала Буха по брифу), правится текстом — с кнопкой «Заполнить формой».

export interface FieldEditorProps {
  inputId: string;
  initialText: string;
  wasApproved: boolean;
  busy: boolean;
  /** Вопрос пайплайна к этому полю; критерий фонда и пример заполнения — из базы знаний (подсказки поля). */
  question?: string;
  criteria?: string;
  example?: string;
  /** Почему ИИ не принял ответ; черновик остаётся. */
  rejection?: string;
  /** «Не знаю — помогите»: открывает ИИ-Консультанта. */
  onHelp?: () => void;
  /** Анкета поля и сохранённая форма (form_data). */
  spec?: FieldFormSpec;
  formData?: Record<string, unknown>;
  ctx: FormCtx;
  onSave: (text: string, form?: Record<string, unknown>) => void;
  onCancel: () => void;
}

export function FieldEditor(props: FieldEditorProps) {
  const { inputId, initialText, wasApproved, busy, question, criteria, example, rejection, onHelp, spec, formData, ctx, onSave, onCancel } = props;
  const saved = spec ? formFromData(spec, formData) : null;
  const [mode, setMode] = useState<'form' | 'text'>(spec && (saved || !initialText.trim()) ? 'form' : 'text');
  const [form, setForm] = useState<FormValue>(() => saved ?? (spec ? emptyForm(spec, ctx) : {}));
  const [draft, setDraft] = useState(initialText);
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (mode === 'text' || !spec) {
      onSave(draft.trim());
      return;
    }
    const res = formToSave(spec, form, ctx);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError(null);
    onSave(res.text, res.data);
  }

  const canSave = mode === 'form' ? !busy : !busy && !!draft.trim();

  return (
    <div className="passport__editor">
      {question && <p className="passport__editor-question">{question}</p>}
      {/* Критерий фонда и пример заполнения — как в Gaps.dc.html: плашка с иконкой и раскрывающийся «Как обычно пишут». */}
      {criteria && (
        <div className="passport__criteria">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true" className="passport__criteria-icon">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
          </svg>
          <span className="passport__criteria-text">
            <b className="passport__criteria-lead">Что проверяет фонд:</b> {criteria}
          </span>
        </div>
      )}
      {example && (
        <details className="passport__example">
          <summary className="passport__example-summary">Как обычно пишут</summary>
          <p className="passport__example-text">{example}</p>
        </details>
      )}

      {mode === 'form' && spec ? (
        <FieldForm
          id={inputId}
          spec={spec}
          value={form}
          ctx={ctx}
          disabled={busy}
          onChange={(next) => {
            setForm(next);
            setError(null);
          }}
        />
      ) : (
        <>
          <label htmlFor={inputId} className="passport__editor-hint">
            Правка текста поля. Сохранение — сразу, без проверки; по кнопке «Проверить» Буха проверит все правки и заново найдёт утверждения в тексте.
          </label>
          <textarea id={inputId} rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} className="passport__textarea" />
        </>
      )}

      {spec && mode === 'text' && (
        <button
          type="button"
          className="ff__switch"
          disabled={busy}
          onClick={() => {
            setForm(saved ?? emptyForm(spec, ctx));
            setMode('form');
          }}
        >
          Заполнить формой
        </button>
      )}
      {spec && mode === 'form' && (
        <button
          type="button"
          className="ff__switch"
          disabled={busy}
          onClick={() => {
            const res = formToSave(spec, form, ctx);
            if (res.ok) setDraft(res.text);
            setError(null);
            setMode('text');
          }}
        >
          Написать текстом
        </button>
      )}

      {error && (
        <p role="alert" className="ff__error">
          {error}
        </p>
      )}
      {rejection && <AuditRemark remark={rejection} />}
      {wasApproved && <span className="passport__editor-warn">Поле согласовано. Правка снимет согласование.</span>}
      <div className="passport__editor-actions">
        <button type="button" className="passport__btn-save" disabled={!canSave} onClick={save}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" className="passport__btn-cancel" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
        {onHelp && (
          <button type="button" className="passport__btn-cancel" disabled={busy} onClick={onHelp}>
            Не знаю — помогите
          </button>
        )}
      </div>
    </div>
  );
}
