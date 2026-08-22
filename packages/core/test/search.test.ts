import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, INDEXED_UP_TO_SETTING, type Runtime } from '../src/index.js';

let runtime: Runtime;
let tmpDir: string;

function say(conversationId: string, text: string, role: 'user' | 'assistant' = 'user'): string {
  return runtime.store.appendMessage({
    conversationId,
    role,
    parts: [{ type: 'text', text }],
  }).id;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-search-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('поиск по переписке', () => {
  it('находит по слову и показывает кусок вокруг совпадения', () => {
    const chat = runtime.store.createConversation('Про кофе');
    say(chat.id, 'Где в центре Варшавы приличная обжарка?');
    say(chat.id, 'На Новом Святе есть пара мест с хорошим эспрессо.', 'assistant');

    const hits = runtime.store.search.search('эспрессо');

    expect(hits).toHaveLength(1);
    expect(hits[0]!.conversationId).toBe(chat.id);
    expect(hits[0]!.role).toBe('assistant');
    // Найденное слово обёрнуто — по этим меткам клиент подсвечивает.
    expect(hits[0]!.snippet).toContain('«эспрессо»');
  });

  it('ищет по началу слова и не спотыкается о регистр и ё', () => {
    const chat = runtime.store.createConversation('Разное');
    say(chat.id, 'Настройки провайдера лежат в ядре');
    say(chat.id, 'Ёлка стоит в углу');

    expect(runtime.store.search.search('НАСТР')).toHaveLength(1);
    // По-русски пишут и «ёлка», и «елка». Ищем по любому написанию, иначе
    // находка зависит от того, как человек набрал слово.
    expect(runtime.store.search.search('елка')).toHaveLength(1);
    expect(runtime.store.search.search('ЁЛКА')).toHaveLength(1);

    // При этом в выдаче остаётся то, что действительно написано: свёртка живёт
    // в индексе, а кусок текста режется из оригинала.
    expect(runtime.store.search.search('елка')[0]!.snippet).toContain('«Ёлка»');

    // Подсвечивается слово целиком, а не введённый огрызок.
    expect(runtime.store.search.search('настр')[0]!.snippet).toContain('«Настройки»');
  });

  it('спецсимволы в запросе не роняют поиск', () => {
    const chat = runtime.store.createConversation('Разное');
    say(chat.id, 'обычный текст');

    // Всё это — синтаксис FTS5. Без подготовки запроса SQLite бросил бы
    // ошибку прямо в лицо пользователю.
    for (const query of ['"', '*', 'AND', 'NEAR(', 'a OR', '(((']) {
      expect(() => runtime.store.search.search(query)).not.toThrow();
    }
  });

  it('удалённое сообщение и удалённый разговор уходят из выдачи', () => {
    const chat = runtime.store.createConversation('Временный');
    const first = say(chat.id, 'уникальноеслово раз');
    say(chat.id, 'уникальноеслово два');

    expect(runtime.store.search.search('уникальноеслово')).toHaveLength(2);

    runtime.store.deleteMessage(first, chat.id);
    expect(runtime.store.search.search('уникальноеслово')).toHaveLength(1);

    runtime.store.deleteConversation(chat.id);
    expect(runtime.store.search.search('уникальноеслово')).toHaveLength(0);
  });

  it('индекс догоняет переписку, накопленную до его появления', () => {
    const chat = runtime.store.createConversation('Старый');
    say(chat.id, 'давнее сообщение про верблюдов');
    say(chat.id, 'и ещё одно про верблюдов');

    // Имитируем состояние после обновления: индекс пуст, метка сброшена.
    runtime.db.prepare('DELETE FROM message_search').run();
    runtime.store.settings.set(INDEXED_UP_TO_SETTING, 0, new Date().toISOString());
    expect(runtime.store.search.search('верблюдов')).toHaveLength(0);

    expect(runtime.store.search.catchUp()).toBe(2);
    expect(runtime.store.search.search('верблюдов')).toHaveLength(2);

    // Повторный догон ничего не делает и ничего не дублирует.
    expect(runtime.store.search.catchUp()).toBe(0);
    expect(runtime.store.search.search('верблюдов')).toHaveLength(2);
  });

  it('системные сообщения в поиск не попадают', () => {
    const chat = runtime.store.createConversation('С системным');
    runtime.store.appendMessage({
      conversationId: chat.id,
      role: 'system',
      parts: [{ type: 'text', text: 'служебноеслово внутри системного промпта' }],
    });

    // Системный промпт один на все разговоры: он находился бы по любому слову
    // из себя и засорял выдачу в каждом запросе.
    expect(runtime.store.search.search('служебноеслово')).toHaveLength(0);
  });
});
