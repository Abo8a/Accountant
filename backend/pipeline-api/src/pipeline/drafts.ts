// Быстрое сохранение правок паспорта (save_draft) и общая проверка «Проверить» (review_edits).
// «Сохранить» пишет текст студента как есть, без вызова моделей: правка помечается «ждёт проверки».
// «Проверить» разом отдаёт модели все такие правки (упаковка текста и утверждения — один вызов extractPassport),
// затем аудит изменённых блоков (точечный ре-аудит или первичный аудит) — замечания обновляются по всему паспорту.
import { FIELD_FORM_SHAPES, type PipelineRequest, type PipelineResponse, type PipelineSaved } from '@passport/contracts';
import { fillFieldForms } from './formFill';
import type { DependencyNode } from '@passport/passport-core';
import { PipelineFailure } from '../errors';
import type { RecordRow, UserContext } from '../db/store';
import type { PipelineDeps } from './deps';
import { checkFormValues, guardFormValues, writeDirectionChoice, type FormValue } from './form';
import { invalidateDependents, noteFieldChange } from './invalidation';
import { extractPassport, findGaps, writeClaims } from './passport';
import { gapKey, nextStep, skippedKeys } from './next';

/** Служебная запись секции 0: ключи «секция/поле» (и «budget») правок, которые сохранены, но ещё не проверены. */
export const PENDING_REVIEW_KEY = 'pending_review';
export const BUDGET_PENDING = 'budget';

const isCode = (v: { section_id: number; field_key: string }) =>
  v.section_id === 4 && (v.field_key === 'direction' || v.field_key === 'tech_challenge');

/** Непроверенные правки из служебной записи; битая запись = правок нет. */
export function loadPendingReview(records: readonly RecordRow[]): string[] {
  const raw = records.find((r) => r.section_id === 0 && r.field_key === PENDING_REVIEW_KEY)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

async function savePendingReview(deps: PipelineDeps, projectId: string, keys: readonly string[]): Promise<void> {
  await deps.store.upsertField(projectId, 0, PENDING_REVIEW_KEY, JSON.stringify([...new Set(keys)]));
}

/**
 * «Сохранить»: поле (текст и форма анкеты), направление с вызовом или смета — без вызова моделей и без guard.
 * Текст пишется дословно и целиком считается словами студента; зависимые блоки размораживаются сразу, как и раньше.
 */
export async function handleSaveDraft(deps: PipelineDeps, req: PipelineRequest, ctx: UserContext): Promise<PipelineSaved> {
  const { store } = deps;
  if ((req.form ?? []).length === 0 && req.budget_items === undefined) {
    throw new PipelineFailure('INVALID_FIELD_VALUE', 'Форма пуста: передайте поля или смету');
  }
  const values = checkFormValues(deps, req.form);
  const projectId = ctx.project?.id ?? (await store.ensureProject(req.user_id));
  const records = await store.getRecords(projectId);
  const pending = loadPendingReview(records);
  const changed = new Set<DependencyNode>();

  const codes = values.filter(isCode);
  if (codes.length > 0) {
    await writeDirectionChoice(deps, projectId, codes, changed);
    pending.push('4/direction');
  }

  for (const v of values.filter((x) => !isCode(x))) {
    const rec = records.find((r) => r.section_id === v.section_id && r.field_key === v.field_key);
    const key = `${v.section_id}/${v.field_key}`;
    if ((rec?.value ?? '') === v.value) continue;
    noteFieldChange(rec?.value ?? null, v.value, v.section_id, changed);
    const recordId = await store.upsertField(projectId, v.section_id, v.field_key, v.value);
    await writeClaims(
      deps,
      recordId,
      v.value,
      [{ claim_text: v.value, claim_type: 'client_statement', claim_kind: 'paragraph', source_id: null, source_locator: null, confidence: null }],
      {},
      new Set(),
      { userTexts: [v.value], previous: rec?.claims },
    );
    pending.push(key);
  }

  // Форма анкеты — после текста (смена текста сбрасывает её триггером 0016) и только для поля из этого запроса.
  const form = req.field_form;
  if (form && values.some((v) => v.section_id === form.section_id && v.field_key === form.field_key)) {
    await store.setFieldForm(projectId, form.section_id, form.field_key, form.data);
  }

  if (req.budget_items !== undefined) {
    await store.replaceBudgetItems(
      projectId,
      req.budget_items.map((b) => ({ ...b, justification: b.justification ?? '' })),
    );
    pending.push(BUDGET_PENDING);
  }

  await invalidateDependents(store, projectId, changed);
  const unique = [...new Set(pending)];
  await savePendingReview(deps, projectId, unique);
  return { status: 'SAVED', pending_review: unique };
}

/**
 * «Проверить»: все непроверенные правки разом. Текстовые поля — один вызов extractPassport (ИИ упаковывает текст
 * и размечает утверждения), формы анкет сохраняются заново (перезапись текста их сбрасывает). Затем nextStep, где все
 * пробелы считаются пропущенными: аудит идёт по всем изменённым блокам сразу, а не по одному после каждого ответа.
 */
export async function handleReviewEdits(deps: PipelineDeps, req: PipelineRequest, ctx: UserContext): Promise<PipelineResponse> {
  const { store } = deps;
  if (!ctx.project?.hasRecords) {
    throw new PipelineFailure('INVALID_FIELD_VALUE', 'Паспорт ещё не собран: сначала опишите проект в брифе.');
  }
  const projectId = ctx.project.id;
  const records = await store.getRecords(projectId);
  const pending = loadPendingReview(records);

  const texts: FormValue[] = [];
  for (const key of pending) {
    const [sid, fieldKey] = key.split('/');
    const sectionId = Number(sid);
    if (!fieldKey || !Number.isInteger(sectionId) || isCode({ section_id: sectionId, field_key: fieldKey })) continue;
    const value = records.find((r) => r.section_id === sectionId && r.field_key === fieldKey)?.value?.trim();
    if (value) texts.push({ section_id: sectionId, field_key: fieldKey, value });
  }

  if (texts.length > 0) {
    const blocked = await guardFormValues(deps, ctx, projectId, texts);
    if (blocked) return blocked;
    const forms = await store.getFieldForms(projectId);
    const sources = await store.listSources(projectId);
    // Зависимые блоки разморожены ещё при сохранении: пересказ ИИ того же текста повторно их не трогает.
    await extractPassport(deps, projectId, req.program, '', sources, texts, new Set<DependencyNode>());
    for (const t of texts) {
      const form = forms[`${t.section_id}/${t.field_key}`];
      if (form) await store.setFieldForm(projectId, t.section_id, t.field_key, form);
    }
  }
  await savePendingReview(deps, projectId, []);
  // Паспорта, собранные до раскладки по анкетам: поля с текстом без анкеты получают её здесь (поля с анкетой пропускаются).
  await fillFieldForms(deps, projectId, Object.keys(FIELD_FORM_SHAPES));

  const after = await store.getRecords(projectId);
  const skipped = new Set([...skippedKeys(req.skipped_fields), ...findGaps(after).map(gapKey)]);
  return nextStep(deps, ctx, projectId, req.program, skipped);
}
