import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import { Daemon } from '@axon-assistant/core';
import { defineTool } from '@axon/core';
import { AxonClient, AxonError, pairDevice, type SocketFactory } from '../src/index.js';

/**
 * Тесты идут против настоящего демона: подменена только модель. Клиент,
 * протокол, журнал и курсоры проверяются целиком — ради этого SDK и писался.
 */

const socketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as ReturnType<SocketFactory>;

let daemon: Daemon;
let tmpDir: string;
let model: http.Server;
let token: string;
let client: AxonClient;

/** Ответы модели по очереди: каждый запрос забирает следующий сценарий. */
let script: Array<Array<Record<string, unknown>>>;

function startModel(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunks = script.shift() ?? [
        { choices: [{ delta: { content: 'ответ' } }, { finish_reason: 'stop' }] },
      ];
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        // Пауза, чтобы промежуточное состояние прогона было наблюдаемым:
        // без неё ответ приходит целиком быстрее, чем тест успевает взглянуть.
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1` });
    });
  });
}

/** Ждать условия на состоянии клиента — состояние меняется асинхронно. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('условие не наступило');
}

beforeEach(async () => {
  script = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-sdk-'));
  const started = await startModel();
  model = started.server;

  daemon = new Daemon({ config: { dataDir: tmpDir }, port: 0 });
  const { bootstrapCode } = await daemon.start();

  daemon.runtime.store.updateSettings({
    values: { 'provider.active': 'ollama', 'provider.ollama.baseUrl': started.url },
  });

  const paired = await pairDevice({
    url: daemon.url,
    code: bootstrapCode!,
    name: 'Тестовый клиент',
  });
  token = paired.token;

  client = new AxonClient({ url: daemon.url, token, socketFactory, reconnect: false });
});

afterEach(async () => {
  client.close();
  await daemon.stop();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Подключение ────────────────────────────────────────────────────────────

describe('подключение', () => {
  it('после connect состояние собрано снапшотом', async () => {
    const core = await client.connect();

    expect(core.coreId).toBe(daemon.runtime.coreId);
    expect(client.connectionStatus).toBe('ready');
    expect([...client.state.tools.keys()]).toContain('remember');
    expect(client.state.devices.size).toBe(1);
    expect(client.state.cursor).toBeGreaterThan(0);
  });

  it('статусы идут по порядку', async () => {
    const seen: string[] = [];
    client.onStatus((status) => seen.push(status));
    await client.connect();
    expect(seen).toEqual(['connecting', 'syncing', 'ready']);
  });

  it('ошибка команды приезжает типизированной', async () => {
    await client.connect();
    const failure = await client
      .call('conversation.rename', { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', title: 'нет' })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AxonError);
    expect((failure as AxonError).code).toBe('not_found');
  });
});

// ─── Синхронизация ──────────────────────────────────────────────────────────

describe('синхронизация', () => {
  it('живое событие применяется к состоянию', async () => {
    await client.connect();
    const before = client.state.conversations.size;

    // Меняем состояние в обход клиента — как это сделало бы другое устройство.
    daemon.runtime.store.createConversation('Со стороны');

    await until(() => client.state.conversations.size === before + 1);
    expect(client.state.conversationList()[0]!.title).toBe('Со стороны');
  });

  it('после переподключения догоняет пропущенное по курсору', async () => {
    await client.connect();
    const cursorBefore = client.state.cursor;

    client.close();
    daemon.runtime.store.createConversation('Пока никого не было');
    daemon.runtime.store.upsertFact('город', 'Варшава');

    await client.connect();

    expect(client.state.cursor).toBeGreaterThan(cursorBefore);
    expect(client.state.conversationList().some((c) => c.title === 'Пока никого не было')).toBe(true);
    expect([...client.state.facts.values()].some((f) => f.value === 'Варшава')).toBe(true);
  });

  it('чужое ядро сбрасывает состояние, а не смешивается с ним', async () => {
    await client.connect();
    client.close();

    // Курсор из прошлой жизни указывает в чужой журнал.
    client.state.coreId = 'ффффффф-0000-4000-8000-000000000000';
    client.state.conversations.set('мусор', {
      id: 'мусор',
      title: 'из другого ядра',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archived: false,
      totalTokens: 0,
    });

    await client.connect();

    expect(client.state.conversations.has('мусор')).toBe(false);
    expect(client.state.coreId).toBe(daemon.runtime.coreId);
  });

  it('одно событие не применяется дважды', async () => {
    await client.connect();
    const conversation = daemon.runtime.store.createConversation('Один раз');
    await until(() => client.state.conversations.has(conversation.id));

    const cursor = client.state.cursor;
    // Повторная синхронизация не должна ничего сдвинуть или задублировать.
    await client.call('sync.pull', { since: 0 });
    expect(client.state.cursor).toBe(cursor);
    expect(client.state.conversationList().filter((c) => c.title === 'Один раз')).toHaveLength(1);
  });
});

// ─── Разговор ───────────────────────────────────────────────────────────────

describe('разговор', () => {
  it('стрим копится в состоянии и исчезает после ответа', async () => {
    await client.connect();
    script = [[{ choices: [{ delta: { content: 'привет-привет' } }] }]];

    const { conversation } = await client.call('conversation.create', { title: 'Чат' });
    const { runId } = await client.call('message.send', {
      conversationId: conversation.id,
      parts: [{ type: 'text', text: 'здравствуй' }],
    });

    // Пока прогон идёт — текст виден черновиком.
    await until(() => (client.state.streams.get(runId)?.text ?? '').includes('привет'));

    // Когда закончился — черновика нет, есть сообщение.
    await until(() => !client.state.streams.has(runId));
    const messages = client.state.messagesOf(conversation.id);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(messages[1])).toContain('привет-привет');
  });

  it('после перезапуска история подгружается по требованию', async () => {
    await client.connect();
    const { conversation } = await client.call('conversation.create', { title: 'Вчерашний' });
    await client.call('message.send', {
      conversationId: conversation.id,
      parts: [{ type: 'text', text: 'старое сообщение' }],
    });
    await until(() => client.state.messagesOf(conversation.id).length >= 2);

    // Новый клиент — как после перезапуска приложения: состояние пустое,
    // курсор нулевой, синхронизация идёт снапшотом.
    const restarted = new AxonClient({ url: daemon.url, token, socketFactory, reconnect: false });
    try {
      await restarted.connect();

      // Разговор в списке есть, а переписки в памяти ещё нет: снапшот её не
      // содержит, и журнал с текущей вершины её уже не принесёт.
      expect(restarted.state.conversations.has(conversation.id)).toBe(true);
      expect(restarted.state.messagesOf(conversation.id)).toHaveLength(0);

      await restarted.loadHistory(conversation.id);

      const restored = restarted.state.messagesOf(conversation.id);
      expect(restored.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(restored)).toContain('старое сообщение');

      // Повторный вызов не дублирует сообщения.
      await restarted.loadHistory(conversation.id, { force: true });
      expect(restarted.state.messagesOf(conversation.id)).toHaveLength(restored.length);
    } finally {
      restarted.close();
    }
  });

  it('счётчик расхода приходит сигналом по ходу прогона', async () => {
    await client.connect();
    const ticks: number[] = [];
    client.onSignal((signal) => {
      if (signal.type === 'usage.tick') ticks.push(signal.usage.inputTokens);
    });

    const { conversation } = await client.call('conversation.create', {});
    await client.call('message.send', {
      conversationId: conversation.id,
      parts: [{ type: 'text', text: 'считай' }],
    });

    await until(() => ticks.length > 0);
    expect(ticks[0]).toBe(50);
  });
});

// ─── Разрешения ─────────────────────────────────────────────────────────────

describe('ядро старее приложения', () => {
  /**
   * Ядро в Axon — отдельная программа, и оно законно бывает старше клиента:
   * человек обновил приложение, а ядро на сервере осталось прежним. Раньше это
   * подвешивало приложение в «Синхронизации» навсегда и без единого слова —
   * ошибка гасилась в промисе, а статус так и не менялся.
   */
  it('снапшот без новых разделов не подвешивает догон', async () => {
    const older = new AxonClient({ url: daemon.url, token, socketFactory, reconnect: false });

    // Изображаем ядро прошлой версии: разделов, появившихся позже, в ответе
    // просто нет.
    const call = older.call.bind(older);
    older.call = (async (cmd: string, payload: unknown) => {
      const result = (await call(cmd as 'sync.pull', payload as never)) as Record<string, unknown>;
      if (cmd === 'sync.snapshot') {
        delete result['routines'];
        delete result['plugins'];
      }
      return result;
    }) as typeof older.call;

    await older.connect();

    expect(older.connectionStatus).toBe('ready');
    expect(older.state.routines.size).toBe(0);
    // Разговоры при этом на месте — потеряно только то, чего ядро не знает.
    expect(older.state.conversations).toBeDefined();
    older.close();
  });

  it('сорванный догон переводит клиента в offline и объясняет причину', async () => {
    const broken = new AxonClient({ url: daemon.url, token, socketFactory, reconnect: false });

    // Ломаем догон изнутри: снапшот приходит, а применение падает — ровно то,
    // что случается, когда ядро не прислало раздела, которого клиент ждёт.
    const statuses: string[] = [];
    const errors: string[] = [];
    broken.onStatus((status) => statuses.push(status));
    broken.onError((error) => errors.push(error.message));

    const original = broken.state.reset.bind(broken.state);
    broken.state.reset = () => {
      broken.state.reset = original;
      throw new Error('раздел не приехал');
    };

    await expect(broken.connect()).rejects.toThrow(/раздел не приехал/);

    // Главное: не остались в «синхронизации» и сказали, что случилось.
    expect(broken.connectionStatus).toBe('offline');
    expect(statuses).toContain('offline');
    expect(errors).toContain('раздел не приехал');
    broken.close();
  });
});

describe('инструменты', () => {
  it('выключение доезжает до клиента событием и переживает перезапуск ядра', async () => {
    await client.connect();
    expect(client.state.tools.get('remember')?.enabled).toBe(true);

    await client.call('tool.setEnabled', { name: 'remember', enabled: false });

    // Без события клиент показывал бы старое состояние — переключатель
    // выглядел бы нерабочим.
    await until(() => client.state.tools.get('remember')?.enabled === false);

    // И решение должно пережить перезапуск ядра, а не жить только в памяти.
    await daemon.stop();
    daemon = new Daemon({ config: { dataDir: tmpDir }, port: 0 });
    await daemon.start();

    const info = daemon.runtime.tools.list().find((t) => t.name === 'remember');
    expect(info?.enabled).toBe(false);
    // Выключенный инструмент не уезжает в модель.
    expect(
      daemon.runtime.tools.select({ scopes: ['tools.safe'] }).some((t) => t.name === 'remember'),
    ).toBe(false);
  });
});

describe('разрешения', () => {
  it('запрос появляется в состоянии, ответ разблокирует прогон', async () => {
    // Опасный инструмент, которого нет в стандартном наборе.
    let executed = false;
    daemon.runtime.tools.register(
      defineTool({
        name: 'danger',
        title: 'Опасное',
        description: 'Требует подтверждения',
        tier: 'dangerous',
        source: 'test',
        schema: z.object({}),
        async execute() {
          executed = true;
          return { text: 'выполнено' };
        },
      }),
    );

    await client.connect();

    script = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'danger', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ],
      [{ choices: [{ delta: { content: 'готово' } }] }],
    ];

    const { conversation } = await client.call('conversation.create', {});
    await client.call('message.send', {
      conversationId: conversation.id,
      parts: [{ type: 'text', text: 'сделай опасное' }],
    });

    await until(() => client.state.permissions.size === 1);
    const request = [...client.state.permissions.values()][0]!;
    expect(request.toolName).toBe('danger');
    expect(request.tier).toBe('dangerous');

    await client.call('permission.resolve', {
      requestId: request.id,
      decision: 'allow_once',
    });

    await until(() => executed);
    await until(() => client.state.permissions.size === 0);
  });
});
