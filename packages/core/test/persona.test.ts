import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { personaValues, readPersona, zPersona, type Observation } from '@axon/protocol';
import {
  composePersona,
  createRuntime,
  effectiveWeight,
  evictionCandidates,
  reinforcedWeight,
  selectForPrompt,
  type Runtime,
} from '../src/index.js';

let runtime: Runtime;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-persona-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('персона', () => {
  it('на пустых настройках даёт характер, а не пустоту', () => {
    // Главная причина, по которой персону вообще делали структурой: раньше
    // системный блок собирался из одного поля, и на новом ядре агент выходил
    // к человеку вообще без представления о том, кто он.
    const text = composePersona({});

    expect(text).not.toBe('');
    expect(text).toContain('Ты личный агент');
    expect(text).toContain('Не выдумывай');
  });

  it('без имени не придумывает себе имя и не поминает программу', () => {
    // Агент, назвавшийся хоть чем-нибудь, отвечает на вопрос «как тебя зовут»
    // раньше, чем человек успел на него ответить, — и имя занято.
    const text = composePersona({});

    expect(text).toContain('Имени у тебя пока нет');
    expect(text).not.toContain('Тебя зовут');
    // Название программы не должно попадать в промпт вообще: помяни его —
    // и модель начнёт объяснять, что вообще-то её зовут так, но не совсем.
    expect(text).not.toContain('Axon');
  });

  it('имя, пришедшее настройкой мимо знакомства, всё равно считается', () => {
    const text = composePersona({ 'persona.name': 'Кузя' });

    expect(text).toContain('Тебя зовут Кузя');
    expect(text).not.toContain('Имени у тебя пока нет');
  });

  it('ручки манеры доезжают до текста', () => {
    const short = composePersona(
      personaValues(zPersona.parse({ verbosity: 'short', humor: 'none' })),
    );

    expect(short).toContain('Отвечай коротко');
    expect(short).toContain('Не шути');
    expect(short).not.toContain('суховатое чувство юмора');
  });

  it('«свой» характер отдаёт только текст человека', () => {
    const values = personaValues(
      zPersona.parse({ preset: 'custom', custom: 'Отвечай строками кода и молчи.' }),
    );
    const text = composePersona(values);

    expect(text).toContain('Отвечай строками кода');
    // Ни готового характера, ни ручек: человек попросил своё — получает своё.
    expect(text).not.toContain('подхалимничаешь');
    expect(text).not.toContain('Не выдумывай');
  });

  it('обращение на «вы» не смешивается с «ты»', () => {
    const text = composePersona(personaValues(zPersona.parse({ address: 'вы' })));

    expect(text).toContain('на «вы»');
    expect(text).not.toContain('на «ты»');
  });

  it('битое поле не обнуляет остальные', () => {
    const text = composePersona({ 'persona.humor': 42, 'persona.name': 'Гоша' });

    expect(text).toContain('Гоша');
    // Юмор упал на умолчание, а не утащил за собой всю персону.
    expect(text).toContain('суховатое чувство юмора');
  });
});

describe('знакомство', () => {
  /** Задание познакомиться живёт в системном блоке — там его и проверяем. */
  async function systemBlock(): Promise<string> {
    const chat = runtime.store.createConversation('Тест');
    runtime.store.appendMessage({
      conversationId: chat.id,
      role: 'user',
      parts: [{ type: 'text', text: 'привет' }],
    });
    const built = await runtime.context.build({ conversationId: chat.id, userText: 'привет' });
    const system = built.messages.find((message) => message.role === 'system');
    return (system?.parts ?? [])
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  async function callTool(args: Record<string, unknown>): Promise<string> {
    const result = await runtime.tools.get('set_persona')!.execute(args, {
      signal: new AbortController().signal,
    } as never);
    return typeof result.text === 'string' ? result.text : '';
  }

  it('на новом ядре агент получает задание познакомиться', async () => {
    const system = await systemBlock();

    expect(system).toContain('Вы ещё не знакомы');
    expect(system).toContain('set_persona');
    // Дело важнее знакомства: человек, пришедший с вопросом, пришёл за ответом.
    expect(system).toContain('сначала сделай');
  });

  it('после первой же записи задание исчезает', async () => {
    await callTool({ name: 'Кузя' });

    const system = await systemBlock();
    expect(system).not.toContain('Вы ещё не знакомы');
    expect(system).toContain('Кузя');
  });

  it('инструмент меняет только переданное', async () => {
    runtime.store.updateSettings({ values: { 'persona.verbosity': 'short' } });
    await callTool({ userName: 'Саша', address: 'вы' });

    const persona = readPersona(runtime.store.settings.all());
    expect(persona.userName).toBe('Саша');
    expect(persona.address).toBe('вы');
    // Не передавали — не тронули.
    expect(persona.verbosity).toBe('short');
    expect(persona.name).toBe('');
  });

  it('пустой вызов ничего не ломает и не считается знакомством', async () => {
    const said = await callTool({});

    expect(said).toContain('Нечего менять');
    expect(readPersona(runtime.store.settings.all()).configured).toBe(false);
  });

  it('рассказывает модели, что именно записалось', async () => {
    const said = await callTool({ name: 'Кузя', emoji: true });

    expect(said).toContain('имя — Кузя');
    expect(said).toContain('эмодзи');
  });
});

describe('наблюдения', () => {
  it('повторное наблюдение укрепляет прежнее, а не заводит второе', () => {
    const first = runtime.store.notice('не любит длинных объяснений', 'preference');
    const second = runtime.store.notice('Не любит длинных объяснений!', 'preference');

    expect(runtime.store.observations.list()).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.hits).toBe(2);
    expect(second.weight).toBeGreaterThan(first.weight);
  });

  it('вес не уходит в бесконечность от повторов', () => {
    let last = runtime.store.notice('работает по ночам', 'habit');
    for (let i = 0; i < 20; i += 1) last = runtime.store.notice('работает по ночам', 'habit');

    expect(last.weight).toBeLessThanOrEqual(4);
  });

  it('настроение выцветает быстрее привычки', () => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const make = (kind: Observation['kind']): Observation => ({
      id: kind,
      text: kind,
      kind,
      weight: 1,
      hits: 1,
      createdAt: monthAgo,
      updatedAt: monthAgo,
      lastSeenAt: monthAgo,
    });

    const mood = effectiveWeight(make('mood'));
    const habit = effectiveWeight(make('habit'));

    expect(mood).toBeLessThan(habit);
    // Месячное настроение уже не должно попадать в промпт: агент обратился бы
    // к человеку, которого больше нет.
    expect(selectForPrompt([make('mood')])).toHaveLength(0);
    expect(selectForPrompt([make('habit')])).toHaveLength(1);
  });

  it('подтверждение спустя полгода считается от выцветшего, а не от записанного', () => {
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    const stale: Observation = {
      id: 'x',
      text: 'занят переездом',
      kind: 'context',
      weight: 4,
      hits: 9,
      createdAt: longAgo,
      updatedAt: longAgo,
      lastSeenAt: longAgo,
    };

    expect(reinforcedWeight(stale)).toBeLessThan(2.5);
  });

  it('вытесняется самое выцветшее, а не самое старое', () => {
    const at = (days: number): string =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const old: Observation = {
      id: 'old',
      text: 'давняя, но свежеподтверждённая привычка',
      kind: 'habit',
      weight: 3,
      hits: 5,
      createdAt: at(400),
      updatedAt: at(1),
      lastSeenAt: at(1),
    };
    const faded: Observation = {
      id: 'faded',
      text: 'настроение той недели',
      kind: 'mood',
      weight: 1,
      hits: 1,
      createdAt: at(60),
      updatedAt: at(60),
      lastSeenAt: at(60),
    };

    const evicted = evictionCandidates([old, faded], 1);

    expect(evicted.map((o) => o.id)).toEqual(['faded']);
  });

  it('память не растёт бесконечно', () => {
    for (let i = 0; i < 210; i += 1) runtime.store.notice(`наблюдение номер ${i}`, 'context');

    expect(runtime.store.observations.list().length).toBeLessThanOrEqual(200);
  });

  it('удаление наблюдения видно в журнале', () => {
    const observation = runtime.store.notice('пьёт чай, а не кофе', 'preference');
    runtime.store.forgetObservation(observation.id);

    expect(runtime.store.observations.byId(observation.id)).toBeNull();
    const types = runtime.store.journal.read(0, 100).map((entry) => entry.event.type);
    expect(types).toContain('observation.noticed');
    expect(types).toContain('observation.forgotten');
  });
});

describe('канал', () => {
  /** Изменчивая часть промпта: то, что дописывается после истории. */
  async function volatileText(platform?: 'telegram' | 'desktop'): Promise<string> {
    const parts = await runtime.context.volatileParts({
      conversationId: 'x',
      userText: 'привет',
      ...(platform ? { platform } : {}),
    });
    return parts.map((part) => part.text).join('\n');
  }

  it('из телеграма агент знает, что читают с телефона', async () => {
    const text = await volatileText('telegram');

    expect(text).toContain('из телеграма');
    expect(text).toContain('Не рисуй таблицы');
  });

  it('из приложения ничего лишнего не добавляется', async () => {
    // Указание про канал стоит токенов на каждом ходу. Платить за него там,
    // где оно ничего не меняет, незачем.
    expect(await volatileText('desktop')).not.toContain('телеграма');
    expect(await volatileText()).not.toContain('телеграма');
  });
});
