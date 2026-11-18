// Ранняя проверка стоп-факторов идеи по первому брифу — до сборки паспорта (CJM: «Фатальный стоп-фактор идеи?»).
// Без неё военная тема или кафе без технологии проходили всю сборку (≈3 мин) и досбор всех блоков,
// а отказ студент узнавал только на полном аудите. Проверка настроена на точность: сомнительные случаи
// пропускаются, их ещё раз смотрит полный аудит.
import type { FatalStopFactorOut, PipelineQuestion } from '@passport/contracts';
import { callLlm, screenOutputSchema } from '../llm/schemas';
import { wrapUntrustedData } from '../promptGuard';
import type { PipelineDeps } from './deps';

const SCREEN_BRIEF_MAX_CHARS = 8_000;

/** Стоп-факторы, явно следующие из брифа. Сбой модели не блокирует студента: проверку повторит полный аудит. */
export async function screenStopFactors(deps: PipelineDeps, brief: string): Promise<FatalStopFactorOut[]> {
  try {
    const out = await callLlm(
      deps.llm,
      'screen',
      { brief: wrapUntrustedData('brief', brief.slice(0, SCREEN_BRIEF_MAX_CHARS)) },
      screenOutputSchema,
    );
    return out.fatal_stop_factors.map((f) => ({
      code: f.code,
      reason: f.reason,
      how_to_fix: f.how_to_fix,
      affected_sections: [3, 4],
    }));
  } catch (err) {
    deps.logger.warn('[screenStopFactors] проверка недоступна, решение — за полным аудитом:', err);
    return [];
  }
}

/** Ответ при стоп-факторе на брифе: паспорт не собирается, студента просят описать проект заново. */
export function stopFactorBriefQuestion(deps: PipelineDeps, factors: FatalStopFactorOut[]): PipelineQuestion {
  return {
    status: 'WAITING_FOR_INITIAL_BRIEF',
    step: 'INITIAL_BRIEF',
    question: deps.kb.initial_brief.question,
    example: deps.kb.initial_brief.example,
    rejection_reason: factors.map((f) => `${f.reason} ${f.how_to_fix}`.trim()).join(' '),
    fatal_stop_factors: factors,
  };
}
