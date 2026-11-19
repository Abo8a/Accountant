// Оркестратор пайплайна (аналог n8n-графа ТЗ, блоки 1–5). Stateless: контекст вопроса приходит в запросе.
import type { PipelineRequest, PipelineResponse, TargetField } from '@passport/contracts';
import { isValidPassportField } from '@passport/contracts';
import type { DependencyNode } from '@passport/passport-core';
import { noteFieldChange, invalidateDependents } from './invalidation';
import { PipelineFailure } from '../errors';
import { fieldKb } from '../kb/manifest';
import { wrapUntrustedData } from '../promptGuard';
import type { AiCreditCosts, UserContext } from '../db/store';
import { ingestFiles } from './intake';
import type { PipelineDeps } from './deps';
import { answerField, extractPassport } from './passport';
import { GUARD_QUERY_MAX_CHARS, GUARDED_ANSWER_SECTIONS } from './anchor';
import { gateEligibility } from './eligibility';
import { handleSubmitForm } from './form';
import { nextStep, skippedKeys } from './next';
import { LoggedLlm } from '../llm/logged';
import { screenStopFactors, stopFactorBriefQuestion } from './screen';

const SHORT_ANSWER_CHARS = 150;
const CODE_FIELDS = new Set(['4/direction', '4/tech_challenge']);

/** Сообщение, когда ИИ-кредитов не хватает на действие. Ручная работа при этом остаётся доступной. */
export const AI_CREDITS_EXHAUSTED_MESSAGE =
  'ИИ-кредиты закончились. Ручное редактирование, материалы и экспорт остаются доступны. ' +
  'Чтобы продолжить работу с ИИ, подключите «Пакет ИИ» в разделе «Тариф и оплата».';

/** Действия, которые тратят ИИ-кредиты. Ручные правки формы и пропуск вопроса — бесплатны. */
export function isAiAction(req: PipelineRequest): boolean {
  if (req.action === 'submit_answer') return true;
  if (req.action === 'init_or_upload') return Boolean(req.text_input?.trim()) || (req.files?.length ?? 0) > 0;
  return false;
}

/** Стоимость действия в кредитах: шаг с ИИ плюс разбор каждого нового файла. */
export function aiActionCost(req: PipelineRequest, costs: AiCreditCosts): number {
  return costs.ai_step + (req.files?.length ?? 0) * costs.file;
}

/** Каждый вызов LLM в этом запросе пишется в журнал llm_call_log (блок 4). */
export function withCallLogging(deps: PipelineDeps, userId: string | null): PipelineDeps {
  return { ...deps, llm: new LoggedLlm(deps.llm, (e) => deps.store.insertLlmLog(e), userId) };
}

/**
 * Единая точка входа. Ожидаемые ошибки → ERROR с кодом; прочее логируется и отдаётся как INTERNAL.
 * Блокировка (блок 4): пока по пользователю идёт проверка, второй запуск получает ALREADY_PROCESSING.
 */
export async function handlePipeline(baseDeps: PipelineDeps, req: PipelineRequest): Promise<PipelineResponse> {
  const deps = withCallLogging(baseDeps, req.user_id);
  try {
    const lock = await deps.store.acquireProcessingLock(req.user_id);
    if (lock === 'busy') {
      return { status: 'ERROR', code: 'ALREADY_PROCESSING', message: 'Проверка уже идёт. Дождитесь результата и не отправляйте запрос повторно.' };
    }
    if (lock === 'no_user') return await run(deps, req, {}); // профиля нет: run ответит USER_BANNED
    try {
      const meter: CreditMeter = {};
      const response = await run(deps, req, meter);
      await chargeCredits(deps, req, meter, response);
      return response;
    } finally {
      await deps.store.releaseProcessingLock(req.user_id);
    }
  } catch (err) {
    if (err instanceof PipelineFailure) {
      return { status: 'ERROR', code: err.code, message: err.message };
    }
    deps.logger.error('[pipeline] unexpected error', err);
    return { status: 'ERROR', code: 'INTERNAL', message: 'Внутренняя ошибка пайплайна' };
  }
}

/** Пропущенные пробелы запроса; для skip_gap текущий пробел тоже считается пропущенным. */
export function skipSet(req: PipelineRequest): Set<string> {
  const current = req.action === 'skip_gap' && req.target_field ? [req.target_field] : [];
  return skippedKeys([...(req.skipped_fields ?? []), ...current]);
}

/** Что нужно для списания кредитов после ответа: стоимость действий из контекста пользователя. */
interface CreditMeter {
  costs?: AiCreditCosts;
}

/**
 * Списывает ИИ-кредиты после успешного ответа. Ошибки (status ERROR) и ответы без обращения к модели
 * не списывают ничего. Сбой списания не ломает ответ пользователю — пишем в журнал.
 */
async function chargeCredits(deps: PipelineDeps, req: PipelineRequest, meter: CreditMeter, response: PipelineResponse) {
  if (!meter.costs || response.status === 'ERROR' || !isAiAction(req)) return;
  const llm = deps.llm as LoggedLlm;
  const files = req.files?.length ?? 0;
  if (llm.completeCalls === 0 && files === 0) return;
  const amount = (llm.completeCalls > 0 ? meter.costs.ai_step : 0) + files * meter.costs.file;
  try {
    await deps.store.spendAiCredits(req.user_id, amount, req.action);
  } catch (err) {
    deps.logger.error('[pipeline] credits charge failed', err);
  }
}

async function run(deps: PipelineDeps, req: PipelineRequest, meter: CreditMeter): Promise<PipelineResponse> {
  const { store, kb } = deps;

  // ШАГ 1: бан, программа, квота, ФИО
  const ctx = await store.loadContext(req.user_id);
  if (!ctx || ctx.isBanned) {
    throw new PipelineFailure('USER_BANNED', 'Профиль не найден или заблокирован');
  }
  if (req.program !== kb.program) {
    throw new PipelineFailure('INTERNAL', `Программа «${req.program}» пока не поддерживается`);
  }

  const files = req.files ?? [];
  if (files.length > 0) {
    if (!ctx.features.ai_parsing) {
      throw new PipelineFailure('PLAN_UPGRADE_REQUIRED', 'На вашем тарифе загрузка документов недоступна');
    }
    if (ctx.uploadedFilesCount + files.length > ctx.fileUploadsLimit) {
      throw new PipelineFailure('FILE_QUOTA_EXCEEDED', 'Превышен лимит загрузки файлов по тарифу');
    }
  }
  // ИИ-кредиты: стоимость видна заранее, без кредитов ИИ-действие не начинается (ручная работа доступна всегда).
  if (isAiAction(req)) {
    const cost = aiActionCost(req, ctx.aiCredits.costs);
    if (ctx.aiCredits.balance < cost) {
      throw new PipelineFailure('AI_CREDITS_EXHAUSTED', AI_CREDITS_EXHAUSTED_MESSAGE);
    }
    meter.costs = ctx.aiCredits.costs;
  }
  // ФИО хранится в ключе full_name (нормализация — в store.normalizeFounder).
  if (!ctx.founderData.full_name) {
    throw new PipelineFailure('FOUNDER_REQUIRED', 'Укажите ФИО в профиле основателя');
  }

  // ШАГ 0 (задача 1.1): анкета допуска. Отказ — финальный, пайплайн дальше не идёт.
  const gate = await gateEligibility(deps, req, ctx);
  if (gate) return gate;

  if (req.action === 'submit_form') {
    return handleSubmitForm(deps, req, ctx);
  }
  // Ветка по наличию полей паспорта: якорь может появиться позже (см. nextStep), а ответы на пробелы должны идти в «есть».
  if (ctx.project?.anchorReady || ctx.project?.hasRecords) {
    return handleExistingProject(deps, req, ctx);
  }
  return handleNewProject(deps, req, ctx);
}

/** Ветка «Новый» (G1): якорь ещё не создан (холодный старт, Баг №1). */
async function handleNewProject(deps: PipelineDeps, req: PipelineRequest, ctx: UserContext): Promise<PipelineResponse> {
  const { store, kb } = deps;
  const projectId = ctx.project?.id ?? (await store.ensureProject(req.user_id));

  await ingestFiles(deps, projectId, req.files ?? []);
  const sources = await store.listSources(projectId);

  const brief = [req.text_input ?? '', ...sources.map((s) => s.extracted_text ?? '')]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');

  // S3B: нет ни текста, ни файлов — отдаём стартовую анкету из КБ за 0 токенов (U_INIT)
  if (!brief) {
    return {
      status: 'WAITING_FOR_INITIAL_BRIEF',
      step: 'INITIAL_BRIEF',
      question: kb.initial_brief.question,
      example: kb.initial_brief.example,
    };
  }

  // Якорь создаётся позже — когда заполнены блоки 3 и 4 (см. nextStep → anchorBriefFromRecords).

  // Стоп-фактор идеи виден уже по брифу: не собираем паспорт по теме, которую фонд не поддержит
  const stopFactors = await screenStopFactors(deps, brief);
  if (stopFactors.length > 0) return stopFactorBriefQuestion(deps, stopFactors);

  // ШАГ 4–5: извлечение и аудит
  await extractPassport(deps, projectId, req.program, req.text_input ?? '', sources);
  return nextStep(deps, ctx, projectId, req.program, skipSet(req));
}

/** Ветка «Есть» (G1 → S2): проект с якорем — guard, затем ответ или новые данные. */
async function handleExistingProject(deps: PipelineDeps, req: PipelineRequest, ctx: UserContext): Promise<PipelineResponse> {
  const { store, llm } = deps;
  const project = ctx.project!;
  const projectId = project.id;

  const target: TargetField | undefined = req.target_field;
  if (target && !isValidPassportField(target.section_id, target.field_key)) {
    throw new PipelineFailure('INVALID_TARGET', `Неизвестное поле ${target.section_id}/${target.field_key}`);
  }

  // ШАГ 3А: новые файлы (только новые по sha256)
  const added = await ingestFiles(deps, projectId, req.files ?? []);
  const text = (req.text_input ?? '').trim();
  const newText = [text, ...added.map((s) => s.extracted_text ?? '')].filter(Boolean).join('\n\n');

  // ШАГ 2 [AI Guard]: сверка нового ввода с якорем.
  // Ответ на точечный вопрос по блоку вне 3–4 с якорем не сравниваем (см. GUARDED_ANSWER_SECTIONS); новые файлы — всегда.
  // Короткий ответ на точечный вопрос (и коды направления/вызова) тоже не сравниваем: в нём слишком мало текста для
  // сходства с якорем — честный ответ «Н4 — новые приборы…» давал 0.35 и ложную блокировку. Чужую тему в ответе ловит
  // валидатор ответа по выжимке проекта (мягко: отклоняет ответ, а не блокирует аккаунт).
  const isAnswer = req.action === 'submit_answer' && !!target;
  const answerSkipsGuard =
    isAnswer && (!GUARDED_ANSWER_SECTIONS.has(target!.section_id) || CODE_FIELDS.has(`${target!.section_id}/${target!.field_key}`) || text.length < SHORT_ANSWER_CHARS);
  const filesText = added.map((s) => s.extracted_text ?? '').filter(Boolean).join('\n\n');
  const guardText = answerSkipsGuard ? filesText : newText;
  if (guardText && project.anchorReady) {
    const query = isAnswer && !answerSkipsGuard && req.previous_question ? `Вопрос по проекту: ${req.previous_question} Ответ: ${text}` : guardText;
    const embedding = await llm.embed(query.slice(0, GUARD_QUERY_MAX_CHARS));
    const guard = await store.guardCheck(projectId, embedding, guardText.slice(0, 500), ctx.thresholds);
    if (guard.action === 'blocked') {
      return {
        status: 'BLOCKED_PROJECT_SWAP',
        similarity_score: Math.round(guard.score * 100) / 100,
        message: 'Загруженные материалы относятся к другому проекту. По правилам платформы 1 аккаунт = 1 проект.',
      };
    }
  }

  if (req.action === 'submit_answer' && target) {
    // U_LOOP: ответ на конкретное поле
    const kb = fieldKb(deps.kb, target.section_id, target.field_key);
    const question = req.previous_question ?? kb.question;
    if (!text) {
      return { status: 'ANSWER_REJECTED', step: 'ANSWER_VALIDATION', target_field: target, question, example: kb.example, rejection_reason: 'Ответ пустой' };
    }
    const prev = await store.getFieldValue(projectId, target.section_id, target.field_key);
    const result = await answerField(deps, projectId, target, question, text, project.anchorSummary);
    if (!result.ok) {
      return {
        status: 'ANSWER_REJECTED',
        step: 'ANSWER_VALIDATION',
        target_field: target,
        question,
        example: kb.example,
        rejection_reason: result.reason,
      };
    }
    // Переписан уже заполненный блок — его зависимые на повторную проверку (задача 1.5)
    const changed = new Set<DependencyNode>();
    noteFieldChange(prev, text, target.section_id, changed);
    await invalidateDependents(store, projectId, changed);
  } else if (newText) {
    // Новые данные (текст или файлы) — переизвлечение паспорта
    const sources = await store.listSources(projectId);
    await extractPassport(deps, projectId, req.program, text, sources);
  }

  return nextStep(deps, ctx, projectId, req.program, skipSet(req));
}
