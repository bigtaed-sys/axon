import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerFrame } from '@axon/protocol';
import { Daemon } from '../src/Daemon.js';

/**
 * Сквозной тест: настоящий демон, настоящее ядро, настоящий провайдер —
 * подменена только модель. Заглушка говорит на диалекте OpenAI, поэтому
 * проверяется весь путь, а не его середина.
 */

let daemon: Daemon;
let tmpDir: string;
let model: http.Server;
let modelUrl: string;
let token: string;

/** Заглушка модели: отдаёт SSE в формате OpenAI. */
function startModelServer(reply = 'привет из модели'): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (data: unknown): void => res.write(`data: ${JSON.stringify(data)}\n\n`);

      chunk({ choices: [{ delta: { content: reply } }] });
      chunk({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 30 },
      });
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

// ─── Мелкие клиенты ─────────────────────────────────────────────────────────

async function api(
  method: string,
  url: string,
  options: { body?: unknown; token?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

class Client {
  readonly frames: ServerFrame[] = [];
  private readonly waiters = new Map<string, (frame: ServerFrame) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      this.frames.push(frame);
      if ((frame.t === 'res' || frame.t === 'err') && this.waiters.has(frame.id)) {
        this.waiters.get(frame.id)!(frame);
        this.waiters.delete(frame.id);
      }
    });
  }

  static async connect(url: string, authToken: string): Promise<Client> {
    const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/ws?token=${authToken}`);
    // Слушателя вешаем до `open`: hello уходит первым же кадром, и если ждать
    // открытия, он успевает прийти в сокет без подписчиков и потеряться.
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    await client.waitFor((f) => f.t === 'hello');
    return client;
  }

  async call(cmd: string, payload: unknown = {}): Promise<ServerFrame> {
    const id = randomUUID();
    const done = new Promise<ServerFrame>((resolve) => this.waiters.set(id, resolve));
    this.socket.send(JSON.stringify({ t: 'req', id, cmd, payload }));
    return await done;
  }

  /** Успешный ответ или падение теста с текстом ошибки. */
  async ok<T = Record<string, unknown>>(cmd: string, payload: unknown = {}): Promise<T> {
    const frame = await this.call(cmd, payload);
    if (frame.t !== 'res') throw new Error(`${cmd}: ${JSON.stringify(frame)}`);
    return frame.payload as T;
  }

  async waitFor(predicate: (frame: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return existing;

    return await new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off('message', onMessage);
        reject(new Error('кадр не пришёл вовремя'));
      }, timeoutMs);

      const onMessage = (data: WebSocket.RawData): void => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        if (!predicate(frame)) return;
        clearTimeout(timer);
        this.socket.off('message', onMessage);
        resolve(frame);
      };
      this.socket.on('message', onMessage);
    });
  }

  close(): void {
    this.socket.close();
  }
}

// ─── Подготовка ─────────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-daemon-'));
  const started = await startModelServer();
  model = started.server;
  modelUrl = started.url;

  daemon = new Daemon({ config: { dataDir: tmpDir }, port: 0, mode: 'standalone' });
  const { bootstrapCode } = await daemon.start();

  // Локальная модель без ключа — заглушка притворяется Ollama.
  daemon.runtime.store.updateSettings({
    values: {
      'provider.active': 'ollama',
      'provider.ollama.baseUrl': modelUrl,
      'prompt.system': 'Ты Axon.',
    },
  });

  const paired = await api('POST', `${daemon.url}/v1/pair`, {
    body: { code: bootstrapCode, name: 'Тестовый десктоп' },
  });
  token = paired.json['token'] as string;
});

afterEach(async () => {
  await daemon.stop();
  await new Promise<void>((resolve) => model.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Тесты ──────────────────────────────────────────────────────────────────

describe('пейринг', () => {
  it('первое устройство заводится по коду из файла', async () => {
    expect(token).toBeTruthy();
    expect(daemon.runtime.store.devices.list()).toHaveLength(1);
  });

  it('код одноразовый — второй раз не сработает', async () => {
    const code = fs.existsSync(path.join(tmpDir, 'bootstrap.code'));
    expect(code).toBe(false);

    const again = await api('POST', `${daemon.url}/v1/pair`, { body: { code: 'ABCD-EFGH' } });
    expect(again.status).toBe(403);
  });

  it('в базе лежит только хэш токена', () => {
    const rows = daemon.runtime.db.prepare('SELECT token_hash FROM devices').all() as Array<{
      token_hash: string;
    }>;
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(rows[0]!.token_hash).toHaveLength(64);
  });

  it('без токена внутрь не пускают', async () => {
    const health = await api('GET', `${daemon.url}/health`);
    expect(health.status).toBe(200);

    const blobs = await api('GET', `${daemon.url}/v1/blobs/нет-такого`);
    expect(blobs.status).toBe(401);

    await expect(Client.connect(daemon.url, 'подделка')).rejects.toThrow();
  });
});

describe('сессия', () => {
  it('первым кадром приходит hello с правами и вершиной журнала', async () => {
    const client = await Client.connect(daemon.url, token);
    const hello = client.frames[0]!;
    expect(hello.t).toBe('hello');
    if (hello.t !== 'hello') return;

    expect(hello.core.coreId).toBe(daemon.runtime.coreId);
    expect(hello.core.scopes).toContain('chat.write');
    expect(hello.head).toBeGreaterThanOrEqual(0);
    client.close();
  });

  it('неизвестная команда возвращает код, а не падение', async () => {
    const client = await Client.connect(daemon.url, token);
    const frame = await client.call('какая.то.чушь', {});
    expect(frame.t).toBe('err');
    if (frame.t === 'err') expect(frame.error.code).toBe('unknown_command');
    client.close();
  });

  it('кривой payload отклоняется схемой', async () => {
    const client = await Client.connect(daemon.url, token);
    const frame = await client.call('message.send', { conversationId: 'не-uuid' });
    expect(frame.t).toBe('err');
    if (frame.t === 'err') expect(frame.error.code).toBe('bad_request');
    client.close();
  });
});

describe('разговор от начала до конца', () => {
  it('сообщение проходит весь путь: команда → модель → журнал и сигналы', async () => {
    const client = await Client.connect(daemon.url, token);
    const { conversation } = await client.ok<{ conversation: { id: string } }>(
      'conversation.create',
      { title: 'Проверка' },
    );

    const sent = await client.ok<{ runId: string }>('message.send', {
      conversationId: conversation.id,
      parts: [{ type: 'text', text: 'привет' }],
    });
    expect(sent.runId).toBeTruthy();

    const finished = await client.waitFor(
      (f) => f.t === 'evt' && f.event.type === 'run.finished',
    );
    expect(finished.t).toBe('evt');

    // Дельты доехали сигналами, а не событиями.
    const deltas = client.frames
      .filter((f): f is Extract<ServerFrame, { t: 'sig' }> => f.t === 'sig')
      .filter((f) => f.signal.type === 'run.delta');
    expect(deltas.length).toBeGreaterThan(0);

    // Ответ модели лёг в историю.
    const history = await client.ok<{ messages: Array<{ role: string }> }>('message.history', {
      conversationId: conversation.id,
    });
    expect(history.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // И расход посчитан.
    const usage = await client.ok<{ inputTokens: number; runs: number }>('usage.summary', {});
    expect(usage.inputTokens).toBe(120);
    expect(usage.runs).toBe(1);

    client.close();
  });

  it('журнал догоняется курсором', async () => {
    const client = await Client.connect(daemon.url, token);
    await client.ok('conversation.create', {});
    const first = await client.ok<{ cursor: number }>('sync.pull', { since: 0 });

    await client.ok('conversation.create', {});
    const next = await client.ok<{ entries: unknown[] }>('sync.pull', { since: first.cursor });

    expect(next.entries).toHaveLength(1);
    client.close();
  });

  it('снапшот отдаёт состояние и инструменты', async () => {
    const client = await Client.connect(daemon.url, token);
    const snapshot = await client.ok<{
      tools: Array<{ name: string }>;
      devices: unknown[];
      cursor: number;
    }>('sync.snapshot', {});

    expect(snapshot.tools.map((t) => t.name)).toContain('remember');
    expect(snapshot.devices).toHaveLength(1);
    client.close();
  });
});

describe('права и секреты', () => {
  async function pairLimited(client: Client): Promise<string> {
    const begun = await client.ok<{ code: string }>('device.pairBegin', {
      name: 'Телефон',
      platform: 'mobile',
      scopes: ['chat.read', 'chat.write', 'tools.safe'],
    });
    const paired = await api('POST', `${daemon.url}/v1/pair`, { body: { code: begun.code } });
    return paired.json['token'] as string;
  }

  it('устройство не может выдать прав больше, чем есть у него самого', async () => {
    const client = await Client.connect(daemon.url, token);
    const limitedToken = await pairLimited(client);
    const limited = await Client.connect(daemon.url, limitedToken);

    const frame = await limited.call('device.pairBegin', {
      name: 'Ещё телефон',
      platform: 'mobile',
      scopes: ['tools.dangerous'],
    });
    expect(frame.t).toBe('err');

    limited.close();
    client.close();
  });

  it('урезанное устройство не лезет в настройки', async () => {
    const client = await Client.connect(daemon.url, token);
    const limited = await Client.connect(daemon.url, await pairLimited(client));

    const frame = await limited.call('settings.set', { values: { 'provider.active': 'openai' } });
    expect(frame.t).toBe('err');
    if (frame.t === 'err') expect(frame.error.code).toBe('forbidden');

    limited.close();
    client.close();
  });

  it('секрет уходит только статусом, значение — никогда', async () => {
    const client = await Client.connect(daemon.url, token);
    await client.ok('settings.set', {
      secrets: { 'provider.anthropic.apiKey': 'sk-очень-секретный-9876' },
    });

    const settings = await client.ok<{ secrets: Array<{ key: string; set: boolean; hint?: string }> }>(
      'settings.get',
      {},
    );
    expect(JSON.stringify(settings)).not.toContain('очень-секретный');

    const secret = settings.secrets.find((s) => s.key === 'provider.anthropic.apiKey')!;
    expect(secret.set).toBe(true);
    expect(secret.hint).toBe('9876');

    // А локально — читается целиком, это и есть ручка для CLI.
    expect(daemon.runtime.store.secrets.reveal('provider.anthropic.apiKey')).toBe(
      'sk-очень-секретный-9876',
    );
    client.close();
  });
});

describe('блобы', () => {
  it('загрузка и скачивание по HTTP, а не через сокет', async () => {
    const upload = await fetch(`${daemon.url}/v1/blobs?name=note.txt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'содержимое файла',
    });
    const { blobId, bytes } = (await upload.json()) as { blobId: string; bytes: number };
    expect(bytes).toBeGreaterThan(0);

    const download = await fetch(`${daemon.url}/v1/blobs/${blobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('содержимое файла');
    expect(download.headers.get('etag')).toBeTruthy();
  });

  it('браузеру разрешено спросить разрешение на загрузку', async () => {
    // Окно приложения живёт на своей схеме (`axon://app`), ядро отвечает по
    // http — для браузера это разные источники. Загрузка несёт заголовок
    // `Authorization`, а такой запрос браузер сначала спрашивает отдельным
    // `OPTIONS`. Без ответа на него вложение не уходило вовсе, и человек
    // видел под картинкой голое «failed to fetch».
    const preflight = await fetch(`${daemon.url}/v1/blobs`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'axon://app',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');

    // Разрешение на сам ответ тоже нужно: без него браузер прочитать его не даст.
    const upload = await fetch(`${daemon.url}/v1/blobs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'вложение',
    });
    expect(upload.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('одинаковое содержимое не дублируется на диске', async () => {
    const send = async (): Promise<string> => {
      const response = await fetch(`${daemon.url}/v1/blobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'одно и то же',
      });
      return ((await response.json()) as { blobId: string }).blobId;
    };

    expect(await send()).toBe(await send());
  });
});
