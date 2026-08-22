import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Scope } from '@axon/protocol';
import { logger } from '../src/logger.js';
import { openDatabase } from '../src/storage/db.js';
import { Store } from '../src/storage/Store.js';
import { createMemoryTools } from '../src/tools/builtin/memory.js';
import { PREVIEW_LIMIT, ToolExecutor, type PermissionDecider } from '../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import { defineTool, type ToolContext } from '../src/tools/types.js';

const ALL_SCOPES: Scope[] = ['tools.safe', 'tools.sensitive', 'tools.dangerous'];

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: 'c1',
    runId: 'r1',
    signal: new AbortController().signal,
    logger,
    requestPermission: async () => true,
    ...overrides,
  };
}

const echo = defineTool({
  name: 'echo',
  title: 'Эхо',
  description: 'Повторяет текст',
  tier: 'safe',
  source: 'builtin',
  schema: z.object({ text: z.string().min(1) }),
  async execute({ text }) {
    return { text };
  },
});

const wipe = defineTool({
  name: 'wipe',
  title: 'Стереть диск',
  description: 'Необратимо',
  tier: 'dangerous',
  source: 'builtin',
  schema: z.object({}),
  async execute() {
    return { text: 'стёрто' };
  },
});

describe('реестр инструментов', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.registerAll([wipe, echo]);
  });

  it('выдаёт инструменты в стабильном порядке независимо от порядка регистрации', () => {
    const other = new ToolRegistry();
    other.registerAll([echo, wipe]);

    const a = registry.select({ scopes: ALL_SCOPES }).map((t) => t.name);
    const b = other.select({ scopes: ALL_SCOPES }).map((t) => t.name);
    expect(a).toEqual(b);
    expect(a).toEqual(['echo', 'wipe']);
  });

  it('прячет инструменты, недоступные правам устройства', () => {
    const visible = registry.select({ scopes: ['tools.safe'] }).map((t) => t.name);
    expect(visible).toEqual(['echo']);
  });

  it('точечное разрешение открывает инструмент сверх прав', () => {
    const visible = registry.select({ scopes: ['tools.safe'], allow: ['wipe'] }).map((t) => t.name);
    expect(visible).toEqual(['echo', 'wipe']);
  });

  it('выключенный инструмент исчезает из выдачи модели, но остаётся в списке', () => {
    registry.setEnabled('echo', false);
    expect(registry.select({ scopes: ALL_SCOPES }).map((t) => t.name)).toEqual(['wipe']);
    expect(registry.list().map((t) => t.name)).toEqual(['echo', 'wipe']);
    expect(registry.list().find((t) => t.name === 'echo')!.enabled).toBe(false);
  });

  it('строит JSON Schema из zod-схемы без служебных полей', () => {
    const info = registry.list().find((t) => t.name === 'echo')!;
    expect(info.parameters['type']).toBe('object');
    expect(info.parameters['$schema']).toBeUndefined();
    expect((info.parameters['properties'] as Record<string, unknown>)['text']).toBeDefined();
  });

  it('не даёт зарегистрировать два инструмента с одним именем', () => {
    expect(() => registry.register(echo)).toThrow(/уже зарегистрирован/);
  });
});

describe('исполнитель инструментов', () => {
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.registerAll([echo, wipe]);
    executor = new ToolExecutor(registry);
  });

  it('выполняет безопасный инструмент без вопросов', async () => {
    const ask = vi.fn(async () => true);
    const result = await executor.execute({
      name: 'echo',
      args: { text: 'привет' },
      ctx: context({ requestPermission: ask }),
      access: { scopes: ALL_SCOPES },
    });

    expect(result.ok && result.preview).toBe('привет');
    expect(ask).not.toHaveBeenCalled();
  });

  it('спрашивает разрешение на опасный инструмент', async () => {
    const ask = vi.fn(async () => true);
    await executor.execute({
      name: 'wipe',
      args: {},
      ctx: context({ requestPermission: ask }),
      access: { scopes: ALL_SCOPES },
    });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('отказ пользователя останавливает вызов', async () => {
    const result = await executor.execute({
      name: 'wipe',
      args: {},
      ctx: context({ requestPermission: async () => false }),
      access: { scopes: ALL_SCOPES },
    });
    expect(result.ok).toBe(false);
  });

  it('перепроверяет права, даже если вызов пришёл из истории', async () => {
    const result = await executor.execute({
      name: 'wipe',
      args: {},
      ctx: context(),
      access: { scopes: ['tools.safe'] },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/недоступен/);
  });

  it('объясняет модели, что не так с аргументами', async () => {
    const result = await executor.execute({
      name: 'echo',
      args: { text: '' },
      ctx: context(),
      access: { scopes: ALL_SCOPES },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/text/);
  });

  it('неизвестный инструмент — ошибка, а не исключение', async () => {
    const result = await executor.execute({
      name: 'нет-такого',
      args: {},
      ctx: context(),
      access: { scopes: ALL_SCOPES },
    });
    expect(result.ok).toBe(false);
  });

  it('обрезает большой вывод и кладёт полный в блоб', async () => {
    const big = defineTool({
      name: 'big',
      title: 'Много',
      description: 'Возвращает простыню',
      tier: 'safe',
      source: 'builtin',
      schema: z.object({}),
      async execute() {
        return { text: 'x'.repeat(PREVIEW_LIMIT * 3) };
      },
    });
    registry.register(big);

    const write = vi.fn(async () => ({ blobId: 'blob-1', bytes: 100 }));
    const result = await executor.execute({
      name: 'big',
      args: {},
      ctx: context({ blobs: { write } }),
      access: { scopes: ALL_SCOPES },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.fullBlobId).toBe('blob-1');
    // В контекст модели уходит preview, а не всё полотно.
    expect(result.preview.length).toBeLessThan(PREVIEW_LIMIT + 100);
    expect(write).toHaveBeenCalledOnce();
  });

  it('без блоб-хранилища всё равно обрезает, а не отдаёт всё', async () => {
    const big = defineTool({
      name: 'big2',
      title: 'Много',
      description: '',
      tier: 'safe',
      source: 'builtin',
      schema: z.object({}),
      async execute() {
        return { text: 'y'.repeat(PREVIEW_LIMIT * 2) };
      },
    });
    registry.register(big);

    const result = await executor.execute({
      name: 'big2',
      args: {},
      ctx: context(),
      access: { scopes: ALL_SCOPES },
    });
    expect(result.ok && result.truncated).toBe(true);
    expect(result.ok && result.fullBlobId).toBeUndefined();
  });

  it('зависший инструмент останавливается по таймауту', async () => {
    const hang = defineTool({
      name: 'hang',
      title: 'Виснет',
      description: '',
      tier: 'safe',
      source: 'builtin',
      schema: z.object({}),
      async execute() {
        return await new Promise<never>(() => {});
      },
    });
    registry.register(hang);

    const result = await executor.execute({
      name: 'hang',
      args: {},
      ctx: context(),
      access: { scopes: ALL_SCOPES },
      timeoutMs: 20,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/лимит времени/);
  });

  it('отмена прогона прерывает вызов', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute({
      name: 'echo',
      args: { text: 'привет' },
      ctx: context({ signal: controller.signal }),
      access: { scopes: ALL_SCOPES },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/отмен/);
  });

  it('политика может разрешать без вопроса пользователю', async () => {
    const always: PermissionDecider = { decide: async () => 'allow' };
    const ask = vi.fn(async () => true);
    const result = await new ToolExecutor(registry, always).execute({
      name: 'wipe',
      args: {},
      ctx: context({ requestPermission: ask }),
      access: { scopes: ALL_SCOPES },
    });

    expect(result.ok).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('инструменты памяти', () => {
  let store: Store;
  let tmpDir: string;
  let registry: ToolRegistry;
  let executor: ToolExecutor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-tools-'));
    store = new Store({
      db: openDatabase({ databasePath: ':memory:' }),
      secretKeyPath: path.join(tmpDir, 'secret.key'),
    });
    registry = new ToolRegistry();
    registry.registerAll(createMemoryTools(store));
    executor = new ToolExecutor(registry);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('запоминает факт и он попадает в журнал', async () => {
    const result = await executor.execute({
      name: 'remember',
      args: { key: 'рабочий язык', value: 'русский' },
      ctx: context(),
      access: { scopes: ['tools.safe'] },
    });

    expect(result.ok).toBe(true);
    expect(store.facts.byKey('рабочий язык')?.value).toBe('русский');
    expect(store.pull(0, 10).entries.map((e) => e.event.type)).toContain('fact.upserted');
  });

  it('забывает факт', async () => {
    store.upsertFact('ключ', 'значение');
    await executor.execute({
      name: 'forget',
      args: { key: 'ключ' },
      ctx: context(),
      access: { scopes: ['tools.safe'] },
    });
    expect(store.facts.byKey('ключ')).toBeNull();
  });

  it('редкий recall объявлен отложенным — схема не висит в контексте', () => {
    const recall = registry.select({ scopes: ['tools.safe'] }).find((t) => t.name === 'recall');
    expect(recall?.deferred).toBe(true);
  });
});
