import { PipelineFailure } from '../errors';
import { SYSTEM_PROMPTS } from './prompts';
import type { LlmClient, LlmCompleteOptions, LlmTask } from './types';
import { callDeepSeek, callKimi, cleanLLMJsonOutput, type ReasoningEffort } from '../llm';
import { getEmbedding } from '../embeddings';
import { withSecurityGuardrail } from '../promptGuard';

export interface OpenAiConfig {
  apiKey?: string;
  baseUrl?: string;
  chatModel?: string;
  embeddingModel?: string;
  fetchImpl?: typeof fetch;
}

export interface LlmTaskParams {
  reasoningEffort: ReasoningEffort;
  temperature: number;
}

const DEFAULT_TASK_PARAMS: LlmTaskParams = { reasoningEffort: 'low', temperature: 0.1 };

/**
 * Глубина рассуждений и температура по задаче.
 * audit — самая глубокая проверка; extract — средняя; anchor и прочие — быстрые.
 * consultant зависит от переключателя «Думать глубже» (thinking).
 */
export function resolveLlmParams(task: LlmTask, options: LlmCompleteOptions = {}): LlmTaskParams {
  switch (task) {
    case 'audit':
      return { reasoningEffort: 'high', temperature: 0.1 };
    case 'extract':
      return { reasoningEffort: 'medium', temperature: 0.1 };
    case 'anchor':
      return { reasoningEffort: 'low', temperature: 0.1 };
    case 'consultant':
      return options.thinking === true
        ? { reasoningEffort: 'high', temperature: 0.2 }
        : { reasoningEffort: 'low', temperature: 0.3 };
    default:
      return DEFAULT_TASK_PARAMS;
  }
}

/** OpenAI-совместимый клиент с маршрутизацией по 3 независимым каналам. */
export class OpenAiClient implements LlmClient {
  readonly model: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(private readonly cfg: OpenAiConfig = {}) {
    this.model = cfg.chatModel ?? 'deepseek-v4.1-flash';
    this.fetchImpl = cfg.fetchImpl;
  }

  async complete(task: LlmTask, input: unknown, options: LlmCompleteOptions = {}): Promise<unknown> {
    const { reasoningEffort, temperature } = resolveLlmParams(task, options);

    if (this.fetchImpl) {
      const res = await this.post('/chat/completions', {
        model: this.cfg.chatModel ?? this.model,
        temperature,
        reasoning_effort: reasoningEffort,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: withSecurityGuardrail(SYSTEM_PROMPTS[task]) },
          { role: 'user', content: JSON.stringify(input) },
        ],
      });
      const content = res?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new PipelineFailure('INTERNAL', `LLM (${task}): пустой ответ`);
      try {
        return JSON.parse(cleanLLMJsonOutput(content));
      } catch {
        throw new PipelineFailure('INTERNAL', `LLM (${task}): ответ не является JSON`);
      }
    }

    const systemPrompt = SYSTEM_PROMPTS[task];
    const userPrompt = typeof input === 'string' ? input : JSON.stringify(input);
    const callOptions = { systemPrompt, userPrompt, temperature, reasoningEffort };

    try {
      // Канал 2 (Kimi Code): Шаг 6 (Первичный аудит и точечный ре-аудит, валидация ответа)
      if (task === 'audit' || task === 'validate_answer') {
        return await callKimi(callOptions);
      }

      // Канал 1 (OpenCode Go - DeepSeek): 'anchor', 'extract', 'novelty', 'consultant' (и 'navigator' для обратной совместимости)
      return await callDeepSeek(callOptions);
    } catch (err: any) {
      throw new PipelineFailure('INTERNAL', `LLM (${task}): ${err?.message ?? err}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    if (this.fetchImpl) {
      const res = await this.post('/embeddings', {
        model: this.cfg.embeddingModel ?? 'qwen3-embedding-8b',
        input: text,
      });
      const vector = res?.data?.[0]?.embedding;
      if (!Array.isArray(vector)) throw new PipelineFailure('INTERNAL', 'Embeddings: пустой ответ');
      return vector as number[];
    }

    try {
      // Канал 3 (AITunnel - qwen3-embedding-8b): генерация эмбеддингов
      return await getEmbedding(text);
    } catch (err: any) {
      throw new PipelineFailure('INTERNAL', `Embeddings: ${err?.message ?? err}`);
    }
  }

  private async post(path: string, body: unknown): Promise<any> {
    if (!this.fetchImpl) throw new Error('fetchImpl not configured');
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new PipelineFailure('INTERNAL', `LLM API HTTP ${res.status}`);
    return res.json();
  }
}
