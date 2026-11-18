// Задачи 1.4, 1.5, 3.2, 3.5: приём формы целиком или точечных правок открытых блоков (шаги 3В, 5 и 7).
// Текстовые поля упаковываются через DeepSeek Flash (extractPassport) с подключением RAG, смета сохраняется напрямую.
import type { PipelineRequest, PipelineResponse } from '@passport/contracts';
import { isValidPassportField } from '@passport/contracts';
import type { DependencyNode } from '@passport/passport-core';
import { PipelineFailure } from '../errors';
import type { UserContext } from '../db/store';
import type { PipelineDeps } from './deps';
import { GUARD_QUERY_MAX_CHARS, GUARDED_ANSWER_SECTIONS } from './anchor';
import { challengeDirectionMismatch, checkFieldValue } from './fieldValidation';
import { invalidateDependents, noteFieldChange } from './invalidation';
import { extractPassport } from './passport';
import { nextStep, skippedKeys } from './next';

/** Поля с кодами (направление, номер вызова) не участвуют в guard: это не текст о проекте. */
const CODE_FIELDS = new Set(['direction', 'tech_challenge']);

/**
 * Выбор студента «направление + вызов». Направление без вызова = «без вызова»: прежний вызов снимается
 * (иначе остался бы вызов чужого направления). Вызов чужого направления не принимается.
 */
async function writeDirectionChoice(
  deps: PipelineDeps,
  projectId: string,
  values: { section_id: number; field_key: string; value: string }[],
  changed: Set<DependencyNode>,
): Promise<void> {
  const { store, kb } = deps;
  const direction = values.find((v) => v.field_key === 'direction')?.value ?? (await store.getFieldValue(projectId, 4, 'direction'));
  const challenge = values.find((v) => v.field_key === 'tech_challenge')?.value ?? null;
  if (challenge) {
    if (!direction || direction === 'Н7') {
      throw new PipelineFailure('INVALID_FIELD_VALUE', 'Сначала выберите направление Н1–Н6: для Н7 технологических вызовов нет.');
    }
    const mismatch = challengeDirectionMismatch(direction, challenge, kb.tech_challenges);
    if (mismatch) throw new PipelineFailure('INVALID_FIELD_VALUE', mismatch);
  }
  const writes = [...values];
  const directionGiven = values.some((v) => v.field_key === 'direction');
  if (directionGiven && !challenge && (await store.getFieldValue(projectId, 4, 'tech_challenge'))?.trim()) {
    writes.push({ section_id: 4, field_key: 'tech_challenge', value: '' });
  }
  for (const w of writes) {
    const prev = await store.getFieldValue(projectId, 4, w.field_key);
    if ((prev ?? '') === w.value) continue;
    if (w.field_key === 'direction') noteFieldChange(prev, w.value, 4, changed);
    const recordId = await store.upsertField(projectId, 4, w.field_key, w.value);
    await store.replaceClaims(recordId, []);
  }
}

export async function handleSubmitForm(deps: PipelineDeps, req: PipelineRequest, ctx: UserContext): Promise<PipelineResponse> {
  const { store, llm, kb } = deps;
  const form = req.form ?? [];
  if (form.length === 0 && req.budget_items === undefined) {
    throw new PipelineFailure('INVALID_FIELD_VALUE', 'Форма пуста: передайте поля или смету');
  }

  // 1. Проверка значений до любой записи: одно неверное поле — ничего не сохраняется.
  const values: { section_id: number; field_key: string; value: string }[] = [];
  const problems: string[] = [];
  for (const f of form) {
    if (!isValidPassportField(f.section_id, f.field_key)) {
      problems.push(`Неизвестное поле ${f.section_id}/${f.field_key}.`);
      continue;
    }
    const check = checkFieldValue(f.section_id, f.field_key, f.value, kb.tech_challenges);
    if (!check.ok) {
      problems.push(`${f.field_key}: ${check.reason}`);
      continue;
    }
    if (check.value) values.push({ section_id: f.section_id, field_key: f.field_key, value: check.value });
  }
  if (problems.length > 0) {
    throw new PipelineFailure('INVALID_FIELD_VALUE', problems.join(' '));
  }

  // Пустое значение = «не менять» (поле не очищается).
  const projectId = ctx.project?.id ?? (await store.ensureProject(req.user_id));
  const textValues = values.filter((v) => !CODE_FIELDS.has(v.field_key) && GUARDED_ANSWER_SECTIONS.has(v.section_id));

  // 2. Guard против чужих материалов — только когда якорь уже есть и только по полям блоков 3–4 (из них строится якорь).
  if (ctx.project?.anchorReady && textValues.length > 0) {
    const joined = textValues.map((v) => v.value).join('\n\n');
    const embedding = await llm.embed(joined.slice(0, GUARD_QUERY_MAX_CHARS));
    const guard = await store.guardCheck(projectId, embedding, joined.slice(0, 500), ctx.thresholds);
    if (guard.action === 'blocked') {
      return {
        status: 'BLOCKED_PROJECT_SWAP',
        similarity_score: Math.round(guard.score * 100) / 100,
        message: 'Загруженные материалы относятся к другому проекту. По правилам платформы 1 аккаунт = 1 проект.',
      };
    }
  }


  // 4. Упаковка и запись полей через DeepSeek (extractPassport). Выбор направления и вызова — коды, их пишем напрямую:
  // переписывать нечего, а вызов модели здесь только тратил время и мог «предложить» вызов вместо студента.
  const changed = new Set<DependencyNode>();
  const codeOnly = values.length > 0 && values.every((v) => v.section_id === 4 && CODE_FIELDS.has(v.field_key));
  if (codeOnly) {
    await writeDirectionChoice(deps, projectId, values, changed);
  } else if (values.length > 0) {
    const sources = await store.listSources(projectId);
    await extractPassport(deps, projectId, req.program, '', sources, values, changed);
  }

  // 5. Смета целиком (если передана).
  if (req.budget_items !== undefined) {
    await store.replaceBudgetItems(
      projectId,
      req.budget_items.map((b) => ({ ...b, justification: b.justification ?? '' })),
    );
  }

  await invalidateDependents(store, projectId, changed);

  // Пока в проекте нет ни одного поля, нужен текст о проекте: отдаём стартовую анкету из КБ.
  // Якорь создаст nextStep, когда заполнены блоки 3 и 4.
  const hasAnyFields = (await store.getRecords(projectId)).length > 0;
  if (!hasAnyFields) {
    return {
      status: 'WAITING_FOR_INITIAL_BRIEF',
      step: 'INITIAL_BRIEF',
      question: kb.initial_brief.question,
      example: kb.initial_brief.example,
    };
  }
  return nextStep(deps, ctx, projectId, req.program, skippedKeys(req.skipped_fields));
}
