import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '@axon/core';

let runtime: Runtime;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-edit-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function say(conversationId: string, role: 'user' | 'assistant', text: string) {
  return runtime.store.appendMessage({
    conversationId,
    role,
    parts: [{ type: 'text', text }],
  });
}

describe('обрезание разговора', () => {
  it('убирает сообщение вместе со всем, что после него', () => {
    // Изменённый вопрос делает недействительной всю ветку, а не только
    // ближайший ответ: оставить её значило бы показать разговор, которого
    // не было.
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'user', 'первый вопрос');
    say(chat.id, 'assistant', 'первый ответ');
    const second = say(chat.id, 'user', 'второй вопрос');
    say(chat.id, 'assistant', 'второй ответ');

    const removed = runtime.store.truncateFrom(chat.id, second.id);

    expect(removed).toBe(2);
    const left = runtime.store.messages.recent(chat.id, 10);
    expect(left.map((m) => m.parts[0])).toMatchObject([
      { text: 'первый вопрос' },
      { text: 'первый ответ' },
    ]);
  });

  it('удалённое исчезает и из поиска', () => {
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'user', 'привет');
    const doomed = say(chat.id, 'user', 'уникальноеслово');

    expect(runtime.store.search.search('уникальноеслово')).toHaveLength(1);
    runtime.store.truncateFrom(chat.id, doomed.id);
    expect(runtime.store.search.search('уникальноеслово')).toHaveLength(0);
  });

  it('несуществующее сообщение ничего не ломает', () => {
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'user', 'привет');

    expect(runtime.store.truncateFrom(chat.id, 'нет-такого')).toBe(0);
    expect(runtime.store.messages.recent(chat.id, 10)).toHaveLength(1);
  });
});
