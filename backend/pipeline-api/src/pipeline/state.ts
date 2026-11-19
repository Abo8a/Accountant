// Состояние кабинета без вызова моделей: паспорт, вердикты аудита, смета, итог проверки, тариф и справка об обучении.
// Нужно экранам кабинета («Паспорт», «Итог», «Материалы», «Тариф»), когда ответа пайплайна нет в текущей вкладке.
import { createHash } from 'node:crypto';
import type { BlockAuditOut, BudgetAuditOut, PipelinePassportField } from '@passport/contracts';
import { STUDY_CERTIFICATE_WARNING } from '@passport/passport-core';
import { PipelineFailure } from '../errors';
import type { StudyCertificateMeta, UserContext } from '../db/store';
import type { PipelineDeps } from './deps';
import { loadAuditReport } from './audit';
import { buildPassportFields } from './passport';

export interface CabinetState {
  status: 'OK';
  plan_id: string;
  plan_expires_at: string | null;
  files_used: number;
  files_limit: number;
  founder: Record<string, unknown>;
  study_certificate: StudyCertificateMeta | null;
  project_status: string | null;
  passport: PipelinePassportField[];
  block_audits: BlockAuditOut[];
  budget_audit: BudgetAuditOut | null;
  /** Итог последней проверки (шаг 8) или null, если паспорт ещё не дошёл до конца. */
  result: { eligibility_status: string; summary: string; checklist: string[]; warnings: string[]; calculated_at: string } | null;
}

export async function loadCabinetState(deps: PipelineDeps, ctx: UserContext): Promise<CabinetState> {
  const records = ctx.project ? await deps.store.getRecords(ctx.project.id) : [];
  const report = loadAuditReport(records);
  const rawResult = records.find((r) => r.section_id === 0 && r.field_key === 'navigator_summary_and_checklist')?.value;
  let result: CabinetState['result'] = null;
  try {
    result = rawResult ? JSON.parse(rawResult) : null;
  } catch {
    result = null;
  }
  // Справку загрузили после последней проверки: её предупреждение уже неактуально (на итог оно не влияет), не ждём пересчёта.
  if (result && ctx.studyCertificate) {
    result = { ...result, warnings: (result.warnings ?? []).filter((w) => w !== STUDY_CERTIFICATE_WARNING) };
  }
  return {
    status: 'OK',
    plan_id: ctx.planId,
    plan_expires_at: ctx.planExpiresAt,
    files_used: ctx.uploadedFilesCount,
    files_limit: ctx.fileUploadsLimit,
    founder: ctx.founderData,
    study_certificate: ctx.studyCertificate,
    project_status: ctx.project?.status ?? null,
    passport: ctx.project?.hasRecords ? buildPassportFields(records) : [],
    block_audits: report?.block_audits ?? [],
    budget_audit: report?.budget_audit ?? null,
    result,
  };
}

export const STUDY_CERTIFICATE_MAX_BYTES = 8 * 1024 * 1024;

/** Допустимые форматы справки: PDF и фото/скан. Тип проверяется по сигнатуре файла, а не только по заголовку. */
const SIGNATURES: { mime: string; magic: number[] }[] = [
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
];

export function detectCertificateMime(content: Buffer): string | null {
  return SIGNATURES.find((s) => s.magic.every((b, i) => content[i] === b))?.mime ?? null;
}

export async function saveStudyCertificate(
  deps: PipelineDeps,
  userId: string,
  fileName: string,
  content: Buffer,
): Promise<StudyCertificateMeta> {
  const name = fileName.trim().slice(0, 255);
  if (!name) throw new PipelineFailure('INVALID_FIELD_VALUE', 'Не указано имя файла справки.');
  if (content.length === 0) throw new PipelineFailure('INVALID_FIELD_VALUE', 'Файл справки пустой.');
  if (content.length > STUDY_CERTIFICATE_MAX_BYTES) {
    throw new PipelineFailure('INVALID_FIELD_VALUE', 'Файл справки больше 8 МБ.');
  }
  const mime = detectCertificateMime(content);
  if (!mime) throw new PipelineFailure('INVALID_FIELD_VALUE', 'Справку можно загрузить в формате PDF, JPG или PNG.');
  const sha256 = createHash('sha256').update(content).digest('hex');
  return deps.store.saveStudyCertificate(userId, { file_name: name, mime_type: mime, sha256_hash: sha256, content });
}
