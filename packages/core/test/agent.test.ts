import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JournalEntry, PermissionDecision, Signal, Usage } from '@axon/protocol';
import { ContextBuilder } from '../src/agent/ContextBuilder.js';
import { Orchestrator, MAX_ITERATIONS } from '../src/agent/Orchestrator.js';
import { StoredPermissions, type PermissionBroker } from '../src/agent/permissions.js';
import { estimateTokens, TokenBudget } from '../src/agent/tokens.js';
import type { ProviderRegistry } from '../src/providers/ProviderRegistry.js';
import type { ChatEvent, ChatRequest, Provider } from '../src/providers/types.js';
import { openDatabase } from '../src/storage/db.js';
import { Store } from '../src/storage/Store.js';
import { ToolExecutor } from '../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { defineTool } from '../src/tools/types.js';

// ─── Подпорки ───────────────────────────────────────────────────────────────

class ScriptedProvider implements Provider {
  readonly id = 'test';
  readonly supportsPromptCache = true;
  readonly requests: ChatRequest[] = [];

  constructor(private readonly script: ChatEvent[][]) {}

  async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(request);
    const events = this.script.shift() ?? [
      { type: 'text', delta: 'по умолчанию' },
      { type: 'done', stopReason: 'end_turn' },
    ];
    for (const event of events) yield event;
  }
}

const usage = (input: number, output: number): Usage => ({
  provider: 'test',
  model: 'test-model',
  inputTokens: input,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: output,
  costUsd: 0.01,
});

function registryFor(provider: Provider): ProviderRegistry {
  return {
    current: () => ({
      provider,
      model: 'test-model',
      descriptor: { id: 'test' },
    }),
    resolve: () => ({ provider, model: 'test-model', descriptor: { id: 'test' } }),
  } as unknown as ProviderRegistry;
}

/** Дожидается терминального события прогона — startRun возвращает управление сразу. */
function waitForRun(store: Store, runId: string): Promise<JournalEntry> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('прогон не завершился за 3 с'));
    }, 3000);

    const unsubscribe = store.journal.subscribe((entry) => {
      const event = entry.event;
      if (
        (event.type === 'run.finished' || event.type === 'run.failed') &&
        event.runId === runId
      ) {
        clearTimeout(timer);
        unsubscribe();
        resolve(entry);
      }
    });
  });
}

// ─── Оценка и бюджет ────────────────────────────────────────────────────────

describe('оценка токенов', () => {
  it('считает кириллицу плотнее латиницы', () => {
    const ru = estimateTokens('привет как дела друг');
    const en = estimateTokens('hello how are you ok');
    expect(ru).toBeGreaterThan(en);
  });

  it('пустая строка — ноль', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('бюджет', () => {
  it('без потолка не исчерпывается', () => {
    const budget = new TokenBudget(null);
    budget.spend(1_000_000);
    expect(budget.exhausted).toBe(false);
    expect(budget.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it('исчерпывается ровно на потолке', () => {
    const budget = new TokenBudget(100);
    budget.spend(99);
    expect(budget.exhausted).toBe(false);
    budget.spend(1);
    expect(budget.exhausted).toBe(true);
    expect(budget.remaining).toBe(0);
  });
});

// ─── Сборка контекста ───────────────────────────────────────────────────────

describe('сборщик контекста', () => {
  let store: Store;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-ctx-'));
    store = new Store({
      db: openDatabase({ databasePath: ':memory:' }),
      secretKeyPath: path.join(tmpDir, 'secret.key'),
    });
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('стабильный вклад уходит в системный блок, изменчивый — в самый конец', async () => {
    const builder = new ContextBuilder(store);
    builder.addContributor({
      name: 'умный-дом',
      stability: 'stable',
      contribute: () => 'Подключён умный дом.',
    });
    builder.addContributor({
      name: 'время',
      stability: 'volatile',
      contribute: () => 'Сейчас 12:00.',
    });

    const conversation = store.createConversation();
    store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'привет' }],
    });

    const { messages } = await builder.build({
      conversationId: conversation.id,
      userText: 'привет',
    });

    const system = messages[0]!;
    expect(system.role).toBe('system');
    expect(system.parts[0]).toMatchObject({ text: expect.stringContaining('умный дом') });
    // Изменчивое — после всей истории, иначе оно ломало бы кэш префикса.
    expect(system.parts[0]).not.toMatchObject({ text: expect.stringContaining('12:00') });
    expect(JSON.stringify(messages.at(-1))).toContain('12:00');
  });

  it('подставляет факты и сводку в системный блок', async () => {
    const conversation = store.createConversation();
    store.upsertFact('город', 'Варшава');
    store.transact(() =>
      store.summaries.insert({
        id: 'sum-1',
        conversationId: conversation.id,
        upToOrd: 0,
        text: 'Обсуждали переезд.',
        tokens: 10,
        createdAt: new Date().toISOString(),
      }),
    );

    const { messages } = await new ContextBuilder(store).build({
      conversationId: conversation.id,
      userText: 'дальше',
    });

    const system = JSON.stringify(messages[0]);
    expect(system).toContain('Варшава');
    expect(system).toContain('Обсуждали переезд');
  });

  it('после сводки берёт только сообщения новее неё', async () => {
    const conversation = store.createConversation();
    const first = store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'старое' }],
    });
    store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'новое' }],
    });

    store.transact(() =>
      store.summaries.insert({
        id: 'sum-2',
        conversationId: conversation.id,
        upToOrd: store.messages.ordOf(first.id)!,
        text: 'сводка',
        tokens: 5,
        createdAt: new Date().toISOString(),
      }),
    );

    const { messages } = await new ContextBuilder(store).build({
      conversationId: conversation.id,
      userText: 'новое',
    });

    const body = JSON.stringify(messages.slice(1));
    expect(body).toContain('новое');
    expect(body).not.toContain('старое');
  });
});

// ─── Оркестратор ────────────────────────────────────────────────────────────

describe('оркестратор', () => {
  let store: Store;
  let tmpDir: string;
  let tools: ToolRegistry;
  let signals: Signal[];

  const echo = defineTool({
    name: 'echo',
    title: 'Эхо',
    description: 'Повторяет',
    tier: 'safe',
    source: 'builtin',
    schema: z.object({ text: z.string() }),
    async execute({ text }) {
      return { text: `эхо: ${text}` };
    },
  });

  const wipe = defineTool({
    name: 'wipe',
    title: 'Стереть',
    description: 'Необратимо',
    tier: 'dangerous',
    source: 'builtin',
    schema: z.object({}),
    async execute() {
      return { text: 'стёрто' };
    },
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-run-'));
    store = new Store({
      db: openDatabase({ databasePath: ':memory:' }),
      secretKeyPath: path.join(tmpDir, 'secret.key'),
    });
    tools = new ToolRegistry();
    tools.registerAll([echo, wipe]);
    signals = [];
  });

  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function build(
    provider: Provider,
    options: { broker?: PermissionBroker } = {},
  ): Orchestrator {
    return new Orchestrator({
      store,
      context: new ContextBuilder(store),
      providers: registryFor(provider),
      tools,
      executor: new ToolExecutor(tools, new StoredPermissions(store)),
      sink: { emit: (signal) => signals.push(signal) },
      ...(options.broker ? { permissions: options.broker } : {}),
    });
  }

  const start = (orchestrator: Orchestrator, text = 'привет') =>
    orchestrator.startRun({
      conversationId: store.createConversation().id,
      parts: [{ type: 'text', text }],
      scopes: ['chat.write', 'tools.safe', 'tools.dangerous'],
    });

  it('простой ответ: сообщение в журнале, дельты в сигналах', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'при' },
        { type: 'text', delta: 'вет' },
        { type: 'usage', usage: usage(100, 20) },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const orchestrator = build(provider);
    const { runId } = start(orchestrator);
    const finished = await waitForRun(store, runId);

    expect(finished.event.type).toBe('run.finished');
    expect(finished.event).toMatchObject({ stopReason: 'end_turn', iterations: 1 });

    const deltas = signals.filter((s) => s.type === 'run.delta').map((s) => s.text);
    expect(deltas.join('')).toBe('привет');

    const types = store.pull(0, 50).entries.map((e) => e.event.type);
    expect(types).toEqual([
      'conversation.created',
      'message.created',
      'run.started',
      'message.created',
      'run.finished',
    ]);
  });

  it('расход попадает и в сигналы, и в лог расхода', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'text', delta: 'ок' },
        { type: 'usage', usage: usage(1000, 200) },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const { runId } = start(build(provider));
    await waitForRun(store, runId);

    expect(signals.some((s) => s.type === 'usage.tick')).toBe(true);
    expect(store.usage.totals('1970-01-01T00:00:00.000Z').inputTokens).toBe(1000);
  });

  it('прогоняет цикл модель → инструмент → модель', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { text: 'раз' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'готово' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);
    const { runId } = start(build(provider));
    const finished = await waitForRun(store, runId);

    expect(finished.event).toMatchObject({ iterations: 2 });

    const types = store.pull(0, 50).entries.map((e) => e.event.type);
    expect(types).toContain('tool_call.started');
    expect(types).toContain('tool_call.finished');

    // Результат инструмента поехал во второй запрос к модели.
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('эхо: раз');
  });

  it('останавливается по бюджету до вызова модели, а не после', async () => {
    const provider = new ScriptedProvider([]);
    const orchestrator = build(provider);
    const { runId } = orchestrator.startRun({
      conversationId: store.createConversation().id,
      parts: [{ type: 'text', text: 'длинный запрос про всё на свете' }],
      scopes: ['chat.write', 'tools.safe'],
      budgetTokens: 1,
    });

    const finished = await waitForRun(store, runId);
    expect(finished.event).toMatchObject({ stopReason: 'budget_exhausted' });
    // Ни одного обращения к модели: гейт сработал раньше.
    expect(provider.requests).toHaveLength(0);
  });

  it('спрашивает разрешение на опасный инструмент и запоминает «всегда»', async () => {
    const decisions: PermissionDecision[] = ['allow_always'];
    const broker: PermissionBroker = {
      request: vi.fn(async () => decisions.shift() ?? 'deny_once'),
    };

    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'wipe', arguments: {} } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'сделано' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);

    const { runId } = start(build(provider, { broker }));
    await waitForRun(store, runId);

    expect(broker.request).toHaveBeenCalledOnce();
    expect(store.permissionRules.get('wipe')).toBe('allow');

    const types = store.pull(0, 50).entries.map((e) => e.event.type);
    expect(types).toContain('permission.requested');
    expect(types).toContain('permission.resolved');
  });

  it('отказ пользователя не выполняет инструмент, но прогон продолжается', async () => {
    const broker: PermissionBroker = { request: async () => 'deny_once' };
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'wipe', arguments: {} } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'понял, не трогаю' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);

    const { runId } = start(build(provider, { broker }));
    const finished = await waitForRun(store, runId);

    expect(finished.event).toMatchObject({ stopReason: 'end_turn' });
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('отклонил');
  });

  it('без брокера опасный инструмент не выполняется', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'wipe', arguments: {} } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text', delta: 'ладно' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);

    const { runId } = start(build(provider));
    await waitForRun(store, runId);
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('отклонил');
  });

  it('подталкивает модель, если она замолчала после инструмента', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { text: 'раз' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Пустой ответ — классическое поведение малых моделей после tool-результата.
      [{ type: 'done', stopReason: 'end_turn' }],
      [
        { type: 'text', delta: 'вот ответ' },
        { type: 'done', stopReason: 'end_turn' },
      ],
    ]);

    const { runId } = start(build(provider));
    await waitForRun(store, runId);

    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[2]!.messages)).toContain('Сформулируй ответ');

    const messages = store.messages.recent(
      store.conversations.list(10)[0]!.id,
      10,
    );
    expect(JSON.stringify(messages.at(-1))).toContain('вот ответ');
  });

  it('упирается в потолок итераций, а не крутится вечно', async () => {
    const loop: ChatEvent[][] = Array.from({ length: MAX_ITERATIONS + 2 }, () => [
      { type: 'tool_call' as const, call: { id: 'c', name: 'echo', arguments: { text: 'ещё' } } },
      { type: 'done' as const, stopReason: 'tool_use' as const },
    ]);

    const { runId } = start(build(new ScriptedProvider(loop)));
    const finished = await waitForRun(store, runId);

    expect(finished.event).toMatchObject({
      stopReason: 'max_iterations',
      iterations: MAX_ITERATIONS,
    });
  });

  it('отмена прекращает прогон', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'echo', arguments: { text: 'раз' } } },
        { type: 'done', stopReason: 'tool_use' },
      ],
    ]);
    const orchestrator = build(provider);
    const { runId } = start(orchestrator);

    // Отменяем сразу — до второго обращения к модели.
    orchestrator.cancel(runId);
    const finished = await waitForRun(store, runId);

    expect(finished.event).toMatchObject({ stopReason: 'cancelled' });
    expect(orchestrator.isRunning(runId)).toBe(false);
  });

  it('падение провайдера превращается в run.failed, а не в тихую смерть', async () => {
    const broken: Provider = {
      id: 'broken',
      supportsPromptCache: false,
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('провайдер лёг');
      },
    };

    const { runId } = start(build(broken));
    const finished = await waitForRun(store, runId);

    expect(finished.event.type).toBe('run.failed');
    expect(finished.event).toMatchObject({ error: 'провайдер лёг' });
  });
});
