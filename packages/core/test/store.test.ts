import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JournalEntry } from '@axon/protocol';
import { openDatabase } from '../src/storage/db.js';
import { Store } from '../src/storage/Store.js';

let store: Store;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-test-'));
  const db = openDatabase({ databasePath: ':memory:' });
  store = new Store({ db, secretKeyPath: path.join(tmpDir, 'secret.key') });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('журнал', () => {
  it('нумерует записи монотонно и отдаёт их по курсору', () => {
    const conversation = store.createConversation('первый');
    store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'привет' }],
    });

    const page = store.pull(0, 10);
    expect(page.entries.map((e) => e.event.type)).toEqual([
      'conversation.created',
      'message.created',
    ]);
    expect(page.entries[0]!.seq).toBeLessThan(page.entries[1]!.seq);
    expect(page.cursor).toBe(store.head());
    expect(page.hasMore).toBe(false);
  });

  it('догоняет с середины, не отдавая уже виденное', () => {
    const conversation = store.createConversation();
    const first = store.pull(0, 10).cursor;

    store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'второе' }],
    });

    const page = store.pull(first, 10);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.event.type).toBe('message.created');
  });

  it('сообщает hasMore, когда упёрлись в лимит', () => {
    const conversation = store.createConversation();
    for (let i = 0; i < 5; i++) {
      store.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', text: `сообщение ${i}` }],
      });
    }
    expect(store.pull(0, 3).hasMore).toBe(true);
  });

  it('не даёт писать в журнал вне транзакции', () => {
    expect(() => store.record({ type: 'conversation.deleted', id: 'x' })).toThrow(/транзакции/);
  });
});

describe('атомарность журнала и состояния', () => {
  it('рассылает события только после коммита', () => {
    const seenDuring: JournalEntry[] = [];
    const seenAfter: JournalEntry[] = [];
    store.journal.subscribe((entry) => seenAfter.push(entry));

    store.transact(() => {
      store.createConversation('внутри транзакции');
      // Подписчик ещё не должен был ничего получить.
      seenDuring.push(...seenAfter);
    });

    expect(seenDuring).toHaveLength(0);
    expect(seenAfter).toHaveLength(1);
  });

  it('при откате не остаётся ни строк, ни событий', () => {
    const seen: JournalEntry[] = [];
    store.journal.subscribe((entry) => seen.push(entry));

    expect(() =>
      store.transact(() => {
        store.createConversation('обречённый');
        throw new Error('падаем');
      }),
    ).toThrow('падаем');

    expect(seen).toHaveLength(0);
    expect(store.head()).toBe(0);
    expect(store.conversations.list(10)).toHaveLength(0);
  });

  it('вложенная транзакция рассылает события один раз', () => {
    const seen: JournalEntry[] = [];
    store.journal.subscribe((entry) => seen.push(entry));

    store.transact(() => {
      const conversation = store.createConversation();
      store.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', text: 'вложенное' }],
      });
    });

    expect(seen).toHaveLength(2);
  });
});

describe('порядок сообщений', () => {
  it('сохраняет порядок сообщений, созданных в одну миллисекунду', () => {
    const conversation = store.createConversation();
    const texts = ['первое', 'второе', 'третье', 'четвёртое'];
    for (const text of texts) {
      store.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        parts: [{ type: 'text', text }],
      });
    }

    const recent = store.messages.recent(conversation.id, 10);
    expect(recent.map((m) => (m.parts[0]!.type === 'text' ? m.parts[0].text : ''))).toEqual(texts);
  });

  it('страница вверх по истории идёт от указанного сообщения', () => {
    const conversation = store.createConversation();
    const ids = ['a', 'b', 'c', 'd'].map(
      (text) =>
        store.appendMessage({
          conversationId: conversation.id,
          role: 'user',
          parts: [{ type: 'text', text }],
        }).id,
    );

    const page = store.messages.page(conversation.id, ids[2]!, 10);
    expect(page).toHaveLength(2);
    expect(page.map((m) => m.id)).toEqual([ids[0], ids[1]]);
  });

  it('мягко удалённое сообщение исчезает из выборок, но не сдвигает позиции', () => {
    const conversation = store.createConversation();
    const first = store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'останется' }],
    });
    const second = store.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      parts: [{ type: 'text', text: 'удалим' }],
    });

    store.deleteMessage(second.id, conversation.id);

    expect(store.messages.recent(conversation.id, 10).map((m) => m.id)).toEqual([first.id]);
    expect(store.messages.ordOf(second.id)).not.toBeNull();
  });
});

describe('секреты', () => {
  it('шифрует значение и отдаёт наружу только статус', () => {
    store.updateSettings({ secrets: { 'provider.deepseek.apiKey': 'sk-очень-секретный-1234' } });

    const [status] = store.secrets.status(['provider.deepseek.apiKey']);
    expect(status!.set).toBe(true);
    expect(status!.hint).toBe('1234');
    expect(JSON.stringify(status)).not.toContain('очень-секретный');
  });

  it('база без своего ключа шифрования — это «не читается», а не «задан»', () => {
    // Ровно то, что случается при переносе: `axon backup` не кладёт secret.key
    // в архив без спроса, база приезжает на новую машину, а ключ остаётся на
    // старой. Раньше интерфейс показывал «ключ на месте», и человек искал
    // причину отказов в чём угодно, кроме переноса.
    const db = openDatabase({ databasePath: ':memory:' });
    const keyPath = path.join(tmpDir, 'перенос.key');
    const first = new Store({ db, secretKeyPath: keyPath });
    first.updateSettings({ secrets: { 'provider.anthropic.apiKey': 'sk-ant-1234' } });

    // Ключ шифрования подменяем — как если бы он был создан заново на новой
    // машине. Сама база при этом та же.
    fs.rmSync(keyPath);
    const moved = new Store({ db, secretKeyPath: keyPath });

    const [status] = moved.secrets.status(['provider.anthropic.apiKey']);
    expect(status!.set).toBe(true);
    expect(status!.unreadable).toBe(true);
    expect(() => moved.secrets.reveal('provider.anthropic.apiKey')).toThrow();
  });

  it('локально значение читается целиком', () => {
    store.updateSettings({ secrets: { 'provider.openai.apiKey': 'sk-abcdef' } });
    expect(store.secrets.reveal('provider.openai.apiKey')).toBe('sk-abcdef');
  });

  it('в журнал уходят только имена ключей, без значений', () => {
    store.updateSettings({
      values: { 'model.default': 'deepseek-chat' },
      secrets: { 'provider.deepseek.apiKey': 'sk-секрет' },
    });

    const entries = store.pull(0, 10);
    const event = entries.entries.at(-1)!.event;
    expect(event.type).toBe('settings.changed');
    expect(JSON.stringify(event)).not.toContain('sk-секрет');
    expect(JSON.stringify(event)).toContain('provider.deepseek.apiKey');
  });

  it('null стирает секрет', () => {
    store.updateSettings({ secrets: { 'x.key': 'значение' } });
    store.updateSettings({ secrets: { 'x.key': null } });
    expect(store.secrets.has('x.key')).toBe(false);
    expect(store.secrets.reveal('x.key')).toBeNull();
  });
});

describe('расход', () => {
  it('считает итоги и разбивку по моделям', () => {
    const conversation = store.createConversation();
    const at = new Date().toISOString();

    store.usage.record({
      runId: 'run-1',
      conversationId: conversation.id,
      at,
      usage: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        inputTokens: 1000,
        cachedInputTokens: 800,
        outputTokens: 200,
        costUsd: 0.01,
      },
    });
    store.usage.record({
      runId: 'run-2',
      conversationId: conversation.id,
      at,
      usage: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 100,
        costUsd: 0.02,
      },
    });

    const totals = store.usage.totals('1970-01-01T00:00:00.000Z');
    expect(totals.inputTokens).toBe(1500);
    expect(totals.cachedInputTokens).toBe(800);
    expect(totals.runs).toBe(2);
    expect(totals.costUsd).toBeCloseTo(0.03);

    const byModel = store.usage.byModel('1970-01-01T00:00:00.000Z');
    expect(byModel).toHaveLength(1);
    expect(byModel[0]!.model).toBe('deepseek-chat');
  });

  it('накопленный расход разговора растёт вместе с сообщениями', () => {
    const conversation = store.createConversation();
    store.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      parts: [{ type: 'text', text: 'ответ' }],
      usage: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        inputTokens: 100,
        cachedInputTokens: 90,
        outputTokens: 50,
      },
    });

    expect(store.conversations.get(conversation.id)!.totalTokens).toBe(150);
  });
});

describe('идентичность ядра', () => {
  it('coreId стабилен между вызовами', () => {
    expect(store.coreId()).toBe(store.coreId());
  });
});
