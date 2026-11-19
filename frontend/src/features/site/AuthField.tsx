import type { InputHTMLAttributes, ReactNode } from 'react';

// Поле формы входа и регистрации из design/project/Auth.dc.html: подпись + input, справа от подписи может стоять ссылка.
export interface AuthFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  id: string;
  label: string;
  /** Элемент справа от подписи (например, «Забыли пароль?»). */
  aside?: ReactNode;
}

export function AuthField({ id, label, aside, ...input }: AuthFieldProps) {
  const labelEl = (
    <label htmlFor={id} className="auth__label">
      {label}
    </label>
  );
  return (
    <div className="auth__field">
      {aside ? (
        <div className="auth__label-row">
          {labelEl}
          {aside}
        </div>
      ) : (
        labelEl
      )}
      <input id={id} className="auth__input" {...input} />
    </div>
  );
}
