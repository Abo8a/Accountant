import type { ChangeEvent } from 'react';
import type { Column, FieldFormSpec, FormCtx, FormValue, Row } from './schemas';
import './FieldForm.css';

// Интерактивная анкета поля: выбор варианта, отметки, короткие поля, таблица со строками «+ Добавить», текст.

export interface FieldFormProps {
  /** Префикс id элементов (уникален для поля). */
  id: string;
  spec: FieldFormSpec;
  value: FormValue;
  ctx: FormCtx;
  disabled?: boolean;
  onChange: (next: FormValue) => void;
}

const shown = (part: { when?: (v: FormValue) => boolean } | undefined, v: FormValue) => !!part && (!part.when || part.when(v));

function Cell({ id, column, value, label, disabled, onChange }: { id: string; column: Column; value: string; label: string; disabled?: boolean; onChange: (v: string) => void }) {
  const change = (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onChange(e.target.value);
  if (column.options) {
    return (
      <select id={id} aria-label={label} className="ff__input" value={value} disabled={disabled} onChange={change}>
        <option value="">Выберите…</option>
        {column.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return <input id={id} aria-label={label} className="ff__input" value={value} placeholder={column.placeholder} disabled={disabled} onChange={change} />;
}

export function FieldForm({ id, spec, value, ctx, disabled, onChange }: FieldFormProps) {
  const set = (patch: Partial<FormValue>) => onChange({ ...value, ...patch });
  const rows = value.rows ?? [];
  const setRow = (i: number, key: string, v: string) => set({ rows: rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)) });
  const flagOptions = spec.flags ? spec.flags.options(ctx) : [];

  return (
    <div className="ff">
      {spec.choice && (
        <fieldset className="ff__group">
          <legend className="ff__label">{spec.choice.label}</legend>
          <div className="ff__choices">
            {spec.choice.options.map((o) => (
              <label key={o} className={`ff__choice${value.choice === o ? ' ff__choice--on' : ''}`}>
                <input type="radio" name={`${id}-choice`} value={o} checked={value.choice === o} disabled={disabled} onChange={() => set({ choice: o })} className="ff__radio" />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {shown(spec.flags, value) && flagOptions.length > 0 && (
        <fieldset className="ff__group">
          <legend className="ff__label">{spec.flags!.label}</legend>
          <div className="ff__choices">
            {flagOptions.map((o) => {
              const on = (value.flags ?? []).includes(o);
              return (
                <label key={o} className={`ff__choice${on ? ' ff__choice--on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={() => set({ flags: on ? (value.flags ?? []).filter((f) => f !== o) : [...(value.flags ?? []), o] })}
                    className="ff__radio"
                  />
                  {o}
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {shown(spec.inputs, value) && (
        <div className="ff__inputs">
          {spec.inputs!.columns.map((c) => (
            <div key={c.key} className={`ff__input-wrap${c.wide ? ' ff__input-wrap--wide' : ''}`}>
              <label htmlFor={`${id}-in-${c.key}`} className="ff__label">
                {c.label}
                {c.optional && <span className="ff__optional"> · необязательно</span>}
              </label>
              <Cell
                id={`${id}-in-${c.key}`}
                column={c}
                label={c.label}
                value={value.inputs?.[c.key] ?? ''}
                disabled={disabled}
                onChange={(v) => set({ inputs: { ...value.inputs, [c.key]: v } })}
              />
            </div>
          ))}
        </div>
      )}

      {/* Три и больше колонок — карточки: в средней колонке паспорта таблица на столько полей слишком тесная. */}
      {shown(spec.rows, value) && spec.rows!.columns.length >= 3 && (
        <div className="ff__cards">
          {rows.map((r: Row, i) => (
            <div key={i} className="ff__card" role="group" aria-label={`Строка ${i + 1}`}>
              <div className="ff__card-head">
                <span className="ff__card-num">{i + 1}</span>
                <button
                  type="button"
                  className="ff__remove"
                  aria-label={`Удалить строку ${i + 1}`}
                  disabled={disabled || rows.length <= 1}
                  onClick={() => set({ rows: rows.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
              <div className="ff__inputs">
                {spec.rows!.columns.map((c) => (
                  <div key={c.key} className={`ff__input-wrap${c.wide ? ' ff__input-wrap--wide' : ''}`}>
                    <label htmlFor={`${id}-r${i}-${c.key}`} className="ff__label">
                      {c.label}
                      {c.optional && <span className="ff__optional"> · необязательно</span>}
                    </label>
                    <Cell
                      id={`${id}-r${i}-${c.key}`}
                      column={c}
                      label={`${c.label}, строка ${i + 1}`}
                      value={r[c.key] ?? ''}
                      disabled={disabled}
                      onChange={(v) => setRow(i, c.key, v)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
          <button type="button" className="ff__add" disabled={disabled} onClick={() => set({ rows: [...rows, {}] })}>
            + {spec.rows!.addLabel}
          </button>
        </div>
      )}

      {shown(spec.rows, value) && spec.rows!.columns.length < 3 && (
        <div className="ff__table-wrap">
          <table className="ff__table">
            <thead>
              <tr>
                {spec.rows!.columns.map((c) => (
                  <th key={c.key} scope="col" className={c.wide ? 'ff__th ff__th--wide' : 'ff__th'}>
                    {c.label}
                    {c.optional && <span className="ff__optional"> · необязательно</span>}
                  </th>
                ))}
                <th scope="col" className="ff__th ff__th--action">
                  <span className="ff__sr">Удалить</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: Row, i) => (
                <tr key={i}>
                  {spec.rows!.columns.map((c) => (
                    <td key={c.key} className="ff__td" data-label={c.label}>
                      <Cell
                        id={`${id}-r${i}-${c.key}`}
                        column={c}
                        label={`${c.label}, строка ${i + 1}`}
                        value={r[c.key] ?? ''}
                        disabled={disabled}
                        onChange={(v) => setRow(i, c.key, v)}
                      />
                    </td>
                  ))}
                  <td className="ff__td ff__td--action">
                    <button
                      type="button"
                      className="ff__remove"
                      aria-label={`Удалить строку ${i + 1}`}
                      disabled={disabled || rows.length <= 1}
                      onClick={() => set({ rows: rows.filter((_, j) => j !== i) })}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="ff__add" disabled={disabled} onClick={() => set({ rows: [...rows, {}] })}>
            + {spec.rows!.addLabel}
          </button>
        </div>
      )}

      {shown(spec.text, value) && (
        <div className="ff__input-wrap ff__input-wrap--wide">
          <label htmlFor={`${id}-text`} className="ff__label">
            {spec.text!.label}
            {spec.text!.optional && <span className="ff__optional"> · необязательно</span>}
          </label>
          <textarea
            id={`${id}-text`}
            rows={3}
            className="ff__input ff__textarea"
            value={value.text ?? ''}
            placeholder={spec.text!.placeholder}
            disabled={disabled}
            onChange={(e) => set({ text: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}
