import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '../src/index.js';

let runtime: Runtime;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-embed-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Подставной провайдер векторов.
 *
 * Настоящая модель здесь не нужна и вредна: тест проверяет обвязку — что
 * посчитанное сохранилось, что второй проход не считает то же самое, что смена
 * модели не смешивает несравнимое. Для этого достаточно вектора, собранного
 * по буквам текста.
 */
function fakeEmbedding(dims = 8) {
  return async ({ texts }: { texts: string[] }): Promise<number[][]> =>
    texts.map((text) => {
      const vector = new Array(dims).fill(0);
      for (let i = 0; i < text.length; i += 1) {
        vector[text.charCodeAt(i) % dims] += 1;
      }
      return vector;
    });
}

function useFakeProvider(model = 'проба'): void {
  runtime.store.updateSettings({
    values: { 'embedding.provider': 'ollama', 'embedding.model': model },
  });

  const selection = runtime.providers.resolve('ollama', model);
  (selection.provider as { embed?: unknown }).embed = fakeEmbedding();
}

function say(conversationId: string, text: string): void {
  runtime.store.appendMessage({
    conversationId,
    role: 'user',
    parts: [{ type: 'text', text }],
  });
}

describe('семантический индекс', () => {
  it('без назначенной модели молчит', async () => {
    // Законное состояние: эмбеддинги стоят денег, включать их за человека
    // нельзя, а поиск без них остаётся полнотекстовым.
    expect(runtime.embeddings.enabled).toBe(false);
    expect(await runtime.embeddings.catchUp()).toBe(0);
    expect(await runtime.embeddings.search('что угодно', 5)).toEqual([]);
  });

  it('считает векторы для переписки', async () => {
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'не поднимается контейнер');
    say(chat.id, 'порт занят');
    useFakeProvider();

    expect(await runtime.embeddings.catchUp()).toBe(2);
    expect(runtime.store.embeddings.count('ollama:проба')).toBe(2);
  });

  it('второй проход не пересчитывает уже посчитанное', async () => {
    // Иначе каждый перезапуск ядра стоил бы как весь архив переписки.
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'первое');
    useFakeProvider();

    expect(await runtime.embeddings.catchUp()).toBe(1);
    expect(await runtime.embeddings.catchUp()).toBe(0);

    say(chat.id, 'второе');
    expect(await runtime.embeddings.catchUp()).toBe(1);
  });

  it('векторы разных моделей не смешиваются', async () => {
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'что-то');
    useFakeProvider('первая');
    await runtime.embeddings.catchUp();

    expect(runtime.store.embeddings.count('ollama:первая')).toBe(1);

    /**
     * Сменили модель — переписка считается заново, сама.
     *
     * Без сброса водяной метки индекс уходил бы в тихий полураспад: старые
     * векторы новой моделью не ищутся, а новых не считается, потому что метка
     * стоит в конце. Поиск при этом не ломается и не жалуется — просто
     * перестаёт находить.
     */
    useFakeProvider('вторая');
    await runtime.embeddings.catchUp();

    expect(runtime.store.embeddings.count('ollama:первая')).toBe(0);
    expect(runtime.store.embeddings.count('ollama:вторая')).toBe(1);
  });

  it('находит близкое по смыслу', async () => {
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'ааааа');
    say(chat.id, 'ббббб');
    useFakeProvider();
    await runtime.embeddings.catchUp();

    const hits = await runtime.embeddings.search('ааааа', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.conversationId).toBe(chat.id);
  });

  it('результаты инструментов в индекс не идут', async () => {
    // Это выводы команд и куски файлов: искать по их смыслу бессмысленно,
    // а платить за векторы пришлось бы наравне со всем остальным.
    const chat = runtime.store.createConversation('Тест');
    say(chat.id, 'вопрос');
    runtime.store.appendMessage({
      conversationId: chat.id,
      role: 'tool',
      toolCallId: 'x',
      parts: [{ type: 'text', text: 'вывод команды на сто строк' }],
    });
    useFakeProvider();

    expect(await runtime.embeddings.catchUp()).toBe(1);
  });
});
