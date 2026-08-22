import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  commandScopes,
  commands,
  commandNames,
  isCommandName,
  zClientFrame,
  zJournalEvent,
  zServerFrame,
  zToolResult,
} from '../src/index.js';

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOW = '2026-08-09T12:00:00.000Z';

describe('кадры', () => {
  it('разбирает запрос клиента', () => {
    const frame = zClientFrame.parse({
      t: 'req',
      id: UUID,
      cmd: 'message.send',
      payload: { conversationId: UUID, parts: [{ type: 'text', text: 'привет' }] },
    });
    expect(frame.t).toBe('req');
  });

  it('отвергает кадр с неизвестным тегом', () => {
    expect(zClientFrame.safeParse({ t: 'нечто', id: UUID }).success).toBe(false);
  });

  it('разбирает hello от ядра', () => {
    const frame = zServerFrame.parse({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      core: { coreId: UUID, version: '0.0.0', mode: 'embedded', scopes: ['chat.read'] },
      head: 0,
    });
    expect(frame.t).toBe('hello');
  });
});

describe('журнал', () => {
  it('принимает создание сообщения', () => {
    const event = zJournalEvent.parse({
      type: 'message.created',
      message: {
        id: UUID,
        conversationId: UUID,
        role: 'user',
        parts: [{ type: 'text', text: 'привет' }],
        createdAt: NOW,
      },
    });
    expect(event.type).toBe('message.created');
  });

  it('не пропускает событие без обязательных полей', () => {
    expect(zJournalEvent.safeParse({ type: 'conversation.renamed', id: UUID }).success).toBe(false);
  });
});

describe('реестр команд', () => {
  it('у каждой команды объявлен требуемый scope', () => {
    for (const name of commandNames) {
      expect(commandScopes[name], `нет scope для ${name}`).toBeDefined();
      expect(commandScopes[name].length).toBeGreaterThan(0);
    }
  });

  it('схемы запроса и ответа заданы для всех команд', () => {
    for (const name of commandNames) {
      expect(commands[name].req).toBeDefined();
      expect(commands[name].res).toBeDefined();
    }
  });

  it('распознаёт только известные имена', () => {
    expect(isCommandName('message.send')).toBe(true);
    expect(isCommandName('message.destroyEverything')).toBe(false);
  });

  it('подставляет умолчания в запрос', () => {
    const parsed = commands['sync.pull'].req.parse({ since: 0 });
    expect(parsed.limit).toBe(200);
  });
});

describe('результат инструмента', () => {
  it('помечает обрезанный вывод и ссылку на полный', () => {
    const result = zToolResult.parse({
      ok: true,
      preview: 'первые 2 КБ вывода…',
      truncated: true,
      fullBlobId: UUID,
      durationMs: 42,
    });
    expect(result.ok && result.truncated).toBe(true);
  });

  it('у ошибки нет preview', () => {
    const result = zToolResult.parse({ ok: false, error: 'файл не найден', durationMs: 3 });
    expect(result.ok).toBe(false);
  });
});
