import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Routine, RoutineStep } from '@axon/protocol';
import { createRuntime, defineTool, evaluate, fill, type Runtime } from '../src/index.js';
import { Executor } from '../src/routines/Executor.js';

/**
 * Исполнитель проверяется на настоящем рантайме: инструменты, память и
 * переписка — те же, что в обычной работе. Подменять их нечем, да и незачем:
 * смысл скомпилированной рутины в том, что она ходит теми же путями, что и
 * человек, только без него.
 */

let runtime: Runtime;
let executor: Executor;
let tmpDir: string;
/** Что вызывали инструменты — по этому видно, что шаги реально отработали. */
let calls: Array<{ tool: string; args: Record<string, unknown> }>;

function routineWith(steps: RoutineStep[], overrides: Partial<Routine> = {}): Routine {
  const now = new Date().toISOString();
  return {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    name: 'Тест',
    description: '',
    source: '',
    steps,
    schedule: { kind: 'manual' },
    enabled: true,
    budgetTokens: 20_000,
    allowTools: [],
    notify: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-steps-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
  calls = [];

  // Пара безобидных инструментов: один отвечает, другой падает.
  runtime.tools.register(
    defineTool({
      name: 'echo',
      title: 'Эхо',
      description: 'Возвращает переданный текст',
      tier: 'safe',
      source: 'test',
      schema: z.object({ text: z.string() }),
      async execute({ text }) {
        calls.push({ tool: 'echo', args: { text } });
        return { text };
      },
    }),
  );
  runtime.tools.register(
    defineTool({
      name: 'boom',
      title: 'Падает',
      description: 'Всегда ошибка',
      tier: 'safe',
      source: 'test',
      schema: z.object({}),
      async execute() {
        calls.push({ tool: 'boom', args: {} });
        throw new Error('так и было задумано');
      },
    }),
  );

  executor = new Executor({
    store: runtime.store,
    orchestrator: runtime.orchestrator,
    providers: runtime.providers,
    tools: runtime.tools,
    toolExecutor: runtime.executor,
    blobs: runtime.blobs,
  });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('подстановка и условия', () => {
  it('неизвестная переменная остаётся видимой, а не исчезает', () => {
    // Пустота на месте переменной выглядела бы как обрезанный текст, и понять,
    // что шаг сослался на несуществующее, было бы неоткуда.
    expect(fill('было ${a}, стало ${b}', { a: 'раз' })).toBe('было раз, стало ${b}');
  });

  it('условия сравнивают без оглядки на регистр', () => {
    expect(evaluate({ left: 'Привет', op: 'equals', right: 'привет' }, {})).toBe(true);
    expect(evaluate({ left: '${x}', op: 'contains', right: 'оши' }, { x: 'Ошибка' })).toBe(true);
    expect(evaluate({ left: '', op: 'empty' }, {})).toBe(true);
    expect(evaluate({ left: '7', op: 'greaterThan', right: '3' }, {})).toBe(true);
  });

  it('кривое регулярное выражение не роняет рутину', () => {
    expect(evaluate({ left: 'что-то', op: 'matches', right: '([' }, {})).toBe(false);
  });
});

describe('исполнение шагов', () => {
  it('переменные передаются от шага к шагу', async () => {
    const outcome = await executor.run(
      routineWith([
        { kind: 'set', name: 'кого', value: 'мир' },
        { kind: 'tool', tool: 'echo', args: { text: 'привет, ${кого}' }, outputVar: 'ответ' },
        { kind: 'message', text: 'Сказали: ${ответ}' },
      ]),
    );

    expect(outcome.status).toBe('ok');
    expect(calls[0]!.args['text']).toBe('привет, мир');

    const written = runtime.store.messages.recent(outcome.conversationId, 5);
    expect(JSON.stringify(written)).toContain('Сказали: привет, мир');
  });

  it('без обращений к модели прогон не стоит ничего', async () => {
    const outcome = await executor.run(
      routineWith([{ kind: 'tool', tool: 'echo', args: { text: 'раз' } }]),
    );

    // Ровно то, ради чего рутина компилируется заранее.
    expect(outcome.tokens).toBe(0);
    expect(outcome.summary).toContain('без обращений к модели');
  });

  it('ветвление выбирает нужную сторону', async () => {
    const outcome = await executor.run(
      routineWith([
        { kind: 'set', name: 'состояние', value: 'ошибка сборки' },
        {
          kind: 'if',
          condition: { left: '${состояние}', op: 'contains', right: 'ошибка' },
          then: [{ kind: 'tool', tool: 'echo', args: { text: 'разбираемся' } }],
          otherwise: [{ kind: 'tool', tool: 'echo', args: { text: 'всё хорошо' } }],
        },
      ]),
    );

    expect(outcome.status).toBe('ok');
    expect(calls.map((c) => c.args['text'])).toEqual(['разбираемся']);
  });

  it('повтор идёт по строкам и уважает потолок', async () => {
    const outcome = await executor.run(
      routineWith([
        { kind: 'set', name: 'список', value: 'а\nб\nв\nг' },
        {
          kind: 'foreach',
          source: '${список}',
          limit: 2,
          steps: [{ kind: 'tool', tool: 'echo', args: { text: '${index}:${item}' } }],
        },
      ]),
    );

    expect(outcome.status).toBe('ok');
    expect(calls.map((c) => c.args['text'])).toEqual(['1:а', '2:б']);
  });

  it('повтор понимает и массив JSON', async () => {
    await executor.run(
      routineWith([
        { kind: 'set', name: 'список', value: '["раз","два"]' },
        {
          kind: 'foreach',
          source: '${список}',
          steps: [{ kind: 'tool', tool: 'echo', args: { text: '${item}' } }],
        },
      ]),
    );

    expect(calls.map((c) => c.args['text'])).toEqual(['раз', 'два']);
  });

  it('шаг stop заканчивает прогон без ошибки', async () => {
    const outcome = await executor.run(
      routineWith([
        {
          kind: 'if',
          condition: { left: '', op: 'empty' },
          then: [{ kind: 'stop', reason: 'сообщать не о чем' }],
        },
        { kind: 'tool', tool: 'echo', args: { text: 'сюда не дойдём' } },
      ]),
    );

    // Не «упало», а «не о чем говорить» — разница видна в списке рутин.
    expect(outcome.status).toBe('skipped');
    expect(outcome.summary).toBe('сообщать не о чем');
    expect(calls).toHaveLength(0);
  });

  it('упавший шаг останавливает рутину и попадает в след', async () => {
    const outcome = await executor.run(
      routineWith([
        { kind: 'tool', tool: 'boom', args: {} },
        { kind: 'tool', tool: 'echo', args: { text: 'после падения' } },
      ]),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.steps[0]!.ok).toBe(false);
    expect(outcome.steps[0]!.error).toContain('так и было задумано');
    expect(calls.map((c) => c.tool)).toEqual(['boom']);
  });

  it('continueOnError пропускает падение и идёт дальше', async () => {
    const outcome = await executor.run(
      routineWith([
        { kind: 'tool', tool: 'boom', args: {}, continueOnError: true },
        { kind: 'tool', tool: 'echo', args: { text: 'всё равно работаем' } },
      ]),
    );

    expect(outcome.status).toBe('ok');
    expect(calls.map((c) => c.tool)).toEqual(['boom', 'echo']);
  });

  it('опасный инструмент в фоне не выполняется без разрешения', async () => {
    runtime.tools.register(
      defineTool({
        name: 'опасный',
        title: 'Опасный',
        description: 'Требует подтверждения',
        tier: 'dangerous',
        source: 'test',
        schema: z.object({}),
        async execute() {
          calls.push({ tool: 'опасный', args: {} });
          return { text: 'выполнено' };
        },
      }),
    );

    const outcome = await executor.run(
      routineWith([{ kind: 'tool', tool: 'опасный', args: {} }]),
    );

    // Рядом нет человека, который подтвердит, — и подтверждать молча нельзя.
    expect(outcome.status).toBe('failed');
    expect(calls).toHaveLength(0);
  });

  it('разрешённый поимённо опасный инструмент выполняется', async () => {
    runtime.tools.register(
      defineTool({
        name: 'разрешённый',
        title: 'Разрешённый',
        description: 'Опасный, но одобренный',
        tier: 'dangerous',
        source: 'test',
        schema: z.object({}),
        async execute() {
          calls.push({ tool: 'разрешённый', args: {} });
          return { text: 'выполнено' };
        },
      }),
    );

    const outcome = await executor.run(
      routineWith([{ kind: 'tool', tool: 'разрешённый', args: {} }], {
        allowTools: ['разрешённый'],
      }),
    );

    expect(outcome.status).toBe('ok');
    expect(calls.map((c) => c.tool)).toEqual(['разрешённый']);
  });

  it('шаг remember пишет в долговременную память', async () => {
    await executor.run(
      routineWith([{ kind: 'remember', key: 'любимый чай', value: 'улун' }]),
    );

    expect(runtime.store.facts.byKey('любимый чай')?.value).toBe('улун');
  });

  it('уведомление уходит журнальным событием', async () => {
    const seen: string[] = [];
    runtime.store.journal.subscribe((entry) => {
      if (entry.event.type === 'routine.notified') seen.push(entry.event.title);
    });

    await executor.run(routineWith([{ kind: 'notify', title: 'Готово: ${routine}' }]));

    // У ядра нет экрана: показать должен клиент, а событие переживёт и то,
    // что в момент прогона никого не было на связи.
    expect(seen).toEqual(['Готово: Тест']);
  });

  it('след пишется по каждому шагу, включая вложенные', async () => {
    const outcome = await executor.run(
      routineWith([
        { kind: 'set', name: 'x', value: '1' },
        {
          kind: 'if',
          condition: { left: '${x}', op: 'equals', right: '1' },
          then: [{ kind: 'tool', tool: 'echo', args: { text: 'внутри' } }],
        },
      ]),
    );

    const paths = outcome.steps.map((step) => step.path);
    // «1.0» — первый шаг внутри второго: по такому пути видно, где именно
    // рутина сломалась, а не только что она сломалась.
    expect(paths).toContain('1.0');
    expect(outcome.steps.every((step) => step.ok)).toBe(true);
  });
});
