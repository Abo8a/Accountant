import type { BlockAuditOut, BudgetAuditOut, PipelinePassportField } from '@passport/contracts';
import { env } from '../config/env';

// Состояние кабинета с бэкенда (GET /pipeline/state, без вызова моделей) и загрузка справки об обучении.
// Нужно экранам кабинета в живом режиме: паспорт, итог, материалы и тариф — данные пользователя, а не пример из макета.

export interface StudyCertificate {
  file_name: string;
  size_bytes: number;
  uploaded_at: string;
}

/** Загруженный материал проекта (файл, из которого Буха собирает паспорт). */
export interface CabinetFile {
  id: string;
  file_name: string;
  sha256_hash: string;
  uploaded_at: string;
  /** null — размер неизвестен (файл загружен до того, как размер стали сохранять). */
  size_bytes: number | null;
  total_pages: number | null;
  /** Сколько утверждений паспорта опираются на этот файл. */
  claims: number;
}

export interface CabinetResult {
  eligibility_status: 'ELIGIBLE' | 'NEEDS_CLARIFICATION' | 'NOT_ELIGIBLE';
  summary: string;
  checklist: string[];
  warnings: string[];
  calculated_at: string;
}

export interface CabinetState {
  plan_id: 'free' | 'pro' | 'premium';
  /** Окончание оплаченного тарифа (ISO) или null — бесплатный тариф. */
  plan_expires_at: string | null;
  files_used: number;
  files_limit: number;
  founder: { full_name?: string; contacts?: string; education_status?: string; university?: string; region?: string };
  study_certificate: StudyCertificate | null;
  files: CabinetFile[];
  project_status: string | null;
  passport: PipelinePassportField[];
  block_audits: BlockAuditOut[];
  budget_audit: BudgetAuditOut | null;
  result: CabinetResult | null;
}

const stateUrl = () => `${env.pipelineUrl}/state`;
const certificateUrl = () => `${env.pipelineUrl}/study-certificate`;

/** Состояние кабинета или null (нет сессии, сеть недоступна). */
export async function fetchCabinetState(): Promise<CabinetState | null> {
  try {
    const res = await fetch(stateUrl(), { credentials: 'same-origin' });
    if (!res.ok) return null;
    const json = (await res.json()) as CabinetState & { status?: string };
    return json.status === 'OK' ? json : null;
  } catch {
    return null;
  }
}

export const STUDY_CERTIFICATE_ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
export const STUDY_CERTIFICATE_MAX_MB = 8;

export type UploadResult = { ok: true; certificate: StudyCertificate } | { ok: false; message: string };

/** Загружает справку об обучении (PDF, JPG или PNG до 8 МБ). Новая загрузка заменяет прежнюю. */
export async function uploadStudyCertificate(file: File): Promise<UploadResult> {
  if (file.size > STUDY_CERTIFICATE_MAX_MB * 1024 * 1024) {
    return { ok: false, message: `Файл больше ${STUDY_CERTIFICATE_MAX_MB} МБ.` };
  }
  try {
    const res = await fetch(certificateUrl(), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
      body: file,
    });
    const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string; study_certificate?: StudyCertificate };
    if (res.ok && json.study_certificate) return { ok: true, certificate: json.study_certificate };
    return { ok: false, message: json.message ?? 'Не удалось загрузить справку. Попробуйте ещё раз.' };
  } catch {
    return { ok: false, message: 'Не удалось загрузить справку. Попробуйте ещё раз.' };
  }
}
