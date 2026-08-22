import Anthropic from '@anthropic-ai/sdk';
import type { ToolCall, Usage } from '@axon/protocol';
import { estimateCost } from './pricing.js';
import {
  ProviderError,
  type ChatEvent,
  type ChatRequest,
  type ModelInfo,
  type Provider,
  type ProviderMessage,
  type ProviderToolSchema,
  type StopReason,
} from './types.js';

/**
 * Тип параметров выводится из самого SDK, а не пишется по памяти: так правка
 * в новой версии SDK ломает сборку, а не приезжает 400-й в рантайме.
 */
type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0];

const PROVIDER_ID = 'anthropic';
const DEFAULT_MODEL = 'claude-opus-5';
/** Стримим, поэтому потолок можно ставить высокий — таймаутов HTTP тут нет. */
const DEFAULT_MAX_TOKENS = 64_000;
/** Серверный фолбэк при отказе классификаторов. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Провайдер Anthropic — основной в Axon, потому что у него самый выгодный
 * кэш промпта (чтение ~0.1 от цены ввода) и адаптивные рассуждения, которые
 * сами решают, когда думать глубоко, а когда ответить сразу.
 *
 * Включён серверный фолбэк (`fallbacks: 'default'`): классификаторы
 * безопасности иногда отклоняют вполне легальные запросы, и без фолбэка такой
 * запрос просто останавливается. С ним API переносит его на другую модель в
 * рамках того же вызова, а пользователь ничего не замечает.
 */
export class AnthropicProvider implements Provider {
  readonly id = PROVIDER_ID;
  readonly supportsPromptCache = true;

  private readonly client: Anthropic;

  constructor(options: { apiKey: string; baseUrl?: string }) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
  }

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const params = buildAnthropicRequest(request);

    try {
      const stream = this.client.beta.messages.stream(
        params,
        request.signal ? { signal: request.signal } : {},
      );

      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text };
        } else if (event.delta.type === 'thinking_delta') {
          yield { type: 'thinking', delta: event.delta.thinking };
        }
      }

      // Готовое сообщение вместо ручной сборки tool_use из кусков JSON:
      // SDK уже накопил и распарсил аргументы, и делает это правильнее.
      const final = await stream.finalMessage();

      for (const block of final.content) {
        if (block.type === 'tool_use') {
          yield {
            type: 'tool_call',
            call: {
              id: block.id,
              name: block.name,
              arguments: (block.input ?? {}) as Record<string, unknown>,
            } satisfies ToolCall,
          };
        }
      }

      yield { type: 'usage', usage: toUsage(final.usage, final.model) };
      yield { type: 'done', stopReason: toStopReason(final.stop_reason) };
    } catch (e) {
      throw toProviderError(e);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const models: ModelInfo[] = [];
      for await (const model of this.client.models.list()) {
        models.push({ id: model.id, name: model.display_name });
      }
      return models;
    } catch (e) {
      throw toProviderError(e);
    }
  }
}

// ─── Сборка запроса ─────────────────────────────────────────────────────────

/**
 * Чистая функция сборки параметров — вынесена отдельно, чтобы её можно было
 * проверить тестами без сети. Именно здесь живут все решения про кэш и тулы,
 * и ошибиться тут дороже всего.
 */
export function buildAnthropicRequest(request: ChatRequest): StreamParams {
  const system = request.messages
    .filter((m) => m.role === 'system')
    .flatMap((m) => m.parts)
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n');

  const tools = buildTools(request.tools ?? []);

  const params: StreamParams = {
    model: request.model || DEFAULT_MODEL,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: buildMessages(request.messages.filter((m) => m.role !== 'system')),
    // Автоматическая точка кэширования на последнем пригодном блоке. Для
    // диалога это ровно то, что нужно: каждый ход переиспользует весь
    // предыдущий префикс, а попадания накапливаются сами.
    cache_control: { type: 'ephemeral' },
    // На Opus 5 рассуждения включены по умолчанию; настраиваем только показ.
    thinking: {
      type: 'adaptive',
      display: request.thinking === 'off' ? 'omitted' : 'summarized',
    },
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
  };

  if (system) params.system = [{ type: 'text', text: system }];
  if (tools.length > 0) params.tools = tools;
  if (request.effort) params.output_config = { effort: request.effort };

  return params;
}

function buildMessages(messages: ProviderMessage[]): Anthropic.Beta.Messages.BetaMessageParam[] {
  const out: Anthropic.Beta.Messages.BetaMessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      const block: Anthropic.Beta.Messages.BetaToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: textOf(message),
      };
      // Результаты инструментов обязаны ехать одним user-сообщением. Разбить их
      // на несколько — значит приучить модель не вызывать инструменты пачкой.
      const last = out.at(-1);
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        if (part.text) content.push({ type: 'text', text: part.text });
      } else {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mime as Anthropic.Beta.Messages.BetaBase64ImageSource['media_type'],
            data: part.base64,
          },
        });
      }
    }
    for (const call of message.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }

    if (content.length === 0) continue;
    out.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content });
  }

  return out;
}

/**
 * Отложенные инструменты объявляются с `defer_loading`, а искать их модели
 * помогает серверный tool search. Это единственный способ не держать все схемы
 * в контексте, не ломая кэш промпта: тулы рендерятся в самом начале запроса,
 * поэтому подмена списка на лету обнуляет весь кэш, а дозагрузка — нет.
 */
function buildTools(tools: readonly ProviderToolSchema[]): Anthropic.Beta.Messages.BetaToolUnion[] {
  if (tools.length === 0) return [];

  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  // Хотя бы один инструмент должен грузиться сразу — иначе API вернёт 400.
  const allDeferred = sorted.every((t) => t.deferred);
  const useDeferred = !allDeferred && sorted.some((t) => t.deferred);

  const out: Anthropic.Beta.Messages.BetaToolUnion[] = sorted.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Beta.Messages.BetaTool['input_schema'],
    ...(useDeferred && tool.deferred ? { defer_loading: true } : {}),
  }));

  if (useDeferred) {
    out.unshift({ type: 'tool_search_tool_bm25_20251119', name: 'tool_search_tool_bm25' });
  }

  return out;
}

function textOf(message: ProviderMessage): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

// ─── Разбор ответа ──────────────────────────────────────────────────────────

export function toUsage(
  raw: Pick<
    Anthropic.Beta.Messages.BetaUsage,
    'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
  >,
  model: string,
): Usage {
  const usage = {
    provider: PROVIDER_ID,
    model,
    inputTokens: raw.input_tokens,
    cachedInputTokens: raw.cache_read_input_tokens ?? 0,
    cacheWriteTokens: raw.cache_creation_input_tokens ?? 0,
    outputTokens: raw.output_tokens,
  };
  const costUsd = estimateCost(usage);
  return costUsd === undefined ? usage : { ...usage, costUsd };
}

export function toStopReason(raw: string | null | undefined): StopReason {
  switch (raw) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;

  if (e instanceof Anthropic.APIError) {
    const base = { provider: PROVIDER_ID, status: e.status ?? 0 };
    if (e instanceof Anthropic.AuthenticationError) {
      return new ProviderError('auth', 'Неверный или отсутствующий API-ключ Anthropic', base);
    }
    if (e instanceof Anthropic.RateLimitError) {
      return new ProviderError('rate_limit', 'Превышен лимит запросов Anthropic', base);
    }
    if (e instanceof Anthropic.NotFoundError) {
      return new ProviderError('model_not_found', `Модель не найдена: ${e.message}`, base);
    }
    if (e instanceof Anthropic.BadRequestError && /context|too long|max_tokens/i.test(e.message)) {
      return new ProviderError('context_overflow', 'Контекст переполнен', base);
    }
    return new ProviderError('upstream', e.message, base);
  }

  const error = e as { name?: string; message?: string };
  if (error.name === 'AbortError') {
    return new ProviderError('cancelled', 'Запрос отменён', { provider: PROVIDER_ID });
  }
  return new ProviderError('network', error.message ?? 'Сетевая ошибка', {
    provider: PROVIDER_ID,
  });
}
