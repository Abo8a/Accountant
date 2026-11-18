// Общий переход после изменения паспорта.
// Порядок: якорь (когда заполнены блоки 3 и 4) → досбор пустых секций в форме (0 токенов ИИ) →
// первичный аудит (6) или точечный ре-аудит только изменённых блоков (6.1) → пробелы блоков → смета → новизна и выход (шаги 7–8).
import { PASSPORT_SECTIONS, type PipelineQuestion, type PipelineResponse, type TargetField } from '@passport/contracts';
import { fieldKb } from '../kb/manifest';
import type { BudgetRow, RecordRow, UserContext } from '../db/store';
import type { PipelineDeps } from './deps';
import { findGaps, buildPassportFields } from './passport';
import { noveltyAndFinalize } from './finalize';
import { auditFingerprint, auditPassport, loadAuditReport, type AuditReport, type AuditScope } from './audit';
import { anchorBriefFromRecords, createAnchor } from './anchor';
import { OPTIONAL_FIELDS } from './fieldValidation';

export async function nextStep(
  deps: PipelineDeps,
  ctx: UserContext,
  projectId: string,
  program: string,
  skipped: ReadonlySet<string> = new Set(),
): Promise<PipelineResponse> {
  let records: RecordRow[] = await deps.store.getRecords(projectId);

  // Якорь (анти-фрод) — один раз, когда в паспорте заполнены ключевые блоки 3 и 4.
  if (!ctx.project?.anchorReady) {
    const anchorText = anchorBriefFromRecords(records);
    if (anchorText) await createAnchor(deps, projectId, anchorText);
  }

  const previous = loadAuditReport(records);

  // Полностью пустая обязательная секция: сначала досбор в форме. Аудит Kimi по полупустому паспорту не запускаем.
  if (hasFullyEmptySection(records)) {
    const gap = findGaps(records).find((g) => !skipped.has(gapKey(g)));
    if (gap) return gapQuestion(deps, gap, records, previous ?? undefined);
  }

  // Первичный аудит — один раз; дальше точечный ре-аудит только того, что изменилось с прошлого аудита.
  // Ничего не изменилось или студент ещё дорабатывает блок — вопрос без вызова модели, с замечаниями прошлого аудита.
  let auditReport: AuditReport;
  if (!previous?.fingerprint) {
    auditReport = await auditPassport(deps, projectId);
  } else {
    const scope = planReaudit(records, await deps.store.getBudgetItems(projectId), await deps.store.getBudgetLimits(), previous, skipped);
    auditReport = scope ? await auditPassport(deps, projectId, scope) : previous;
  }
  records = await deps.store.getRecords(projectId);

  const open = fatalFirst(findGaps(records), auditReport);
  const gap = open.find((g) => !skipped.has(gapKey(g)));
  if (gap) return gapQuestion(deps, gap, records, auditReport);
  // Остались только пропущенные пробелы: не идём дальше к смете и новизне, пока пользователь не вернётся.
  if (open.length > 0) return deferredQuestion(open.length);

  // Смета — часть проверки «Все блоки, смета и 2 аналога ОК?»: не одобрена → назад на шаг 7 (доработка).
  if (auditReport.budget_audit.status !== 'approved') {
    return budgetQuestion(records, auditReport);
  }

  return noveltyAndFinalize(deps, ctx, projectId, records, program, auditReport);
}

/**
 * Что перепроверить на точечном ре-аудите (6.1). Блок идёт на проверку, когда в нём что-то изменилось с прошлого аудита
 * (ответ студента, правка формы, разморозка связанного блока) и студент закончил его правки: в блоке не осталось
 * нетронутых полей с замечаниями и пустых полей. Пока студент отвечает на другие пробелы, готовые блоки проверяются сразу,
 * а недоделанные ждут; когда отвечать больше не на что (всё пропущено), проверяется всё изменённое.
 * null — ничего не изменилось, вердикт прошлого аудита в силе.
 */
export function planReaudit(
  records: readonly RecordRow[],
  budgetItems: readonly BudgetRow[],
  limits: unknown,
  previous: AuditReport,
  skipped: ReadonlySet<string>,
): AuditScope | null {
  const before = previous.fingerprint;
  if (!before) return null;
  const now = auditFingerprint(records, budgetItems, limits);
  const changedFields = new Set(Object.keys(now.fields).filter((k) => now.fields[k] !== before.fields[k]));
  const changedSections = new Set([...changedFields].map((k) => Number(k.split('/')[0])));

  // Текст поля менялся (а не только статус после разморозки связанного блока)
  const valueOf = (fp: string | undefined) => fp?.split('|')[1];
  const editedSections = new Set(
    [...changedFields].filter((k) => valueOf(now.fields[k]) !== valueOf(before.fields[k])).map((k) => Number(k.split('/')[0])),
  );

  const waiting = findGaps([...records]).filter((g) => !changedFields.has(gapKey(g)) || isEmptyField(records, g));
  const isReady = (sid: number) => !waiting.some((g) => g.section_id === sid);
  const studentStillAnswering = waiting.some((g) => !skipped.has(gapKey(g)));

  let sections: Set<number>;
  if (!studentStillAnswering) {
    sections = changedSections;
  } else {
    // Доработанные блоки + размороженные ими связанные (проверяются вместе с блоком-причиной, а не после каждого ответа)
    const readyEdited = [...editedSections].filter(isReady);
    const unfrozen = [...changedSections].filter((sid) => !editedSections.has(sid) && isReady(sid));
    sections = new Set(readyEdited.length > 0 ? [...readyEdited, ...unfrozen] : []);
  }
  const budget = now.budget !== before.budget;
  if (sections.size === 0 && !budget) return null;
  return { sections, budget, previous };
}

function isEmptyField(records: readonly RecordRow[], gap: TargetField): boolean {
  return !records.find((r) => r.section_id === gap.section_id && r.field_key === gap.field_key)?.value?.trim();
}

/** При стоп-факторе первым спрашиваем затронутый блок (суть проекта), а не следующий по порядку. */
function fatalFirst(gaps: TargetField[], report: AuditReport): TargetField[] {
  const fatal = new Set(report.fatal_stop_factors.flatMap((f) => f.affected_sections));
  if (fatal.size === 0) return gaps;
  return [...gaps.filter((g) => fatal.has(g.section_id)), ...gaps.filter((g) => !fatal.has(g.section_id))];
}

/** Ключ пробела для списка пропущенных: «секция/поле». */
export function gapKey(gap: TargetField): string {
  return `${gap.section_id}/${gap.field_key}`;
}

/** Набор ключей из списка пропущенных полей запроса. */
export function skippedKeys(fields: readonly TargetField[] | undefined): Set<string> {
  return new Set((fields ?? []).map(gapKey));
}

/** Пробелы пропущены «вернуться позже»: вопроса нет, поле target_field не задано, паспорт не завершается. */
function deferredQuestion(openCount: number): PipelineQuestion {
  return {
    status: 'NEED_USER_INPUT',
    step: 'GAP_FILLING',
    question: `Пропущено пробелов: ${openCount}. Они останутся в паспорте, вернитесь к ним позже.`,
    example: '',
    rejection_reason: null,
  };
}

/** Есть ли в секциях 2–10 секция, где все обязательные поля пустые. */
function hasFullyEmptySection(records: readonly RecordRow[]): boolean {
  return PASSPORT_SECTIONS.some((section) =>
    section.fields
      .filter((f) => !OPTIONAL_FIELDS.has(`${section.id}/${f}`))
      .every((f) => !records.find((r) => r.section_id === section.id && r.field_key === f)?.value?.trim()),
  );
}

function gapQuestion(
  deps: PipelineDeps,
  gap: TargetField,
  records: RecordRow[],
  auditReport: AuditReport | undefined,
): PipelineQuestion {
  const kb = fieldKb(deps.kb, gap.section_id, gap.field_key);
  const blockAudit = auditReport?.block_audits.find((b) => b.section_id === gap.section_id);
  return {
    status: 'NEED_USER_INPUT',
    step: 'GAP_FILLING',
    target_field: gap,
    question: kb.question,
    example: kb.example,
    criteria: kb.criteria,
    rejection_reason: blockAudit?.remark ?? null,
    block_audits: auditReport?.block_audits,
    budget_audit: auditReport?.budget_audit,
    fatal_stop_factors: auditReport?.fatal_stop_factors,
    passport: buildPassportFields(records),
  };
}

function budgetQuestion(records: RecordRow[], auditReport: AuditReport): PipelineQuestion {
  const budget = auditReport.budget_audit;
  return {
    status: 'NEED_USER_INPUT',
    step: 'BUDGET_REVIEW',
    question: 'Смета не одобрена: исправьте статьи бюджета или подтвердите их на этом шаге.',
    example: '',
    rejection_reason: budget.remark ?? (budget.violations.length > 0 ? budget.violations.join('; ') : 'Смета не одобрена.'),
    block_audits: auditReport.block_audits,
    budget_audit: budget,
    fatal_stop_factors: auditReport.fatal_stop_factors,
    passport: buildPassportFields(records),
  };
}
