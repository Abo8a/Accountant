// Проверка JSON-ответов LLM. Всё, что не проходит схему, превращается в INTERNAL (а не в мусор в БД).
import { z } from 'zod';
import { PipelineFailure } from '../errors';
import type { LlmClient, LlmTask } from './types';

const claimSchema = z.object({
  claim_text: z.string().min(1),
  claim_type: z.enum(['fact', 'plan', 'hypothesis', 'client_statement']),
  // Вид утверждения — вспомогательная метка. Живой прогон 18.11.2026: модель вернула «role_and_education»,
  // «absence_of_open_obligations» — из-за этого принятый ответ студента превращался в INTERNAL. Неизвестное → null.
  claim_kind: z.enum(['number', 'money', 'date', 'sentence', 'list_item', 'paragraph']).nullish().catch(null),
  source_id: z.string().nullish(),
  source_locator: z.object({ page: z.number().int(), quote: z.string() }).nullish(),
  confidence: z.number().nullish(),
});

export const anchorSchema = z.object({ anchor_summary: z.string().min(1) });

/** Раскладка текста полей по анкетам: данные проверяются отдельно (sanitizeFieldForm), здесь — только каркас. */
export const fillFormsSchema = z.object({
  forms: z
    .array(z.object({ section_id: z.number().int(), field_key: z.string(), data: z.record(z.string(), z.unknown()).nullable().catch(null) }))
    .catch([]),
});

export const extractSchema = z.object({
  fields: z.array(
    z.object({
      section_id: z.number().int(),
      field_key: z.string(),
      value: z.string().nullable(),
      claims: z.array(claimSchema).default([]),
    }),
  ),
});

export const validateSchema = z.object({
  is_valid: z.boolean(),
  rejection_reason: z.string().nullish(),
  formatted_value: z.string().nullish(),
  claims: z.array(claimSchema).default([]),
});

export const noveltySchema = z.object({
  analogues_count: z.number().int().min(0),
  analogues_list: z.array(z.string()).default([]),
  has_measurable_comparison: z.boolean(),
  missing_details_question: z.string().nullish(),
});

export const navigatorSchema = z.object({
  summary: z.string(),
  checklist: z.array(z.string()).default([]),
});

type FatalCode = 'MILITARY_OR_DUAL_USE' | 'NO_TECH_BASIS';

/** Код стоп-фактора из ответа модели; неизвестный код — null (запись отбрасывается, а не превращается в NO_TECH_BASIS). */
export function toFatalCode(raw: unknown): FatalCode | null {
  const c = String(raw ?? '').toUpperCase();
  if (c.includes('MILITARY') || c.includes('DUAL')) return 'MILITARY_OR_DUAL_USE';
  if (c.includes('NO_TECH') || c.includes('TECH_BASIS')) return 'NO_TECH_BASIS';
  return null;
}

const NOT_DETECTED_FLAGS = ['detected', 'present', 'found', 'is_detected', 'triggered'];

/**
 * Приводит fatal_stop_factors к массиву ОБНАРУЖЕННЫХ стоп-факторов.
 * Живые ответы моделей (18.11.2026): записи с detected:false для каждого кода («проверено — не найдено»),
 * ключ factor вместо code, объект вместо массива. Раньше первое давало ложный стоп-фактор, остальное — INTERNAL.
 */
export function normalizeFatalStopFactors(value: unknown): unknown[] {
  if (value == null) return [];
  let items: unknown[];
  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    items =
      'code' in obj || 'factor' in obj
        ? [obj]
        : Object.entries(obj).map(([key, v]) =>
            v && typeof v === 'object' ? { code: key, ...(v as object) } : { code: key, detected: Boolean(v) },
          );
  } else {
    return [];
  }
  const out: unknown[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (NOT_DETECTED_FLAGS.some((f) => rec[f] === false)) continue;
    const code = toFatalCode(rec.code ?? rec.factor ?? rec.type ?? rec.id ?? rec.name);
    if (!code) continue;
    out.push({ ...rec, code });
  }
  return out;
}

export const fatalStopFactorSchema = z.object({
  code: z.enum(['MILITARY_OR_DUAL_USE', 'NO_TECH_BASIS']),
  reason: z.string().nullish().transform((v) => v || 'Обнаружен стоп-фактор проекта.'),
  how_to_fix: z.string().nullish().transform((v) => v || 'Переформулируйте проект в гражданскую и научно-техническую плоскость.'),
  affected_sections: z.array(z.number().int().min(2).max(10)).default([3, 4]),
});

export const blockAuditItemSchema = z.object({
  section_id: z.number().int().min(2).max(10),
  status: z.enum(['approved', 'needs_revision']).or(z.string().transform((s) => (s === 'approved' ? 'approved' : 'needs_revision'))),
  remark: z.string().nullish(),
  how_to_fix: z.string().nullish(),
  failed_fields: z.array(z.string()).default([]),
});

/** Ранняя проверка стоп-факторов по брифу (до сборки паспорта). */
export const screenOutputSchema = z.object({
  fatal_stop_factors: z.preprocess(normalizeFatalStopFactors, z.array(fatalStopFactorSchema)),
});

export const auditOutputSchema = z.object({
  fatal_stop_factors: z.preprocess(normalizeFatalStopFactors, z.array(fatalStopFactorSchema)),
  block_audits: z.array(blockAuditItemSchema).default([]),
  // Без значений по умолчанию: если модель не вернула счёт аналогов, вердикт новизны неизвестен
  // (см. noveltyVerdict), а не «0 аналогов, не пройдено» — иначе блок 6 нельзя одобрить никогда.
  novelty_audit: z
    .object({
      analogues_count: z.number().int().min(0).nullish(),
      analogues_list: z.array(z.string()).nullish(),
      has_measurable_comparison: z.boolean().nullish(),
      passed: z.boolean().nullish(),
      status: z.string().nullish(),
      remark: z.string().nullish(),
      how_to_fix: z.string().nullish(),
    })
    .passthrough()
    .nullish(),
  budget_audit: z
    .object({
      status: z
        .enum(['approved', 'needs_revision', 'not_provided'])
        .or(
          z.string().transform((s) => {
            if (s === 'approved') return 'approved' as const;
            if (s === 'not_provided') return 'not_provided' as const;
            return 'needs_revision' as const;
          }),
        )
        .default('not_provided'),
      remark: z.string().nullish(),
      how_to_fix: z.string().nullish(),
    })
    .nullish(),
});

export type NoveltyAudit = NonNullable<z.output<typeof auditOutputSchema>['novelty_audit']>;

/**
 * Вердикт новизны из novelty_audit аудита. known = false, если модель не вернула счёт аналогов и признак
 * измеримого сравнения: тогда блок 6 решается по его block_audits, а на финализации вызывается отдельная проверка новизны.
 */
export function noveltyVerdict(
  na: NoveltyAudit | null | undefined,
  minAnalogues: number,
): { known: false } | { known: true; passed: boolean; analogues_count: number; question: string | null } {
  if (!na || typeof na.analogues_count !== 'number' || typeof na.has_measurable_comparison !== 'boolean') {
    return { known: false };
  }
  return {
    known: true,
    passed: na.passed !== false && na.analogues_count >= minAnalogues && na.has_measurable_comparison,
    analogues_count: na.analogues_count,
    question: na.how_to_fix ?? na.remark ?? null,
  };
}

export type LlmClaim = z.output<typeof claimSchema>;
export type ExtractOutput = z.output<typeof extractSchema>;
export type ValidateOutput = z.output<typeof validateSchema>;
export type NoveltyOutput = z.output<typeof noveltySchema>;
export type NavigatorOutput = z.output<typeof navigatorSchema>;
export type FatalStopFactor = z.output<typeof fatalStopFactorSchema>;
export type BlockAuditItem = z.output<typeof blockAuditItemSchema>;
export type AuditOutput = z.output<typeof auditOutputSchema>;

export const consultantSchema = z.object({
  reply: z.string().min(1),
  referenced_cards: z.array(z.string()).nullish().transform((v) => v ?? []),
});

export type ConsultantOutput = z.output<typeof consultantSchema>;

/** Вызов LLM + проверка формы ответа. */
export async function callLlm<S extends z.ZodTypeAny>(
  llm: LlmClient,
  task: LlmTask,
  input: unknown,
  schema: S,
): Promise<z.output<S>> {
  const raw = await llm.complete(task, input);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineFailure('INTERNAL', `LLM (${task}) вернул неверный формат: ${parsed.error.message}`);
  }
  return parsed.data;
}
