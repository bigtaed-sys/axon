import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Daemon } from '@axon-assistant/core';
import { AxonClient, pairDevice, type SocketFactory } from '../src/index.js';

/**
 * Вложения проходят по HTTP мимо канала команд, поэтому и проверяются
 * отдельно: это единственный кусок протокола, который не JSON-кадр.
 */

const socketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as ReturnType<SocketFactory>;

let daemon: Daemon;
let tmpDir: string;
let client: AxonClient;

/** Ждать условия: распознавание идёт в фоне, до первого обращения к модели. */
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('условие не наступило');
}

/** Однопиксельный PNG — настоящий файл, а не строка, названная картинкой. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-blobs-'));
  daemon = new Daemon({ config: { dataDir: tmpDir }, port: 0 });
  const { bootstrapCode } = await daemon.start();

  const paired = await pairDevice({
    url: daemon.url,
    code: bootstrapCode!,
    name: 'Тестовый клиент',
  });

  client = new AxonClient({
    url: daemon.url,
    token: paired.token,
    socketFactory,
    reconnect: false,
  });
  await client.connect();
});

afterEach(async () => {
  client.close();
  await daemon.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('вложения', () => {
  it('файл загружается, скачивается обратно и доезжает до модели картинкой', async () => {
    const written = await client.uploadBlob({
      data: PNG,
      mime: 'image/png',
      name: 'точка.png',
    });

    expect(written.blobId).toBeTruthy();
    expect(written.bytes).toBe(PNG.length);

    // Ссылка на показ работает и отдаёт ровно те же байты.
    const response = await fetch(client.blobUrl(written.blobId));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);

    // Кладём в сообщение и проверяем, что сборщик контекста превратил ссылку
    // в настоящие байты: без этого модель получила бы описание вместо картинки.
    const conversation = daemon.runtime.store.createConversation('С картинкой');
    daemon.runtime.store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [
        { type: 'blob', blobId: written.blobId, mime: 'image/png', bytes: written.bytes, name: 'точка.png' },
        { type: 'text', text: 'что на картинке?' },
      ],
    });

    const context = await daemon.runtime.context.build({
      conversationId: conversation.id,
      userText: 'что на картинке?',
    });

    const image = context.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === 'image');
    expect(image).toBeDefined();
    expect(image!.type === 'image' && image.mime).toBe('image/png');
  });

  it('когда распознавание назначено, байты картинки в основную модель не едут', async () => {
    const written = await client.uploadBlob({ data: PNG, mime: 'image/png', name: 'снимок.png' });

    const conversation = daemon.runtime.store.createConversation('С картинкой');
    daemon.runtime.store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [
        { type: 'blob', blobId: written.blobId, mime: 'image/png', bytes: written.bytes, name: 'снимок.png' },
      ],
    });

    const context = await daemon.runtime.context.build({
      conversationId: conversation.id,
      userText: '',
      allowImages: false,
    });

    // Описание уже лежит в истории текстом — платить за байты второй раз
    // незачем, а модель без зрения на них ещё и откажет во всём запросе.
    const parts = context.messages.flatMap((message) => message.parts);
    expect(parts.some((part) => part.type === 'image')).toBe(false);
    expect(JSON.stringify(parts)).toContain('снимок.png');
  });

  it('распознавание не настроено, пока не заданы и провайдер, и модель', () => {
    expect(daemon.runtime.providers.vision()).toBeNull();

    // Половина настройки — это не настройка: без имени модели обращаться не к чему.
    daemon.runtime.store.updateSettings({ values: { 'vision.provider': 'ollama' } });
    expect(daemon.runtime.providers.vision()).toBeNull();

    daemon.runtime.store.updateSettings({ values: { 'vision.model': 'llava' } });
    expect(daemon.runtime.providers.vision()?.model).toBe('llava');
  });

  it('не-картинка уходит в модель описанием, а не байтами', async () => {
    const written = await client.uploadBlob({
      data: Buffer.from('содержимое архива'),
      mime: 'application/zip',
      name: 'архив.zip',
    });

    const conversation = daemon.runtime.store.createConversation('С архивом');
    daemon.runtime.store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [
        { type: 'blob', blobId: written.blobId, mime: 'application/zip', bytes: written.bytes, name: 'архив.zip' },
      ],
    });

    const context = await daemon.runtime.context.build({
      conversationId: conversation.id,
      userText: '',
    });

    // Гнать зип в модель бессмысленно и дорого — она получает имя и тип.
    const text = JSON.stringify(context.messages);
    expect(text).toContain('архив.zip');
    expect(text).not.toContain('image');
  });

  it('без токена вложение не отдаётся', async () => {
    const written = await client.uploadBlob({ data: PNG, mime: 'image/png' });

    const url = client.blobUrl(written.blobId).replace(/token=[^&]*/, 'token=чужой');
    expect((await fetch(url)).status).toBe(401);
  });

  it('назначенная модель описывает картинку, и описание остаётся в переписке', async () => {
    // Поддельная модель: что бы ни спросили, отвечает описанием.
    const seen: unknown[] = [];
    const server = http.createServer(async (req, res) => {
      const body = await new Promise<string>((resolve) => {
        let raw = '';
        req.on('data', (chunk) => (raw += String(chunk)));
        req.on('end', () => resolve(raw));
      });
      seen.push(JSON.parse(body));

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'На снимке чёрный кот' } }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    daemon.runtime.store.updateSettings({
      values: {
        'provider.active': 'ollama',
        'provider.ollama.baseUrl': `http://127.0.0.1:${port}/v1`,
        'vision.provider': 'ollama',
        'vision.model': 'llava',
      },
    });

    const written = await client.uploadBlob({ data: PNG, mime: 'image/png', name: 'кот.png' });
    const { conversation } = await client.call('conversation.create', { title: 'Кот' });
    await client.call('message.send', {
      conversationId: conversation.id,
      parts: [
        { type: 'blob', blobId: written.blobId, mime: 'image/png', bytes: written.bytes, name: 'кот.png' },
        { type: 'text', text: 'кто это?' },
      ],
    });

    await until(() => {
      const messages = daemon.runtime.store.messages.recent(conversation.id, 10);
      return messages.some((m) => JSON.stringify(m.parts).includes('описание вложения'));
    });

    const user = daemon.runtime.store.messages
      .recent(conversation.id, 10)
      .find((m) => m.role === 'user')!;
    const text = JSON.stringify(user.parts);

    // Описание записано в само сообщение: значит картинка стоит токенов один
    // раз, а не переотправляется на каждом следующем ходу.
    expect(text).toContain('описание вложения');
    expect(text).toContain('На снимке чёрный кот');

    // Распознавателю ушла именно назначенная модель — не та, в которой чат.
    const vision = seen.find((body) => (body as { model?: string }).model === 'llava');
    expect(vision).toBeDefined();
    expect(JSON.stringify(vision)).toContain('image_url');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('вложение попадает в поиск по имени файла', async () => {
    const written = await client.uploadBlob({
      data: PNG,
      mime: 'image/png',
      name: 'отчётзаквартал.png',
    });

    const conversation = daemon.runtime.store.createConversation('Отчёты');
    daemon.runtime.store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [
        {
          type: 'blob',
          blobId: written.blobId,
          mime: 'image/png',
          bytes: written.bytes,
          name: 'отчётзаквартал.png',
        },
      ],
    });

    // Байты искать нечем, а имя файла — это то, по чему человек и вспоминает.
    const hits = await client.call('message.search', { query: 'отчетзаквартал' });
    expect(hits.hits).toHaveLength(1);
  });
});
