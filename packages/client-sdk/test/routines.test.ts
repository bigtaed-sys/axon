import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Daemon } from '@axon-assistant/core';
import type { RoutineStep } from '@axon/protocol';
import { AxonClient, pairDevice, type SocketFactory } from '../src/index.js';

/**
 * Рутины проверяются через настоящий протокол и настоящее ядро: подменена
 * только модель. Она отвечает тем, что положили в `script` — так проверяется и
 * компиляция описания в шаги, и то, что скомпилированное потом исполняется.
 */

const socketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as ReturnType<SocketFactory>;

let daemon: Daemon;
let tmpDir: string;
let model: http.Server;
let client: AxonClient;

/** Что модель ответит на следующий запрос. */
let reply = 'ответ';

const STEPS: RoutineStep[] = [
  { kind: 'set', name: 'итог', value: 'всё тихо' },
  { kind: 'message', text: 'Проверил: ${итог}' },
];

function startModel(): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 8 },
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

beforeEach(async () => {
  reply = 'ответ';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-routines-'));
  const started = await startModel();
  model = started.server;

  daemon = new Daemon({ config: { dataDir: tmpDir }, port: 0 });
  const { bootstrapCode } = await daemon.start();
  daemon.runtime.store.updateSettings({
    values: { 'provider.active': 'ollama', 'provider.ollama.baseUrl': started.url },
  });

  const paired = await pairDevice({ url: daemon.url, code: bootstrapCode!, name: 'Тест' });
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
  await new Promise<void>((resolve) => model.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('сборка рутины из описания', () => {
  it('описание словами превращается в шаги и расписание', async () => {
    reply = JSON.stringify({
      name: 'Утренняя сводка',
      description: 'Смотрит, что нового, и пишет коротко',
      schedule: { kind: 'daily', time: '09:00' },
      steps: [
        { kind: 'set', name: 'итог', value: 'ничего нового' },
        { kind: 'message', text: 'Сводка: ${итог}' },
      ],
    });

    const compiled = await client.call('routine.compile', {
      source: 'каждое утро в девять пиши короткую сводку',
    });

    expect(compiled.name).toBe('Утренняя сводка');
    expect(compiled.schedule).toEqual({ kind: 'daily', time: '09:00' });
    expect(compiled.steps.map((step) => step.kind)).toEqual(['set', 'message']);
  });

  it('несуществующий инструмент отклоняется при сборке, а не ночью на прогоне', async () => {
    reply = JSON.stringify({
      name: 'Кривая',
      description: '',
      schedule: { kind: 'manual' },
      steps: [{ kind: 'tool', tool: 'нет_такого', args: {} }],
    });

    await expect(
      client.call('routine.compile', { source: 'сделай что-нибудь' }),
    ).rejects.toThrow(/не существует/);
  });

  it('выдуманные аргументы инструмента ловятся по его схеме', async () => {
    reply = JSON.stringify({
      name: 'Почти верная',
      description: '',
      schedule: { kind: 'manual' },
      // У remember параметры называются key и value, а не name.
      steps: [{ kind: 'tool', tool: 'remember', args: { name: 'x', value: 'y' } }],
    });

    await expect(
      client.call('routine.compile', { source: 'запомни что-нибудь' }),
    ).rejects.toThrow(/нет таких аргументов/);
  });

  it('опасный шаг без разрешения не проходит сборку', async () => {
    reply = JSON.stringify({
      name: 'Опасная',
      description: '',
      schedule: { kind: 'manual' },
      steps: [{ kind: 'tool', tool: 'write_file', args: { path: 'a.txt', content: 'б' } }],
    });

    // Рядом с рутиной человека нет: подтвердить опасное действие будет некому.
    await expect(
      client.call('routine.compile', { source: 'запиши файл' }),
    ).rejects.toThrow(/разрешения/);
  });

  it('ответ не в формате JSON объясняется человеку, а не роняет команду', async () => {
    reply = 'Конечно! Вот ваша рутина: сначала откройте почту…';

    await expect(client.call('routine.compile', { source: 'что-нибудь' })).rejects.toThrow(
      /не JSON/i,
    );
  });
});

describe('рутины', () => {
  it('заводятся с посчитанным временем следующего запуска', async () => {
    const { routine } = await client.call('routine.create', {
      name: 'Утренняя сводка',
      steps: STEPS,
      schedule: { kind: 'daily', time: '09:00' },
    });

    expect(routine.enabled).toBe(true);
    expect(new Date(routine.nextRunAt!).getHours()).toBe(9);
    // Бюджет обязателен: за фоновой задачей никто не смотрит.
    expect(routine.budgetTokens).toBeGreaterThan(0);
    expect(client.state.routines.get(routine.id)?.name).toBe('Утренняя сводка');
  });

  it('ручной запуск исполняет шаги и пишет след', async () => {
    const created = await client.call('routine.create', {
      name: 'Проверка',
      steps: STEPS,
      schedule: { kind: 'manual' },
    });

    const { routine } = await client.call('routine.runNow', { id: created.routine.id });
    expect(routine.lastStatus).toBe('ok');

    const { runs } = await client.call('routine.runs', { routineId: routine.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.steps.map((step) => step.kind)).toEqual(['set', 'message']);
    expect(runs[0]!.steps.every((step) => step.ok)).toBe(true);
    // Шаги без обращений к модели не стоят ничего — ради этого всё и затевалось.
    expect(runs[0]!.tokens).toBe(0);

    // Результат виден обычной перепиской.
    const history = await client.call('message.history', {
      conversationId: routine.conversationId!,
    });
    expect(JSON.stringify(history.messages)).toContain('Проверил: всё тихо');
  });

  it('выключенная рутина теряет время следующего запуска', async () => {
    const created = await client.call('routine.create', {
      name: 'Пауза',
      steps: STEPS,
      schedule: { kind: 'interval', everyMinutes: 30 },
    });
    expect(created.routine.nextRunAt).toBeTruthy();

    const off = await client.call('routine.update', { id: created.routine.id, enabled: false });
    expect(off.routine.nextRunAt).toBeUndefined();

    const on = await client.call('routine.update', { id: created.routine.id, enabled: true });
    expect(on.routine.nextRunAt).toBeTruthy();
  });

  it('правка одного поля не затирает остальные', async () => {
    const created = await client.call('routine.create', {
      name: 'Была',
      source: 'исходное описание',
      steps: STEPS,
      schedule: { kind: 'daily', time: '09:00' },
      allowTools: ['http_request'],
    });

    const { routine } = await client.call('routine.update', {
      id: created.routine.id,
      name: 'Стала',
    });

    expect(routine.name).toBe('Стала');
    expect(routine.source).toBe('исходное описание');
    expect(routine.allowTools).toEqual(['http_request']);
    expect(routine.steps).toHaveLength(2);
  });

  it('удаление уносит рутину у всех устройств', async () => {
    const created = await client.call('routine.create', {
      name: 'Лишняя',
      steps: STEPS,
      schedule: { kind: 'manual' },
    });
    expect(client.state.routines.has(created.routine.id)).toBe(true);

    await client.call('routine.delete', { id: created.routine.id });
    expect(client.state.routines.has(created.routine.id)).toBe(false);
  });

  it('рутина переживает перезапуск ядра вместе с шагами и расписанием', async () => {
    const created = await client.call('routine.create', {
      name: 'Долгая',
      steps: STEPS,
      schedule: { kind: 'daily', time: '23:59' },
    });

    client.close();
    await daemon.stop();

    daemon = new Daemon({ config: { dataDir: tmpDir }, port: 0 });
    await daemon.start();

    const restored = daemon.runtime.scheduler.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.steps).toHaveLength(2);
    expect(restored[0]!.nextRunAt).toBe(created.routine.nextRunAt);
  });
});
