import { z } from 'zod';
import { zRoutineStep, zSchedule, type RoutineStep, type Schedule } from '@axon/protocol';
import { logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';

/**
 * Превращение описания словами в список шагов.
 *
 * Компиляция происходит один раз, при создании рутины, — в этом вся суть.
 * Дальше рутина исполняется без модели, если шаги того не требуют, и стоит
 * почти ничего даже при запуске каждые полчаса.
 *
 * Второе назначение компилятора не менее важно: он **проверяет результат по
 * настоящим схемам инструментов**. Модель регулярно придумывает имена
 * аргументов — пишет `app` там, где параметр называется `target`. Без сверки
 * человек узнал бы об этом на первом ночном прогоне; со сверкой — сразу, с
 * внятным текстом, что именно не так.
 */

const RESULT = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  schedule: zSchedule,
  steps: z.array(zRoutineStep).max(60),
});

export interface CompiledRoutine {
  name: string;
  description: string;
  schedule: Schedule;
  steps: RoutineStep[];
  warnings: string[];
}

export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

export interface CompilerDeps {
  providers: ProviderRegistry;
  tools: ToolRegistry;
}

export class Compiler {
  constructor(private readonly deps: CompilerDeps) {}

  async compile(source: string, allowTools: string[] = []): Promise<CompiledRoutine> {
    const catalog = this.catalog(allowTools);
    const raw = await this.ask(source, catalog);

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      logger.warn({ raw: raw.slice(0, 300) }, 'компилятор рутины вернул не JSON');
      throw new CompileError(
        'Модель вернула не JSON. Попробуйте описать задачу проще или другими словами.',
      );
    }

    const checked = RESULT.safeParse(parsed);
    if (!checked.success) {
      throw new CompileError(
        `Сценарий не соответствует схеме: ${checked.error.issues
          .map((issue) => `${issue.path.join('.') || '(корень)'} — ${issue.message}`)
          .slice(0, 5)
          .join('; ')}`,
      );
    }

    const problems = this.verify(checked.data.steps, allowTools, '');
    if (problems.length > 0) {
      throw new CompileError(
        `Сценарий собран, но шаги неверные:\n${problems.slice(0, 8).join('\n')}\n\n` +
          'Переформулируйте задачу или соберите заново.',
      );
    }

    return {
      name: checked.data.name,
      description: checked.data.description,
      schedule: checked.data.schedule,
      steps: checked.data.steps,
      warnings: this.advise(checked.data.steps, ''),
    };
  }

  // ─── Проверка ─────────────────────────────────────────────────────────────

  /**
   * Сверка шагов с реальностью: существует ли инструмент, все ли обязательные
   * аргументы на месте, нет ли выдуманных. Ошибки здесь останавливают
   * компиляцию — рутина с несуществующим инструментом бесполезна.
   */
  private verify(steps: RoutineStep[], allowTools: string[], prefix: string): string[] {
    const problems: string[] = [];

    steps.forEach((step, index) => {
      const at = `Шаг ${prefix}${index + 1}`;

      if (step.kind === 'if') {
        problems.push(...this.verify(step.then, allowTools, `${prefix}${index + 1}.`));
        problems.push(...this.verify(step.otherwise ?? [], allowTools, `${prefix}${index + 1}.`));
        return;
      }
      if (step.kind === 'foreach') {
        problems.push(...this.verify(step.steps, allowTools, `${prefix}${index + 1}.`));
        return;
      }
      if (step.kind !== 'tool') return;

      const tool = this.deps.tools.get(step.tool);
      if (!tool) {
        problems.push(`${at}: инструмента «${step.tool}» не существует`);
        return;
      }

      const info = this.deps.tools.info(step.tool);
      const schema = (info?.parameters ?? {}) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const known = Object.keys(schema.properties ?? {});
      const given = Object.keys(step.args);

      const missing = (schema.required ?? []).filter((name) => !(name in step.args));
      if (missing.length > 0) {
        problems.push(`${at} (${step.tool}): не заполнено обязательное — ${missing.join(', ')}`);
      }

      const extra = known.length > 0 ? given.filter((name) => !known.includes(name)) : [];
      if (extra.length > 0) {
        problems.push(
          `${at} (${step.tool}): нет таких аргументов — ${extra.join(', ')}; ` +
            `ожидаются: ${known.join(', ')}`,
        );
      }

      // Небезопасный инструмент, не разрешённый явно, в фоне не выполнится:
      // подтвердить его будет некому. Лучше сказать это при сборке.
      if (tool.tier !== 'safe' && !allowTools.includes(step.tool)) {
        problems.push(
          `${at} (${step.tool}): инструмент требует разрешения, а рядом с рутиной ` +
            'человека нет. Разрешите его в настройках рутины или уберите шаг.',
        );
      }
    });

    return problems;
  }

  /**
   * Замечания, не мешающие работе: то, о чём стоит знать, но что не повод
   * отказывать в сборке.
   */
  private advise(steps: RoutineStep[], prefix: string): string[] {
    const notes: string[] = [];

    steps.forEach((step, index) => {
      const at = `Шаг ${prefix}${index + 1}`;
      if (step.kind === 'agent') {
        notes.push(
          `${at}: агентский шаг — самый дорогой. Если задачу можно разложить на ` +
            'вызовы инструментов, рутина станет заметно дешевле.',
        );
      }
      if (step.kind === 'wait' && step.seconds > 300) {
        notes.push(`${at}: ожидание ${step.seconds} с — рутина всё это время занята.`);
      }
      if (step.kind === 'if') {
        notes.push(...this.advise(step.then, `${prefix}${index + 1}.`));
        notes.push(...this.advise(step.otherwise ?? [], `${prefix}${index + 1}.`));
      }
      if (step.kind === 'foreach') {
        notes.push(...this.advise(step.steps, `${prefix}${index + 1}.`));
      }
    });

    return notes;
  }

  // ─── Обращение к модели ───────────────────────────────────────────────────

  private catalog(allowTools: string[]): string {
    return this.deps.tools
      .list()
      .filter((tool) => tool.enabled)
      .filter((tool) => tool.tier === 'safe' || allowTools.includes(tool.name))
      .map(
        (tool) =>
          `### ${tool.name}\n${tool.description}\nАргументы (JSON Schema): ${JSON.stringify(
            tool.parameters,
          )}`,
      )
      .join('\n\n');
  }

  private async ask(source: string, catalog: string): Promise<string> {
    const { provider, model } = this.deps.providers.current();

    let text = '';
    for await (const event of provider.chat({
      model,
      messages: [
        { role: 'system', parts: [{ type: 'text', text: `${SYSTEM}\n\n${SCHEMA}` }] },
        {
          role: 'system',
          parts: [
            {
              type: 'text',
              text:
                '=== Доступные инструменты. Используй только эти имена и только ' +
                `перечисленные ключи аргументов ===\n\n${catalog || '(инструментов нет)'}`,
            },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: source }] },
      ],
      maxTokens: 3000,
    })) {
      if (event.type === 'text') text += event.delta;
    }

    return text.trim();
  }
}

const SYSTEM = `Ты превращаешь описание задачи на человеческом языке в сценарий автоматизации Axon.

Отвечай ТОЛЬКО объектом JSON: без разметки, без пояснений, без текста вокруг.

Правила, которые важнее краткости:
- Обращение к модели стоит денег, а рутина работает по расписанию. Поэтому
  предпочитай шаги "tool" — они бесплатны. Шаг "agent" бери только там, где
  нужно решение по обстановке, которое нельзя расписать заранее.
- Если задача не требует сообщать результат — не добавляй "notify" и "message".
  Рутина, которая будит человека без повода, будет выключена в первый же день.
- Если сообщать не о чем, лучше остановиться шагом "stop" внутри "if", чем
  прислать пустое уведомление.
- Не выдумывай инструменты и аргументы. Если нужного инструмента нет, используй
  шаг "agent" с описанием задачи словами.`;

const SCHEMA = `Формат ответа:

{
  "name": "короткое имя, до 60 символов",
  "description": "что делает рутина, одной фразой",
  "schedule": { … },
  "steps": [ … ]
}

Расписание — одно из:
  { "kind": "daily", "time": "09:00" }
  { "kind": "weekly", "days": [1,2,3,4,5], "time": "09:00" }   // 0 — воскресенье
  { "kind": "interval", "everyMinutes": 30 }                    // не меньше 5
  { "kind": "once", "at": "2026-08-21T09:00:00.000Z" }
  { "kind": "manual" }                                          // только вручную

Шаги:
  { "kind": "tool", "tool": "имя", "args": { … }, "outputVar": "имя", "continueOnError": false }
  { "kind": "prompt", "prompt": "вопрос модели", "outputVar": "имя" }
  { "kind": "extract", "from": "\${текст}", "fields": [{ "name": "поле", "description": "что это" }] }
  { "kind": "agent", "task": "задача словами", "budgetTokens": 20000, "outputVar": "имя" }
  { "kind": "if", "condition": { "left": "\${x}", "op": "contains", "right": "что-то" },
    "then": [ … ], "otherwise": [ … ] }
  { "kind": "foreach", "source": "\${список}", "steps": [ … ], "limit": 20 }
  { "kind": "set", "name": "имя", "value": "текст с \${подстановками}" }
  { "kind": "notify", "title": "заголовок", "body": "текст" }
  { "kind": "message", "text": "что записать в переписку рутины" }
  { "kind": "remember", "key": "ключ", "value": "значение" }
  { "kind": "wait", "seconds": 30 }
  { "kind": "stop", "reason": "почему остановились" }

Операции условия: equals, notEquals, contains, notContains, matches,
empty, notEmpty, greaterThan, lessThan.

Переменные подставляются как \${имя}. Доступны всегда: \${last} — результат
предыдущего шага, \${now}, \${date}, \${time}, \${routine}. Внутри "foreach"
доступны \${item} и \${index}.`;

/** Достать JSON из ответа, даже если модель обернула его в разметку. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();

  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate;
}
