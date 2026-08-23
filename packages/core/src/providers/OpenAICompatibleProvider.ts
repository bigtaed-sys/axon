import type { ToolCall, Usage } from '@axon/protocol';
import { logger } from '../logger.js';
import { estimateCost } from './pricing.js';
import {
  ProviderError,
  type ChatEvent,
  type ChatRequest,
  type EmbedRequest,
  type ModelInfo,
  type Provider,
  type ProviderMessage,
  type StopReason,
} from './types.js';

export interface OpenAICompatibleConfig {
  /** Идентификатор провайдера: deepseek, openai, openrouter, lmstudio, ollama. */
  id: string;
  baseUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  /** Умеет ли сервер кэшировать промпт (DeepSeek и OpenAI — да, локальные — нет). */
  supportsPromptCache?: boolean;
}

/**
 * Провайдер для всего, что говорит на диалекте OpenAI: DeepSeek, OpenAI,
 * OpenRouter, LM Studio, Ollama.
 *
 * Портирован из старого проекта почти как есть — разбор SSE и склейка
 * потоковых аргументов инструментов там выстраданы и работают. Три правки:
 *
 * 1. Запрашивается `stream_options.include_usage` — старый код вообще не
 *    получал расход, из-за чего посчитать потраченное было нечем.
 * 2. Ошибки выбрасываются с машиночитаемым `kind` вместо готовых абзацев
 *    текста на русском: инструкции пользователю — дело интерфейса, а не
 *    сетевого слоя, и уж точно не должны быть одноязычными.
 * 3. Точки кэширования не выставляются: у OpenAI-совместимых серверов кэш
 *    автоматический по префиксу, размечать его нечем.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly supportsPromptCache: boolean;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.supportsPromptCache = config.supportsPromptCache ?? false;
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map(toOpenAIMessage),
      stream: true,
      // Без этого сервер не пришлёт usage в потоке, и расход остаётся неизвестен.
      stream_options: { include_usage: true },
    };
    if (request.maxTokens) body['max_tokens'] = request.maxTokens;
    if (request.tools?.length) {
      body['tools'] = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }

    const response = await this.post(url, body, request.signal);
    yield* this.readStream(response, request.model);
  }

  async listModels(): Promise<ModelInfo[]> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/models`;
    const response = await fetch(url, { method: 'GET', headers: this.headers() }).catch((e) => {
      throw new ProviderError('network', (e as Error).message, { provider: this.id });
    });
    if (!response.ok) throw await this.httpError(response);

    const json = (await response.json()) as { data?: RawModel[] };
    return (json.data ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.context_length ? { contextTokens: m.context_length } : {}),
        // У OpenRouter цена за токен — переводим в цену за миллион.
        ...(toNumber(m.pricing?.prompt) !== undefined
          ? { inputPerMTok: toNumber(m.pricing?.prompt)! * 1_000_000 }
          : {}),
        ...(toNumber(m.pricing?.completion) !== undefined
          ? { outputPerMTok: toNumber(m.pricing?.completion)! * 1_000_000 }
          : {}),
      }));
  }

  /**
   * Векторы для семантического поиска.
   *
   * Тот же адрес и тот же ключ, что у чата: `/v1/embeddings` — часть того же
   * OpenAI-совместимого протокола. Отдельного транспорта заводить не нужно, и
   * Ollama с LM Studio отвечают по нему наравне с облачными.
   *
   * Пачкой, а не по одному: почти вся стоимость такого запроса — накладные
   * расходы на соединение, и сотня текстов идёт примерно столько же, сколько
   * один.
   */
  async embed(request: EmbedRequest): Promise<number[][]> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const response = await this.post(
      url,
      { model: request.model, input: request.texts },
      request.signal,
    );

    const body = (await response.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };
    const rows = body.data ?? [];

    if (rows.length !== request.texts.length) {
      throw new ProviderError(
        'upstream',
        `Провайдер вернул ${rows.length} векторов на ${request.texts.length} текстов`,
        { provider: this.id },
      );
    }

    // Порядок в ответе не гарантирован — раскладываем по указанному индексу.
    const out: number[][] = new Array(rows.length);
    for (const row of rows) out[row.index] = row.embedding;
    return out;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.config.extraHeaders ?? {}),
    };
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private async post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      const error = e as { name?: string; message?: string };
      if (error.name === 'AbortError') {
        throw new ProviderError('cancelled', 'Запрос отменён', { provider: this.id });
      }
      throw new ProviderError('network', error.message ?? 'Сетевая ошибка', {
        provider: this.id,
      });
    }
    if (!response.ok || !response.body) throw await this.httpError(response);
    return response;
  }

  private async httpError(response: Response): Promise<ProviderError> {
    const text = await response.text().catch(() => '');
    const base = { provider: this.id, status: response.status };
    switch (response.status) {
      case 401:
      case 403:
        return new ProviderError('auth', `Отказано в доступе: ${text.slice(0, 200)}`, base);
      case 404:
        return new ProviderError('model_not_found', `Не найдено: ${text.slice(0, 200)}`, base);
      case 429:
        return new ProviderError('rate_limit', 'Превышен лимит запросов', {
          ...base,
          ...(retryAfter(response) === null ? {} : { retryAfterMs: retryAfter(response)! }),
        });
      default:
        return new ProviderError('upstream', `HTTP ${response.status}: ${text.slice(0, 300)}`, base);
    }
  }

  private async *readStream(response: Response, model: string): AsyncIterable<ChatEvent> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    /** index → накопленный вызов: аргументы приезжают по кусочку JSON. */
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;
    let usage: Usage | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          let chunk: StreamChunk;
          try {
            chunk = JSON.parse(data) as StreamChunk;
          } catch {
            logger.warn({ data: data.slice(0, 200) }, 'не разобрался кусок потока');
            continue;
          }

          // LM Studio и llama.cpp кладут ошибку прямо в SSE вместо HTTP-кода.
          // Без этой ветки пользователь видит пустой ответ вместо причины.
          if (chunk.error) {
            const message =
              typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'ошибка');
            throw new ProviderError(classifyStreamError(message), message, {
              provider: this.id,
            });
          }

          if (chunk.usage) usage = this.toUsage(chunk.usage, model);

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta ?? {};
          if (delta.content) yield { type: 'text', delta: delta.content };
          if (delta.reasoning_content) {
            yield { type: 'thinking', delta: delta.reasoning_content };
          }

          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? 0;
            const acc = pending.get(index) ?? { id: '', name: '', args: '' };
            if (call.id) acc.id = call.id;
            if (call.function?.name) acc.name = call.function.name;
            if (call.function?.arguments) acc.args += call.function.arguments;
            pending.set(index, acc);
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
    } finally {
      reader.releaseLock();
    }

    for (const acc of pending.values()) {
      yield { type: 'tool_call', call: parseCall(acc) };
    }
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason: toStopReason(finishReason, pending.size > 0) };
  }

  private toUsage(raw: RawUsage, model: string): Usage {
    // Кэш называется по-разному: DeepSeek отдаёт prompt_cache_hit_tokens,
    // OpenAI прячет его в prompt_tokens_details.cached_tokens.
    const cached = raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = {
      provider: this.id,
      model,
      // prompt_tokens включает кэш — вычитаем, чтобы поля не пересекались.
      inputTokens: Math.max(0, (raw.prompt_tokens ?? 0) - cached),
      cachedInputTokens: cached,
      // Явной записи в кэш эти API не показывают: она внутри промахов.
      cacheWriteTokens: 0,
      outputTokens: raw.completion_tokens ?? 0,
    };
    const costUsd = estimateCost(usage);
    return costUsd === undefined ? usage : { ...usage, costUsd };
  }
}

// ─── Преобразования ─────────────────────────────────────────────────────────

function toOpenAIMessage(message: ProviderMessage): Record<string, unknown> {
  const text = message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const images = message.parts.filter(
    (p): p is { type: 'image'; mime: string; base64: string } => p.type === 'image',
  );

  const out: Record<string, unknown> = { role: message.role };

  if (images.length > 0 && (message.role === 'user' || message.role === 'assistant')) {
    out['content'] = [
      { type: 'text', text },
      ...images.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.base64}` },
      })),
    ];
  } else {
    out['content'] = text;
  }

  if (message.toolCalls?.length) {
    out['tool_calls'] = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }));
  }
  if (message.toolCallId) out['tool_call_id'] = message.toolCallId;

  return out;
}

function parseCall(acc: { id: string; name: string; args: string }): ToolCall {
  let args: Record<string, unknown> = {};
  if (acc.args.trim()) {
    try {
      args = JSON.parse(acc.args) as Record<string, unknown>;
    } catch {
      // Малые модели регулярно шлют невалидный JSON. Вызов всё равно отдаём:
      // исполнитель отклонит его по схеме и вернёт модели внятную ошибку —
      // это лучше, чем молча потерять вызов и оставить её ждать результата.
      logger.warn({ tool: acc.name, args: acc.args.slice(0, 200) }, 'аргументы не распарсились');
    }
  }
  return { id: acc.id || `call_${acc.name}`, name: acc.name, arguments: args };
}

function toStopReason(raw: string | undefined, hadToolCalls: boolean): StopReason {
  if (hadToolCalls || raw === 'tool_calls') return 'tool_use';
  if (raw === 'length') return 'max_tokens';
  if (raw === 'content_filter') return 'refusal';
  return 'end_turn';
}

function classifyStreamError(message: string): 'context_overflow' | 'upstream' {
  return /context|n_keep|too long|exceeds/i.test(message) ? 'context_overflow' : 'upstream';
}

function toNumber(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Формы ответа сервера ───────────────────────────────────────────────────

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface RawModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string | number; completion?: string | number };
}

interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      /** DeepSeek reasoner отдаёт ход рассуждений отдельным полем. */
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: RawUsage;
  error?: { message?: string } | string;
}

/**
 * Сколько провайдер просит подождать перед следующей попыткой.
 *
 * `Retry-After` бывает в двух видах: секунды числом или дата по HTTP. Второй
 * встречается реже, но встречается, и разобрать надо оба — иначе повтор уйдёт
 * раньше срока и получит такой же отказ.
 */
export function retryAfter(response: { headers: Headers }): number | null {
  const raw = response.headers.get('retry-after');
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
