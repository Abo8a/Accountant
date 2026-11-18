// Тексты для студента от моделей (замечания валидатора и аудита): только русский, без служебных идентификаторов, разумной длины.

/** Иероглифы и каны: текст для студента должен быть на русском. */
const FOREIGN_SCRIPT_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

export function hasForeignScript(text: string | null | undefined): boolean {
  return !!text && FOREIGN_SCRIPT_RE.test(text);
}

/** Служебные идентификаторы базы знаний и полей (kb_07_…, cmp_…, rag_context, field_key) в тексте для студента. */
const SERVICE_ID_RE = /\s*\(?\b(?:(?:kb|cmp|ta|card|tl)_[a-z0-9_]+|rag_context|field_key|[a-z]+(?:_[a-z0-9]+){1,})\b\)?/gi;
const REMARK_MAX_CHARS = 600;

/**
 * Замечание для студента: без служебных идентификаторов и не длиннее REMARK_MAX_CHARS (обрезается по границе предложения).
 * null — после чистки текста не осталось.
 */
export function studentFacingRemark(text: string | null | undefined): string | null {
  if (!text) return null;
  let clean = text
    .replace(SERVICE_ID_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
  if (clean.length > REMARK_MAX_CHARS) {
    const cut = clean.slice(0, REMARK_MAX_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    clean = end > REMARK_MAX_CHARS / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return clean.length > 0 ? clean : null;
}

