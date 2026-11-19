// Происхождение утверждения: слова студента или текст, дописанный моделью (легенда паспорта «С ваших слов» / «Дописано ИИ»).
// Модель утверждения не помечает — различаем по тексту: если почти все значимые слова утверждения есть в том, что ввёл студент
// (бриф, ответ, правка поля), оно «со слов студента», иначе его добавила модель.

import type { ClaimOrigin } from '@passport/contracts';

/** Доля слов утверждения, найденных в тексте студента, с которой утверждение считается его словами. */
export const USER_ORIGIN_THRESHOLD = 0.6;

const STEM_LENGTH = 5; // «команда» / «команды» / «командой» → «коман»: окончания не мешают сравнению
const MIN_WORD_LENGTH = 4; // короткие слова (предлоги, союзы) не несут смысла и завышали бы совпадение

function stems(text: string): string[] {
  const words = text.toLowerCase().replace(/ё/g, 'е').match(/[a-zа-я]+|\d+/g) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (/^\d+$/.test(w)) out.push(w);
    else if (w.length >= MIN_WORD_LENGTH) out.push(w.slice(0, STEM_LENGTH));
  }
  return out;
}

/** Слова студента или модели? Без значимых слов (например, «5») утверждение остаётся за студентом: ИИ ему приписать нечего. */
export function classifyClaimOrigin(claimText: string, userTexts: readonly string[]): ClaimOrigin {
  const claim = stems(claimText);
  if (claim.length === 0) return 'user';
  const known = new Set(userTexts.flatMap((t) => stems(t)));
  const found = claim.filter((s) => known.has(s)).length;
  return found / claim.length >= USER_ORIGIN_THRESHOLD ? 'user' : 'ai';
}
