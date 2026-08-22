import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAnthropicRequest,
  cacheHitRatio,
  estimateCost,
  OpenAICompatibleProvider,
  ProviderError,
  ProviderRegistry,
  toStopReason,
  type ChatEvent,
  type ChatRequest,
} from '../src/providers/index.js';
import { openDatabase } from '../src/storage/db.js';
import { Store } from '../src/storage/Store.js';

const text = (t: string) => [{ type: 'text' as const, text: t }];

describe('сборка запроса к Anthropic', () => {
  const base: ChatRequest = {
    model: 'claude-opus-5',
    messages: [
      { role: 'system', parts: text('ты ассистент') },
      { role: 'user', parts: text('привет') },
    ],
  };

  it('выносит system отдельным полем, а не сообщением', () => {
    const params = buildAnthropicRequest(base);
    expect(params.system).toEqual([{ type: 'text', text: 'ты ассистент' }]);
    expect(params.messages).toHaveLength(1);
    expect(params.messages[0]!.role).toBe('user');
  });

  it('всегда ставит точку кэширования и серверный фолбэк', () => {
    const params = buildAnthropicRequest(base);
    expect(params.cache_control).toEqual({ type: 'ephemeral' });
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toContain('server-side-fallback-2026-07-01');
  });

  it('склеивает подряд идущие результаты инструментов в одно сообщение', () => {
    const params = buildAnthropicRequest({
      ...base,
      messages: [
        { role: 'user', parts: text('посчитай') },
        {
          role: 'assistant',
          parts: text(''),
          toolCalls: [
            { id: 'a', name: 'add', arguments: {} },
            { id: 'b', name: 'mul', arguments: {} },
          ],
        },
        { role: 'tool', parts: text('2'), toolCallId: 'a' },
        { role: 'tool', parts: text('6'), toolCallId: 'b' },
      ],
    });

    const last = params.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(Array.isArray(last.content) && last.content).toHaveLength(2);
  });

  it('сортирует инструменты по имени — иначе рассыпается кэш промпта', () => {
    const params = buildAnthropicRequest({
      ...base,
      tools: [
        { name: 'zeta', description: '', parameters: {}, tier: 'safe' },
        { name: 'alpha', description: '', parameters: {}, tier: 'safe' },
      ],
    });
    expect(params.tools?.map((t) => ('name' in t ? t.name : ''))).toEqual(['alpha', 'zeta']);
  });

  it('редкие инструменты помечает отложенными и добавляет tool search', () => {
    const params = buildAnthropicRequest({
      ...base,
      tools: [
        { name: 'often', description: '', parameters: {}, tier: 'safe' },
        { name: 'rare', description: '', parameters: {}, tier: 'safe', deferred: true },
      ],
    });

    const names = params.tools!.map((t) => ('name' in t ? t.name : ''));
    expect(names[0]).toBe('tool_search_tool_bm25');
    const rare = params.tools!.find((t) => 'name' in t && t.name === 'rare');
    expect(rare && 'defer_loading' in rare && rare.defer_loading).toBe(true);
  });

  it('не откладывает всё сразу — иначе API вернёт 400', () => {
    const params = buildAnthropicRequest({
      ...base,
      tools: [{ name: 'only', description: '', parameters: {}, tier: 'safe', deferred: true }],
    });

    expect(params.tools).toHaveLength(1);
    const tool = params.tools![0]!;
    expect('defer_loading' in tool).toBe(false);
  });

  it('переводит причины остановки в свои', () => {
    expect(toStopReason('tool_use')).toBe('tool_use');
    expect(toStopReason('refusal')).toBe('refusal');
    expect(toStopReason('stop_sequence')).toBe('end_turn');
  });
});

describe('расход и стоимость', () => {
  it('считает кэш дешевле обычного ввода', () => {
    const cold = estimateCost({
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 100_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    })!;
    const warm = estimateCost({
      provider: 'anthropic',
      model: 'claude-opus-5',
      inputTokens: 0,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 0,
      outputTokens: 0,
    })!;

    expect(warm).toBeCloseTo(cold * 0.1, 6);
  });

  it('не выдумывает цену для неизвестной модели', () => {
    expect(
      estimateCost({
        provider: 'anthropic',
        model: 'какая-то-новая',
        inputTokens: 1000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 100,
      }),
    ).toBeUndefined();
  });

  it('локальные модели бесплатны', () => {
    expect(
      estimateCost({
        provider: 'ollama',
        model: 'llama3.1',
        inputTokens: 10_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5_000,
      }),
    ).toBe(0);
  });

  it('доля кэша показывает, работает ли он', () => {
    expect(cacheHitRatio({ inputTokens: 200, cachedInputTokens: 800 })).toBeCloseTo(0.8);
    expect(cacheHitRatio({ inputTokens: 0, cachedInputTokens: 0 })).toBe(0);
  });
});

describe('реестр провайдеров', () => {
  let store: Store;
  let tmpDir: string;
  let registry: ProviderRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-prov-'));
    store = new Store({
      db: openDatabase({ databasePath: ':memory:' }),
      secretKeyPath: path.join(tmpDir, 'secret.key'),
    });
    registry = new ProviderRegistry(store.settings, store.secrets);
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('пустая настройка модели — это «не задано», а не модель без имени', () => {
    store.updateSettings({
      values: { 'provider.active': 'ollama', 'provider.ollama.model': '   ' },
    });
    expect(registry.current().model).toBe('llama3.1');
  });

  it('заданная модель побеждает умолчание', () => {
    store.updateSettings({
      values: { 'provider.active': 'ollama', 'provider.ollama.model': 'qwen2.5' },
    });
    expect(registry.current().model).toBe('qwen2.5');
  });

  it('пустой адрес не затирает адрес по умолчанию', () => {
    store.updateSettings({
      values: { 'provider.active': 'deepseek', 'provider.deepseek.baseUrl': '' },
    });
    store.updateSettings({ secrets: { 'provider.deepseek.apiKey': 'sk-test' } });
    expect(() => registry.current()).not.toThrow();
  });

  it('без ключа к платному провайдеру не пускает с внятной причиной', () => {
    store.updateSettings({ values: { 'provider.active': 'deepseek' } });
    const error = (() => {
      try {
        registry.current();
        return null;
      } catch (e) {
        return e as ProviderError;
      }
    })();

    expect(error?.kind).toBe('auth');
  });
});

describe('OpenAI-совместимый провайдер', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sse = (lines: string[]): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      }),
      { status: 200 },
    );

  const collect = async (provider: OpenAICompatibleProvider): Promise<ChatEvent[]> => {
    const events: ChatEvent[] = [];
    for await (const event of provider.chat({
      model: 'deepseek-chat',
      messages: [{ role: 'user', parts: text('привет') }],
    })) {
      events.push(event);
    }
    return events;
  };

  const provider = (): OpenAICompatibleProvider =>
    new OpenAICompatibleProvider({
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
    });

  it('склеивает текст и снимает расход с учётом кэша', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          JSON.stringify({ choices: [{ delta: { content: 'при' } }] }),
          JSON.stringify({ choices: [{ delta: { content: 'вет' } }, { finish_reason: 'stop' }] }),
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 50,
              prompt_cache_hit_tokens: 900,
            },
          }),
        ]),
      ),
    );

    const events = await collect(provider());
    const deltas = events.filter((e) => e.type === 'text').map((e) => e.delta);
    expect(deltas.join('')).toBe('привет');

    const usage = events.find((e) => e.type === 'usage')!.usage;
    // prompt_tokens включает кэш — в отчёте поля не должны пересекаться.
    expect(usage.cachedInputTokens).toBe(900);
    expect(usage.inputTokens).toBe(100);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it('собирает вызов инструмента из кусочков JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'call_1', function: { name: 'remember' } }],
                },
              },
            ],
          }),
          JSON.stringify({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: '{"key":"я' } }] } },
            ],
          }),
          JSON.stringify({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: 'зык","value":"ru"}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          }),
        ]),
      ),
    );

    const events = await collect(provider());
    const call = events.find((e) => e.type === 'tool_call')!.call;
    expect(call).toEqual({
      id: 'call_1',
      name: 'remember',
      arguments: { key: 'язык', value: 'ru' },
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('превращает ошибку внутри потока в типизированное исключение', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([JSON.stringify({ error: { message: 'context length exceeded' } })]),
      ),
    );

    await expect(collect(provider())).rejects.toMatchObject({
      name: 'ProviderError',
      kind: 'context_overflow',
    });
  });

  it('классифицирует HTTP-ошибки, а не отдаёт голый текст', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no key', { status: 401 })));

    const error = await collect(provider()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('auth');
    expect((error as ProviderError).retryable).toBe(false);
  });

  it('лимит запросов помечает как повторяемый', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
    const error = (await collect(provider()).catch((e: unknown) => e)) as ProviderError;
    expect(error.kind).toBe('rate_limit');
    expect(error.retryable).toBe(true);
  });
});
