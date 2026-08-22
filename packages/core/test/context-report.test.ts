import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextReport, createRuntime, type Runtime } from '../src/index.js';

let runtime: Runtime;
let tmpDir: string;

function report(conversationId: string) {
  return buildContextReport(
    {
      store: runtime.store,
      context: runtime.context,
      tools: runtime.tools,
      skills: runtime.skills,
      providers: runtime.providers,
    },
    { conversationId, access: { scopes: ['tools.safe', 'tools.sensitive'] } },
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-context-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('разбор контекста', () => {
  it('раскладывает промпт по составляющим и считает кэшируемую часть', async () => {
    runtime.store.updateSettings({ values: { 'persona.name': 'Аксон' } });
    runtime.store.upsertFact('город', 'Варшава');
    runtime.store.notice('не любит длинных объяснений', 'preference');

    const chat = runtime.store.createConversation('Тест');
    runtime.store.appendMessage({
      conversationId: chat.id,
      role: 'user',
      parts: [{ type: 'text', text: 'Привет, как дела?' }],
    });

    const result = await report(chat.id);
    const keys = result.parts.map((part) => part.key);

    expect(keys).toContain('persona');
    expect(keys).toContain('observations');
    expect(keys).toContain('facts');
    expect(keys).toContain('tools');
    expect(keys).toContain('history');

    // Время — единственный изменчивый вклад по умолчанию, и оно обязано быть
    // за точкой кэша. Если оно окажется в стабильной части, кэш промпта будет
    // обнуляться каждую минуту, и никто этого не заметит.
    const clock = result.parts.find((part) => part.key.startsWith('volatile:'));
    expect(clock?.cached).toBe(false);

    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.cacheableTokens).toBeGreaterThan(0);
    expect(result.cacheableTokens).toBeLessThan(result.totalTokens);
  });

  it('отложенные инструменты не стоят ничего, пока их не спросили', async () => {
    const chat = runtime.store.createConversation('Тест');
    const result = await report(chat.id);

    const deferred = result.parts.find((part) => part.key === 'tools.deferred');
    expect(deferred).toBeDefined();
    expect(deferred!.tokens).toBe(0);

    // А обычные — стоят, и это видно.
    expect(result.parts.find((part) => part.key === 'tools')!.tokens).toBeGreaterThan(0);
  });

  it('выключение инструмента уменьшает контекст', async () => {
    const chat = runtime.store.createConversation('Тест');
    const before = (await report(chat.id)).parts.find((part) => part.key === 'tools')!.tokens;

    for (const tool of runtime.tools.list()) {
      runtime.tools.setEnabled(tool.name, false);
    }

    const after = (await report(chat.id)).parts.find((part) => part.key === 'tools');
    // Инструментов не осталось — и строки про них тоже.
    expect(after).toBeUndefined();
    expect(before).toBeGreaterThan(0);
  });

  it('скиллы стоят оглавления, а не своих тел', async () => {
    const chat = runtime.store.createConversation('Тест');
    const body = 'очень длинное тело скилла '.repeat(200);

    runtime.skills.add({
      id: 'test/длинный',
      pluginId: 'test',
      name: 'Длинный скилл',
      description: 'Одна строка описания',
      body,
      tokens: 5_000,
    });

    const result = await report(chat.id);
    const skills = result.parts.find((part) => part.key === 'skills')!;

    // Всё обещание прогрессивного раскрытия здесь и проверяется: тело на
    // тысячи токенов стоит в контексте пары десятков.
    expect(skills.tokens).toBeLessThan(100);
  });

  it('на свежей установке без ключа отчёт всё равно открывается', async () => {
    const chat = runtime.store.createConversation('Тест');
    const result = await report(chat.id);

    expect(result.provider).toBeUndefined();
    expect(result.supportsPromptCache).toBe(false);
    expect(result.totalTokens).toBeGreaterThan(0);
  });
});
