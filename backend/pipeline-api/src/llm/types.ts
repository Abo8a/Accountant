export type LlmTask = 'anchor' | 'extract' | 'audit' | 'validate_answer' | 'novelty' | 'navigator' | 'consultant';

export const EMBEDDING_DIM = 4096;

/** Дополнительные параметры вызова задачи. */
export interface LlmCompleteOptions {
  /** Режим «Думать глубже» (сейчас влияет только на задачу consultant). */
  thinking?: boolean;
}

/** Абстракция над LLM: JSON-ответы по задаче и эмбеддинги. Реализации: OpenAiClient, FakeLlm (тесты). */
export interface LlmClient {
  readonly model: string;
  /** Возвращает распарсенный JSON; проверка формы — на стороне вызывающего (zod). */
  complete(task: LlmTask, input: unknown, options?: LlmCompleteOptions): Promise<unknown>;
  embed(text: string): Promise<number[]>;
}
