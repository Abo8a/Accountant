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
  /** Вопрос пайплайна к этому полю, критерий фонда и пример. */
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
      {criteria && <p className="passport__note">{`Что проверяет фонд: ${criteria}`}</p>}
      {example && <p className="passport__note">{`Как обычно пишут: ${example}`}</p>}

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
            Правка текста поля. После сохранения Буха заново найдёт каждое утверждение в тексте.
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
