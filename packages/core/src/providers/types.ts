import type { RiskTier, ToolCall, Usage } from '@axon/protocol';

/**
 * Единый интерфейс провайдера модели.
 *
 * Отличие от старого проекта: ошибки не приезжают событием в потоке, а
 * выбрасываются исключением. Событие `error` внутри async-генератора слишком
 * легко проглотить — достаточно не проверить один тип чанка, и запрос
 * «завершается успешно» пустым ответом.
 */

// ─── Вход ───────────────────────────────────────────────────────────────────

/**
 * Часть сообщения в том виде, в каком её видит провайдер: блобы уже
 * разрешены в байты вызывающим кодом. Провайдер не ходит в хранилище.
 */
export type ProviderPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; base64: string };

/**
 * Точек кэширования тут нет намеренно. Кэш промпта — это совпадение префикса
 * байт в байт, и управляется он не флагами, а порядком: стабильное впереди,
 * изменчивое в конце. За порядок отвечает ContextBuilder, а провайдеры ставят
 * отметку автоматически на последнем пригодном блоке.
 */
export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: ProviderPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ProviderToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tier: RiskTier;
  /**
   * Схему не грузить в контекст сразу — модель запросит её сама, когда
   * инструмент понадобится. Экономит токены на каждом запросе; провайдеры,
   * которые так не умеют, просто игнорируют флаг.
   */
  deferred?: boolean;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ChatRequest {
  model: string;
  messages: ProviderMessage[];
  tools?: ProviderToolSchema[];
  maxTokens?: number;
  /** Глубина рассуждений. Провайдеры без такого параметра игнорируют. */
  effort?: Effort;
  /** Показывать ли пользователю ход рассуждений. */
  thinking?: 'off' | 'summarized';
  signal?: AbortSignal;
}

// ─── Выход ──────────────────────────────────────────────────────────────────

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'cancelled';

/**
 * События потока. `tool_call` приходит уже собранным: провайдер сам копит
 * куски JSON-аргументов и отдаёт готовый вызов — вызывающий код не должен
 * знать, что у OpenAI аргументы приезжают по символу.
 */
export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: StopReason };

export interface ModelInfo {
  id: string;
  name?: string;
  contextTokens?: number;
  /** USD за миллион входных токенов. */
  inputPerMTok?: number;
  /** USD за миллион выходных токенов. */
  outputPerMTok?: number;
}

export interface Provider {
  readonly id: string;
  /** Умеет ли провайдер кэшировать промпт — от этого зависит сборка контекста. */
  readonly supportsPromptCache: boolean;
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
  listModels?(): Promise<ModelInfo[]>;
}

// ─── Ошибки ─────────────────────────────────────────────────────────────────

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_overflow'
  | 'model_not_found'
  | 'network'
  | 'upstream'
  | 'cancelled';

/**
 * Ошибка провайдера с машиночитаемым видом. Текст — человеку; решения
 * (повторить, попросить ключ, сжать контекст) принимаются по `kind`.
 */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { provider: string; status?: number; retryable?: boolean } = {
      provider: 'unknown',
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? (this.kind === 'rate_limit' || this.kind === 'network');
  }
}
