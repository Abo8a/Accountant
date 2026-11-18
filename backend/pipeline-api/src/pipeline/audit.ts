// Шаг 6: Первичный Аудит и Шаг 6.1: Точечный Ре-аудит (на канале Kimi k3).
import {
  PASSPORT_SECTIONS,
  type BlockAuditOut,
  type BudgetAuditOut,
  type FatalStopFactorOut,
} from '@passport/contracts';
import { checkBudget } from '@passport/passport-core';
import { callLlm, auditOutputSchema, noveltyVerdict, type AuditOutput } from '../llm/schemas';
import { wrapUntrustedData } from '../promptGuard';
import { fieldKb } from '../kb/manifest';
import { challengeDirectionMismatch, DIRECTION_CODES } from './fieldValidation';
import { getRagDb } from '../rag/db';
import { retrieveRagContext } from '../rag/retriever';
import type { DirectionCode } from '../rag/types';
import type { PipelineDeps } from './deps';
import type { BudgetRow, RecordRow } from '../db/store';
import { createHash } from 'node:crypto';
import { studentFacingRemark } from './remarks';
import { FIELD_TITLES } from './exportLabels';

const fieldTitles = (keys: readonly string[]) => keys.map((k) => `«${FIELD_TITLES[k] ?? k}»`).join(', ');

const CODE_FIELDS = new Set(['4/direction', '4/tech_challenge']);
const OPTIONAL_FIELDS = new Set(['4/tech_challenge']);
const MIN_FIELD_LENGTH = 10;

/** Слепок паспорта на момент аудита: по нему следующий запрос видит, что изменилось (шаг 6.1). */
export interface AuditFingerprint {
  /** «секция/поле» → «статус|хеш значения». */
  fields: Record<string, string>;
  budget: string;
}

export interface AuditReport {
  mode: 'primary_audit' | 'delta_reaudit';
  fatal_stop_factors: FatalStopFactorOut[];
  block_audits: BlockAuditOut[];
  budget_audit: BudgetAuditOut;
  novelty_audit?: AuditOutput['novelty_audit'];
  created_at: string;
  fingerprint?: AuditFingerprint;
}

/**
 * Точечный ре-аудит (6.1): какие открытые блоки проверить заново и нужна ли проверка сметы.
 * Остальные неодобренные блоки сохраняют вердикт прошлого аудита (previous) и идут в модель только как контекст.
 */
export interface AuditScope {
  sections: ReadonlySet<number>;
  budget: boolean;
  previous: AuditReport;
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** limits — действующая редакция лимитов сметы: её смена тоже повод перепроверить смету. */
export function auditFingerprint(records: readonly RecordRow[], budgetItems: readonly BudgetRow[], limits: unknown): AuditFingerprint {
  const fields: Record<string, string> = {};
  for (const s of PASSPORT_SECTIONS) {
    for (const f of s.fields) {
      const rec = records.find((r) => r.section_id === s.id && r.field_key === f);
      // «статус|хеш значения»: отличаем правку текста от разморозки связанного блока (меняется только статус)
      fields[`${s.id}/${f}`] = `${rec?.review_status ?? 'none'}|${hash(rec?.value ?? '')}`;
    }
  }
  const budget = hash(
    JSON.stringify([
      budgetItems.map((b) => [b.stage, b.category, b.title, b.quantity, b.unit_price, b.amount, b.justification, b.review_status]),
      limits,
    ]),
  );
  return { fields, budget };
}

/** Последний сохранённый отчёт аудита (служебная секция 0) или null. */
export function loadAuditReport(records: readonly RecordRow[]): AuditReport | null {
  const raw = records.find((r) => r.section_id === 0 && r.field_key === 'latest_audit_report')?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuditReport;
  } catch {
    return null;
  }
}

export async function auditPassport(deps: PipelineDeps, projectId: string, scope?: AuditScope): Promise<AuditReport> {
  const records = await deps.store.getRecords(projectId);
  const budgetItems = await deps.store.getBudgetItems(projectId);
  const limits = await deps.store.getBudgetLimits();
  const budgetInScope = !scope || scope.budget;

  // 1. Определение режима (primary vs delta) и разделение блоков
  const lockedSections: typeof PASSPORT_SECTIONS[number][] = [];
  const openSections: typeof PASSPORT_SECTIONS[number][] = [];

  for (const section of PASSPORT_SECTIONS) {
    const reqFields = section.fields.filter((f) => !OPTIONAL_FIELDS.has(`${section.id}/${f}`));
    const isLocked = reqFields.every((f) => {
      const rec = records.find((r) => r.section_id === section.id && r.field_key === f);
      const minLen = CODE_FIELDS.has(`${section.id}/${f}`) ? 0 : MIN_FIELD_LENGTH;
      const isFilled = !!rec?.value && rec.value.trim().length > minLen;
      return isFilled && rec.review_status === 'approved';
    });

    if (isLocked) {
      lockedSections.push(section);
    } else {
      openSections.push(section);
    }
  }

  // Точечный ре-аудит: заново проверяем только блоки из scope. Прочие открытые блоки ждут правок студента —
  // их вердикт прошлого аудита остаётся в силе, в модель они идут только как контекст (pending_blocks).
  const auditSections = scope ? openSections.filter((s) => scope.sections.has(s.id)) : openSections;
  const pendingSections = scope ? openSections.filter((s) => !scope.sections.has(s.id)) : [];
  const auditIds = new Set(auditSections.map((s) => s.id));
  const auditBudgetItems = budgetInScope ? budgetItems : [];

  // 2. Детерминированные проверки кодом до вызова Kimi (code_warnings)
  const codeWarnings: string[] = [];

  for (const s of auditSections) {
    const emptyFields: string[] = [];
    for (const f of s.fields) {
      if (OPTIONAL_FIELDS.has(`${s.id}/${f}`)) continue;
      const rec = records.find((r) => r.section_id === s.id && r.field_key === f);
      const minLen = CODE_FIELDS.has(`${s.id}/${f}`) ? 0 : MIN_FIELD_LENGTH;
      if (!rec?.value || rec.value.trim().length <= minLen) {
        emptyFields.push(f);
      }
    }
    if (emptyFields.length > 0) {
      codeWarnings.push(`Блок ${s.id}: не заполнены обязательные поля: ${emptyFields.join(', ')}`);
    }
  }

  const budgetErrors = budgetItems.length > 0 ? checkBudget(budgetItems, limits) : [];
  for (const err of budgetInScope ? budgetErrors : []) {
    codeWarnings.push(`Смета: ${err.message}`);
  }
  if (budgetInScope && budgetItems.some((b) => b.review_status === 'needs_review')) {
    codeWarnings.push('Смета: связанные блоки изменились. Подтвердите смету заново.');
  }

  const direction = records.find((r) => r.section_id === 4 && r.field_key === 'direction')?.value ?? null;
  const challenge = records.find((r) => r.section_id === 4 && r.field_key === 'tech_challenge')?.value ?? null;
  const mismatch = challengeDirectionMismatch(direction, challenge, deps.kb.tech_challenges);
  if (mismatch && auditIds.has(4)) {
    codeWarnings.push(`Направление и вызов: ${mismatch}`);
  }

  for (const r of records) {
    if (r.section_id < 2 || !auditIds.has(r.section_id)) continue;
    for (const c of r.claims) {
      if (c.claim_type === 'fact' && c.verification_status === 'unverified') {
        codeWarnings.push(`Неподтверждённый факт в Блоке ${r.section_id} (${r.field_key}): "${c.claim_text.slice(0, 80)}"`);
      }
    }
  }

  // 3. Подтягивание контекста из RAG (step: 'audit')
  const openSectionIds = auditSections.map((s) => String(s.id));
  const targetBlockIds = Array.from(new Set([...openSectionIds, ...(auditBudgetItems.length > 0 ? ['5', '7'] : [])]));

  const rawDirection = (direction ?? '').trim();
  const knownDirection: DirectionCode = (DIRECTION_CODES as readonly string[]).includes(rawDirection)
    ? (rawDirection as DirectionCode)
    : 'all';

  const openTexts = auditSections
    .flatMap((s) => s.fields.map((f) => records.find((r) => r.section_id === s.id && r.field_key === f)?.value ?? ''))
    .filter(Boolean)
    .join(' ');
  const budgetTexts = auditBudgetItems.map((b) => `${b.title} ${b.justification}`).join(' ');
  const queryText = [openTexts, budgetTexts, codeWarnings.join(' ')].filter(Boolean).join(' ').slice(0, 2000);

  let ragContextText = '';
  try {
    const ragDb = await getRagDb();
    try {
      const ragResult = await retrieveRagContext(ragDb.sql, {
        step: 'audit',
        targetBlocks: targetBlockIds,
        direction: knownDirection,
        queryText,
        topKSearch: 5,
        includePinned: true,
      });
      ragContextText = ragResult.formattedContext;
    } finally {
      await ragDb.close();
    }
  } catch (err) {
    deps.logger.warn('[auditPassport] RAG context unavailable, proceeding without RAG:', err);
  }

  // 4. Пакетный вызов Kimi
  const hasFilledOpenField = auditSections.some((s) =>
    s.fields.some((f) => {
      const rec = records.find((r) => r.section_id === s.id && r.field_key === f);
      return !!rec?.value && rec.value.trim().length > 0;
    }),
  );
  const hasBudget = auditBudgetItems.length > 0;
  const mode = lockedSections.length > 0 || scope ? 'delta_reaudit' : 'primary_audit';

  let auditOutput: AuditOutput;
  if (hasFilledOpenField || hasBudget) {
    auditOutput = await callLlm(
      deps.llm,
      'audit',
      {
        mode,
        open_blocks: auditSections.map((s) => ({
          section_id: s.id,
          fields: s.fields.map((f) => {
            const rec = records.find((r) => r.section_id === s.id && r.field_key === f);
            const val = rec?.value ?? null;
            return {
              field_key: f,
              // Мерило одобрения поля — тот же критерий базы знаний, что и у валидатора ответа
              criteria: fieldKb(deps.kb, s.id, f).criteria,
              value: val ? wrapUntrustedData(`field:${s.id}/${f}`, val) : null,
              review_status: rec?.review_status ?? 'draft',
              claims: (rec?.claims ?? []).map((c) => ({
                claim_text: c.claim_text,
                claim_type: c.claim_type,
                verification_status: c.verification_status,
              })),
            };
          }),
        })),
        locked_blocks: lockedSections.map((s) => ({
          section_id: s.id,
          fields: s.fields.map((f) => ({
            field_key: f,
            value: records.find((r) => r.section_id === s.id && r.field_key === f)?.value ?? null,
          })),
        })),
        // Блоки с замечаниями прошлого аудита, которые студент ещё не исправил: только контекст, не оценивать
        pending_blocks: pendingSections.map((s) => ({
          section_id: s.id,
          fields: s.fields.map((f) => {
            const val = records.find((r) => r.section_id === s.id && r.field_key === f)?.value ?? null;
            return { field_key: f, value: val ? wrapUntrustedData(`field:${s.id}/${f}`, val) : null };
          }),
        })),
        budget_items: auditBudgetItems.map((b) => ({
          stage: b.stage,
          category: b.category,
          title: b.title,
          quantity: b.quantity,
          unit_price: b.unit_price,
          amount: b.amount,
          justification: b.justification,
        })),
        code_warnings: codeWarnings,
        rag_context: ragContextText,
      },
      auditOutputSchema,
    );
  } else {
    auditOutput = {
      fatal_stop_factors: [],
      block_audits: auditSections.map((s) => ({
        section_id: s.id,
        status: 'needs_revision',
        remark: `Блок ${s.id} не заполнен.`,
        how_to_fix: `Заполните обязательные поля блока ${s.id}.`,
        failed_fields: s.fields.filter((f) => !OPTIONAL_FIELDS.has(`${s.id}/${f}`)),
      })),
      budget_audit: {
        status: 'not_provided',
        remark: null,
        how_to_fix: null,
      },
    };
  }

  // 5. Обработка вердикта и обновление замков в БД
  const shouldUpdateDbLocks =
    typeof (deps.llm as any).hasOverride === 'function'
      ? (deps.llm as any).hasOverride('audit')
      : true;

  const fatalStopFactorsOut: FatalStopFactorOut[] = (auditOutput.fatal_stop_factors ?? []).map((f) => ({
    code: f.code,
    reason: f.reason,
    how_to_fix: f.how_to_fix,
    affected_sections: f.affected_sections?.length ? f.affected_sections : [3, 4],
  }));
  // Стоп-фактор прошлого аудита по блокам, которые сейчас не перепроверялись, остаётся в силе
  if (scope) {
    for (const f of scope.previous.fatal_stop_factors ?? []) {
      if (f.affected_sections.some((s) => auditIds.has(s))) continue;
      if (!fatalStopFactorsOut.some((x) => x.code === f.code)) fatalStopFactorsOut.push(f);
    }
  }

  const fatalSections = new Set<number>();
  for (const f of fatalStopFactorsOut) {
    for (const s of f.affected_sections) {
      fatalSections.add(s);
    }
  }

  // При обнаружении фатального стоп-фактора затронутые секции принудительно размораживаются
  if (shouldUpdateDbLocks && fatalSections.size > 0) {
    for (const sId of fatalSections) {
      const sec = PASSPORT_SECTIONS.find((s) => s.id === sId);
      if (!sec) continue;
      const targets = sec.fields.map((f) => ({ section_id: sId, field_key: f }));
      await deps.store.markFieldsNeedsReview(projectId, targets);
    }
  }

  const novelty = noveltyVerdict(auditOutput.novelty_audit, deps.kb.rules.min_analogues);
  const finalBlockAudits: BlockAuditOut[] = [];
  const sectionsToApprove: number[] = [];

  for (const s of auditSections) {
    const emptyFields: string[] = [];
    for (const f of s.fields) {
      if (OPTIONAL_FIELDS.has(`${s.id}/${f}`)) continue;
      const rec = records.find((r) => r.section_id === s.id && r.field_key === f);
      const minLen = CODE_FIELDS.has(`${s.id}/${f}`) ? 0 : MIN_FIELD_LENGTH;
      if (!rec?.value || rec.value.trim().length <= minLen) {
        emptyFields.push(f);
      }
    }

    const kimiAudit = auditOutput.block_audits.find((b) => b.section_id === s.id);
    const isFatal = fatalSections.has(s.id);
    const hasMismatch = s.id === 4 && !!mismatch;
    // Вердикт новизны неизвестен (модель не дала счёт аналогов) — блок 6 решается по его block_audits.
    const noveltyPassed = s.id === 6 ? (novelty.known ? novelty.passed : true) : true;

    const canApprove =
      emptyFields.length === 0 &&
      !isFatal &&
      !hasMismatch &&
      kimiAudit?.status === 'approved' &&
      // Страховка от ложного approved: модель одобрила, но оставила проблемные поля или текст замечания
      (kimiAudit?.failed_fields?.length ?? 0) === 0 &&
      !kimiAudit?.remark?.trim() &&
      noveltyPassed;

    if (canApprove) {
      sectionsToApprove.push(s.id);
      finalBlockAudits.push({
        section_id: s.id,
        status: 'approved',
        remark: null,
        how_to_fix: null,
        failed_fields: [],
      });
    } else {
      const failedFields = Array.from(new Set([...emptyFields, ...(kimiAudit?.failed_fields ?? [])]));
      if (failedFields.length === 0) {
        if (isFatal) failedFields.push(...s.fields.filter((f) => !OPTIONAL_FIELDS.has(`${s.id}/${f}`)));
        if (hasMismatch) failedFields.push('tech_challenge');
      }

      let remark = studentFacingRemark(kimiAudit?.remark);
      let howToFix = studentFacingRemark(kimiAudit?.how_to_fix);

      if (isFatal) {
        const fatal = fatalStopFactorsOut.find((f) => f.affected_sections.includes(s.id));
        if (fatal) {
          remark = `[Фатальный стоп-фактор: ${fatal.code}] ${fatal.reason}`;
          howToFix = fatal.how_to_fix;
        }
      } else if (hasMismatch) {
        remark = `[Критерий: Научно-техническая обоснованность] Несоответствие направления и технологического вызова: ${mismatch}`;
        howToFix = 'Выберите технологический вызов, соответствующий тематическому направлению проекта (Блок 4).';
      } else if (emptyFields.length > 0 && !remark) {
        remark = `В Блоке ${s.id} не заполнены обязательные поля: ${fieldTitles(emptyFields)}.`;
        howToFix = `Заполните обязательные поля: ${fieldTitles(emptyFields)}.`;
      }

      finalBlockAudits.push({
        section_id: s.id,
        status: 'needs_review',
        remark,
        how_to_fix: howToFix,
        failed_fields: failedFields,
      });

      if (shouldUpdateDbLocks) {
        const targetsToMark = (failedFields.length > 0 ? failedFields : s.fields).map((fk) => ({
          section_id: s.id,
          field_key: fk,
        }));
        await deps.store.markFieldsNeedsReview(projectId, targetsToMark);
      }
    }
  }

  if (shouldUpdateDbLocks && sectionsToApprove.length > 0) {
    await deps.store.approveSectionFields(projectId, sectionsToApprove);
  }

  // Блоки, ждущие правок студента: вердикт прошлого аудита без изменений
  for (const s of pendingSections) {
    const prev = scope?.previous.block_audits.find((b) => b.section_id === s.id);
    // Одобренный блок, размороженный правкой связанного: замечаний нет, вердикт «одобрен» в силе до его ре-аудита
    // (иначе он стал бы пробелом без замечания и студента спрашивали бы о нём по кругу).
    if (prev?.status === 'approved') {
      finalBlockAudits.push(prev);
      continue;
    }
    finalBlockAudits.push({
      section_id: s.id,
      status: 'needs_review',
      remark: prev?.remark ?? null,
      how_to_fix: prev?.how_to_fix ?? null,
      failed_fields: prev?.failed_fields?.length
        ? prev.failed_fields
        : s.fields.filter((f) => {
            const rec = records.find((r) => r.section_id === s.id && r.field_key === f);
            return !OPTIONAL_FIELDS.has(`${s.id}/${f}`) && (!rec?.value?.trim() || rec.review_status === 'needs_review');
          }),
    });
  }

  // Обработка ранее заблокированных секций (locked)
  for (const s of lockedSections) {
    if (fatalSections.has(s.id)) {
      const fatal = fatalStopFactorsOut.find((f) => f.affected_sections.includes(s.id));
      finalBlockAudits.push({
        section_id: s.id,
        status: 'needs_review',
        remark: fatal ? `[Фатальный стоп-фактор: ${fatal.code}] ${fatal.reason}` : 'Обнаружен стоп-фактор проекта.',
        how_to_fix: fatal ? fatal.how_to_fix : 'Переформулируйте проект в гражданскую и научно-техническую плоскость.',
        failed_fields: s.fields.filter((f) => !OPTIONAL_FIELDS.has(`${s.id}/${f}`)),
      });
    } else {
      finalBlockAudits.push({
        section_id: s.id,
        status: 'approved',
        remark: null,
        how_to_fix: null,
        failed_fields: [],
      });
    }
  }

  finalBlockAudits.sort((a, b) => a.section_id - b.section_id);

  // Смысловая проверка сметы (budget_audit)
  let budgetAuditOut: BudgetAuditOut;
  if (!budgetInScope && scope) {
    // Смета не менялась с прошлого аудита — её вердикт в силе
    budgetAuditOut = scope.previous.budget_audit;
  } else if (budgetItems.length === 0) {
    budgetAuditOut = {
      status: 'not_provided',
      remark: null,
      how_to_fix: null,
      violations: [],
    };
  } else {
    const budgetHasNeedsReview = budgetItems.some((b) => b.review_status === 'needs_review');
    const budgetViolations = budgetErrors.map((e) => e.message);
    if (budgetHasNeedsReview) {
      budgetViolations.push('Смета: связанные блоки изменились. Подтвердите смету заново.');
    }
    const isBudgetKimiApproved = auditOutput.budget_audit?.status === 'approved' && !budgetHasNeedsReview;
    if (budgetViolations.length === 0 && isBudgetKimiApproved) {
      if (shouldUpdateDbLocks) await deps.store.approveBudgetItems(projectId);
      budgetAuditOut = {
        status: 'approved',
        remark: null,
        how_to_fix: null,
        violations: [],
      };
    } else {
      if (shouldUpdateDbLocks) await deps.store.markBudgetNeedsReview(projectId);
      budgetAuditOut = {
        status: 'needs_review',
        remark:
          studentFacingRemark(auditOutput.budget_audit?.remark) ??
          (budgetViolations.length > 0 ? budgetViolations.join('; ') : 'Смета требует доработки.'),
        how_to_fix:
          studentFacingRemark(auditOutput.budget_audit?.how_to_fix) ??
          'Скорректируйте статьи сметы в соответствии с правилами конкурса и ограничениями лимитов.',
        violations: budgetViolations,
      };
    }
  }

  const report: AuditReport = {
    mode,
    fatal_stop_factors: fatalStopFactorsOut,
    block_audits: finalBlockAudits,
    budget_audit: budgetAuditOut,
    novelty_audit: scope && !auditIds.has(6) ? scope.previous.novelty_audit : auditOutput.novelty_audit,
    created_at: new Date().toISOString(),
    // Слепок после записи вердиктов: следующий запрос по нему поймёт, что студент изменил с этого аудита
    fingerprint: auditFingerprint(await deps.store.getRecords(projectId), await deps.store.getBudgetItems(projectId), limits),
  };

  // Сохраняем сводный JSON отчёта аудита в служебную секцию 0
  await deps.store.upsertField(projectId, 0, 'latest_audit_report', JSON.stringify(report));

  return report;
}
