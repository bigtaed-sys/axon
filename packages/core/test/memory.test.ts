import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact } from '@axon/protocol';
import { createRuntime, selectFacts, type Runtime } from '../src/index.js';

let runtime: Runtime;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-memory-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fact(key: string, value: string, origin: Fact['origin'] = 'inferred'): Fact {
  return {
    id: key,
    key,
    value,
    origin,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('отбор фактов', () => {
  it('пока фактов мало, берутся все', () => {
    const facts = [fact('город', 'Варшава'), fact('язык', 'русский')];
    expect(selectFacts(facts, 'привет')).toHaveLength(2);
  });

  it('сказанное человеком не выцветает никогда', () => {
    // Он сообщил это сам и вправе ожидать, что агент помнит. Отбор касается
    // только того, что агент вывел сам.
    const said = Array.from({ length: 30 }, (_, i) => fact(`своё ${i}`, 'важно', 'user'));
    const guessed = Array.from({ length: 30 }, (_, i) => fact(`догадка ${i}`, 'может быть'));

    const chosen = selectFacts([...said, ...guessed], 'привет', 5);
    const kept = chosen.filter((item) => item.origin === 'user');

    expect(kept).toHaveLength(30);
    expect(chosen).toHaveLength(35);
  });

  it('выбирает то, что относится к вопросу', () => {
    const facts = [
      ...Array.from({ length: 20 }, (_, i) => fact(`мелочь ${i}`, 'ничего')),
      fact('рабочий язык', 'TypeScript'),
    ];

    const chosen = selectFacts(facts, 'на каком языке лучше писать?', 3);
    expect(chosen.map((item) => item.key)).toContain('рабочий язык');
  });

  it('ё и е — одно и то же слово', () => {
    // Иначе факт находится или не находится в зависимости от того, какой
    // раскладкой человек набирал вопрос.
    const facts = [
      ...Array.from({ length: 20 }, (_, i) => fact(`мелочь ${i}`, 'ничего')),
      fact('ещё одно', 'важное'),
    ];

    const chosen = selectFacts(facts, 'что там еще осталось?', 3);
    expect(chosen.map((item) => item.key)).toContain('ещё одно');
  });

  it('когда ничего не совпало, блок не остаётся пустым', () => {
    // Агент без единого факта ведёт себя как в первый день знакомства.
    const facts = Array.from({ length: 20 }, (_, i) => fact(`мелочь ${i}`, 'ничего'));
    const chosen = selectFacts(facts, 'абракадабра', 3);

    expect(chosen).toHaveLength(3);
  });
});

describe('поиск по переписке', () => {
  async function call(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await runtime.tools.get(name)!.execute(args, {
      signal: new AbortController().signal,
    } as never);
    return typeof result.text === 'string' ? result.text : '';
  }

  function say(conversationId: string, role: 'user' | 'assistant', text: string): void {
    runtime.store.appendMessage({ conversationId, role, parts: [{ type: 'text', text }] });
  }

  it('находит сказанное в прошлом разговоре', async () => {
    // Ради этого инструмент и появился: до него всё, что вышло за окно
    // контекста и не попало в факты, для агента не существовало.
    const chat = runtime.store.createConversation('Про докер');
    say(chat.id, 'user', 'не поднимается контейнер с постгресом');
    say(chat.id, 'assistant', 'порт занят другим процессом');

    const found = await call('search_history', { query: 'постгрес' });

    expect(found).toContain('контейнер');
    expect(found).toContain('Про докер');
    expect(found).toContain(chat.id);
  });

  it('честно говорит, когда не нашлось', async () => {
    const chat = runtime.store.createConversation('Разговор');
    say(chat.id, 'user', 'привет');

    expect(await call('search_history', { query: 'квантовая механика' })).toContain(
      'ничего не нашлось',
    );
  });

  it('читает кусок разговора целиком', async () => {
    const chat = runtime.store.createConversation('Переезд');
    say(chat.id, 'user', 'думаю переехать в Краков');
    say(chat.id, 'assistant', 'что тебя туда тянет');

    const read = await call('read_history', { conversationId: chat.id });

    expect(read).toContain('Краков');
    expect(read).toContain('что тебя туда тянет');
  });

  it('показывает карту разговоров', async () => {
    const first = runtime.store.createConversation('Докер');
    const second = runtime.store.createConversation('Переезд');
    say(first.id, 'user', 'а');
    say(second.id, 'user', 'б');

    const list = await call('list_conversations', { limit: 10 });

    expect(list).toContain('Докер');
    expect(list).toContain('Переезд');
  });
});
