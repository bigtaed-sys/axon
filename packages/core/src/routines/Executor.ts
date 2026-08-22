import { randomUUID } from 'node:crypto';
import type {
  Condition,
  Routine,
  RoutineStep,
  RoutineStatus,
  Scope,
  StepLog,
} from '@axon/protocol';
import { logger } from '../logger.js';
import type { Orchestrator } from '../agent/Orchestrator.js';
import { estimateTokens } from '../agent/tokens.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { Store } from '../storage/Store.js';
import type { ToolExecutor } from '../tools/ToolExecutor.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { BlobWriter } from '../tools/types.js';

/**
 * Права фонового прогона.
 *
 * Рядом нет человека, который подтвердит опасное действие, а подтверждать его
 * молча нельзя. Поэтому по умолчанию только безопасные инструменты; всё
 * остальное рутина получает поимённо, по явному решению пользователя.
 */
const ROUTINE_SCOPES: Scope[] = ['chat.read', 'chat.write', 'tools.safe'];

/** Сколько символов вывода шага хранить в логе. Лог — след, а не архив. */
const LOG_LIMIT = 1_500;

/** Потолок повторов в `foreach`, если шаг его не задал. */
const DEFAULT_FOREACH_LIMIT = 50;

export interface ExecutorDeps {
  store: Store;
  orchestrator: Orchestrator;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  toolExecutor: ToolExecutor;
  blobs?: BlobWriter;
}

export interface RunOutcome {
  status: RoutineStatus;
  summary: string;
  steps: StepLog[];
  tokens: number;
  conversationId: string;
}

/** Досрочное завершение шагом `stop` — не ошибка, а решение рутины. */
class Stopped extends Error {}

/**
 * Исполнитель рутины: проходит шаги по порядку, ведёт переменные и пишет след.
 *
 * Главное свойство — предсказуемость. Модель зовётся только там, где шаг этого
 * прямо просит (`prompt`, `extract`, `agent`); всё остальное — обычные вызовы
 * инструментов и работа со строками. Поэтому рутина «каждые полчаса» стоит
 * почти ничего, в отличие от полного цикла агента на каждом прогоне.
 */
export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  async run(
    routine: Routine,
    options: { signal?: AbortSignal } = {},
  ): Promise<RunOutcome> {
    const conversationId = this.conversationFor(routine);
    const context: RunContext = {
      routine,
      conversationId,
      vars: {
        routine: routine.name,
        now: new Date().toLocaleString('ru-RU'),
        date: new Date().toLocaleDateString('ru-RU'),
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
      },
      steps: [],
      tokens: 0,
      budget: routine.budgetTokens,
      ...(options.signal ? { signal: options.signal } : {}),
    };

    let status: RoutineStatus = 'ok';
    let summary = '';

    try {
      await this.runSteps(routine.steps, context, '');
      summary = this.summarize(context);
    } catch (error) {
      if (error instanceof Stopped) {
        status = 'skipped';
        summary = error.message || 'Остановлено рутиной';
      } else {
        status = 'failed';
        summary = (error as Error).message;
        logger.warn({ routine: routine.id, err: summary }, 'рутина упала');
      }
    }

    return { status, summary, steps: context.steps, tokens: context.tokens, conversationId };
  }

  // ─── Обход шагов ──────────────────────────────────────────────────────────

  private async runSteps(steps: RoutineStep[], ctx: RunContext, prefix: string): Promise<void> {
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index]!;
      const path = prefix ? `${prefix}.${index}` : String(index);

      if (ctx.signal?.aborted) throw new Error('Прогон отменён');
      if (ctx.tokens > ctx.budget) {
        throw new Error(`Исчерпан бюджет: ${ctx.tokens} из ${ctx.budget} токенов`);
      }

      const startedAt = Date.now();
      const before = ctx.tokens;

      try {
        const output = await this.runStep(step, ctx, path);
        ctx.steps.push({
          path,
          kind: step.kind,
          ok: true,
          ...(output ? { output: cut(output) } : {}),
          durationMs: Date.now() - startedAt,
          tokens: ctx.tokens - before,
        });
      } catch (error) {
        // Досрочная остановка — не отказ: она должна пролететь наверх целиком.
        if (error instanceof Stopped) throw error;

        const message = (error as Error).message;
        ctx.steps.push({
          path,
          kind: step.kind,
          ok: false,
          error: message,
          durationMs: Date.now() - startedAt,
          tokens: ctx.tokens - before,
        });

        const forgiving = step.kind === 'tool' && step.continueOnError;
        if (!forgiving) throw new Error(`Шаг ${Number(path.split('.')[0]) + 1} (${step.kind}): ${message}`);
      }
    }
  }

  private async runStep(step: RoutineStep, ctx: RunContext, path: string): Promise<string> {
    switch (step.kind) {
      case 'tool':
        return await this.stepTool(step, ctx);
      case 'prompt':
        return await this.stepPrompt(step, ctx);
      case 'extract':
        return await this.stepExtract(step, ctx);
      case 'agent':
        return await this.stepAgent(step, ctx);

      case 'if': {
        const matched = evaluate(step.condition, ctx.vars);
        const branch = matched ? step.then : (step.otherwise ?? []);
        await this.runSteps(branch, ctx, path);
        return matched ? 'да' : 'нет';
      }

      case 'foreach': {
        const items = toList(fill(step.source, ctx.vars));
        const limit = Math.min(step.limit ?? DEFAULT_FOREACH_LIMIT, items.length);

        for (let index = 0; index < limit; index++) {
          ctx.vars['item'] = items[index]!;
          ctx.vars['index'] = String(index + 1);
          await this.runSteps(step.steps, ctx, `${path}.${index}`);
        }
        delete ctx.vars['item'];
        delete ctx.vars['index'];

        return items.length > limit
          ? `обработано ${limit} из ${items.length}`
          : `обработано ${limit}`;
      }

      case 'set': {
        const value = fill(step.value, ctx.vars);
        ctx.vars[step.name] = value;
        return value;
      }

      case 'notify': {
        // Уведомление — журнальное событие: показать его должен тот клиент,
        // который сейчас на связи, а не ядро, у которого экрана нет.
        this.deps.store.transact(() => {
          this.deps.store.record({
            type: 'routine.notified',
            routineId: ctx.routine.id,
            title: fill(step.title, ctx.vars),
            ...(step.body ? { body: fill(step.body, ctx.vars) } : {}),
          });
        });
        return fill(step.title, ctx.vars);
      }

      case 'message': {
        const text = fill(step.text, ctx.vars);
        this.deps.store.appendMessage({
          conversationId: ctx.conversationId,
          role: 'assistant',
          parts: [{ type: 'text', text }],
        });
        return text;
      }

      case 'remember': {
        const key = fill(step.key, ctx.vars);
        const value = fill(step.value, ctx.vars);
        this.deps.store.upsertFact(key, value, 'inferred');
        return `${key}: ${value}`;
      }

      case 'wait': {
        await new Promise((resolve) => setTimeout(resolve, step.seconds * 1000));
        return `${step.seconds} с`;
      }

      case 'stop':
        throw new Stopped(step.reason ? fill(step.reason, ctx.vars) : '');
    }
  }

  // ─── Шаги, обращающиеся наружу ────────────────────────────────────────────

  private async stepTool(
    step: Extract<RoutineStep, { kind: 'tool' }>,
    ctx: RunContext,
  ): Promise<string> {
    const tool = this.deps.tools.get(step.tool);
    if (!tool) throw new Error(`инструмент ${step.tool} не найден`);

    const result = await this.deps.toolExecutor.execute({
      name: step.tool,
      args: fillDeep(step.args, ctx.vars),
      ctx: {
        conversationId: ctx.conversationId,
        runId: randomUUID(),
        signal: ctx.signal ?? new AbortController().signal,
        logger,
        /**
         * Спросить в фоне некого, поэтому решение принято заранее: список
         * `allowTools` — это и есть согласие человека, данное при настройке
         * рутины. Всё остальное отказывает.
         *
         * Без этого поле было бы бесполезным ровно там, ради чего заведено:
         * инструмент проходил бы проверку прав и упирался в запрос
         * подтверждения, которого никто не увидит.
         */
        requestPermission: async (ask) => ctx.routine.allowTools.includes(ask.toolName),
        ...(this.deps.blobs ? { blobs: this.deps.blobs } : {}),
      },
      access: { scopes: ROUTINE_SCOPES, allow: ctx.routine.allowTools },
    });

    if (!result.ok) throw new Error(result.error);

    const output = result.preview;
    ctx.vars['last'] = output;
    if (step.outputVar) ctx.vars[step.outputVar] = output;
    return output;
  }

  private async stepPrompt(
    step: Extract<RoutineStep, { kind: 'prompt' }>,
    ctx: RunContext,
  ): Promise<string> {
    const prompt = fill(step.prompt, ctx.vars);
    const answer = await this.ask(prompt, ctx, step.maxTokens ?? 800);

    ctx.vars['last'] = answer;
    if (step.outputVar) ctx.vars[step.outputVar] = answer;
    return answer;
  }

  private async stepExtract(
    step: Extract<RoutineStep, { kind: 'extract' }>,
    ctx: RunContext,
  ): Promise<string> {
    const source = fill(step.from, ctx.vars);
    const fields = step.fields.map((field) => `- ${field.name}: ${field.description}`).join('\n');

    const answer = await this.ask(
      `Извлеки из текста значения полей и верни только JSON-объект с этими ключами. ` +
        `Если значения нет — пустая строка.\n\nПоля:\n${fields}\n\nТекст:\n${source}`,
      ctx,
      600,
    );

    const parsed = parseJsonObject(answer);
    if (!parsed) throw new Error('модель вернула не JSON');

    // Каждое поле становится отдельной переменной — по ним можно ветвиться,
    // ради чего этот шаг и отличается от обычного вопроса модели.
    for (const field of step.fields) {
      ctx.vars[field.name] = String(parsed[field.name] ?? '');
    }
    const json = JSON.stringify(parsed);
    if (step.outputVar) ctx.vars[step.outputVar] = json;
    return json;
  }

  /**
   * Шаг с полноценным агентом — там, где нужно решение по обстановке.
   *
   * Идёт обычным прогоном оркестратора, поэтому у него есть всё: инструменты,
   * бюджет, запись в журнал. Дорогой, поэтому и существует отдельным шагом, а
   * не режимом всей рутины.
   */
  private async stepAgent(
    step: Extract<RoutineStep, { kind: 'agent' }>,
    ctx: RunContext,
  ): Promise<string> {
    const task = fill(step.task, ctx.vars);
    const budget = Math.min(step.budgetTokens ?? ctx.budget, ctx.budget - ctx.tokens);
    if (budget <= 0) throw new Error('на агентский шаг не осталось бюджета');

    const { runId } = this.deps.orchestrator.startRun({
      conversationId: ctx.conversationId,
      parts: [{ type: 'text', text: task }],
      scopes: ROUTINE_SCOPES,
      allowTools: [...ctx.routine.allowTools, ...(step.allowTools ?? [])],
      budgetTokens: budget,
    });

    const outcome = await this.awaitRun(runId);
    ctx.tokens += outcome.tokens;

    if (!outcome.ok) throw new Error(outcome.summary);

    ctx.vars['last'] = outcome.text;
    if (step.outputVar) ctx.vars[step.outputVar] = outcome.text;
    return outcome.text;
  }

  /** Один вопрос модели без инструментов и без истории. */
  private async ask(prompt: string, ctx: RunContext, maxTokens: number): Promise<string> {
    const { provider, model } = this.deps.providers.current();

    let text = '';
    for await (const event of provider.chat({
      model,
      messages: [
        {
          role: 'system',
          parts: [
            {
              type: 'text',
              text: 'Ты выполняешь шаг автоматической рутины. Отвечай по существу, без вступлений и без выводов.',
            },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: prompt }] },
      ],
      maxTokens,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })) {
      if (event.type === 'text') text += event.delta;
      else if (event.type === 'usage') {
        ctx.tokens += event.usage.inputTokens + event.usage.outputTokens;
      }
    }

    // Провайдер мог не прислать расход — тогда считаем оценкой, иначе бюджет
    // окажется бесконечным именно там, где он и нужен.
    if (ctx.tokens === 0) ctx.tokens += estimateTokens(prompt) + estimateTokens(text);

    return text.trim();
  }

  /**
   * Дождаться конца агентского прогона, слушая журнал.
   *
   * Слушаем тот же журнал, что и клиенты: отдельного канала «для рутин»,
   * который однажды разойдётся с настоящим, здесь нет.
   */
  private awaitRun(
    runId: string,
  ): Promise<{ ok: boolean; text: string; tokens: number; summary: string }> {
    return new Promise((resolve) => {
      let text = '';

      const unsubscribe = this.deps.store.journal.subscribe((entry) => {
        const event = entry.event;

        if (event.type === 'message.created' && event.message.role === 'assistant') {
          const said = event.message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          if (said) text = said;
          return;
        }

        if (event.type === 'run.failed' && event.runId === runId) {
          unsubscribe();
          resolve({ ok: false, text: '', tokens: 0, summary: event.error });
          return;
        }

        if (event.type === 'run.finished' && event.runId === runId) {
          unsubscribe();
          const tokens = event.usage
            ? event.usage.inputTokens + event.usage.outputTokens
            : 0;
          resolve({
            ok: event.stopReason === 'end_turn',
            text,
            tokens,
            summary: `агент остановился: ${event.stopReason}`,
          });
        }
      });
    });
  }

  // ─── Вспомогательное ──────────────────────────────────────────────────────

  private conversationFor(routine: Routine): string {
    if (routine.conversationId && this.deps.store.conversations.get(routine.conversationId)) {
      return routine.conversationId;
    }
    return this.deps.store.createConversation(`⏰ ${routine.name}`).id;
  }

  /** Итог для списка: что сделано и во что обошлось. */
  private summarize(ctx: RunContext): string {
    const done = ctx.steps.filter((step) => step.ok).length;
    const spent = ctx.tokens > 0 ? `, ${ctx.tokens} токенов` : ' без обращений к модели';
    return `Готово: ${done} ${plural(done, 'шаг', 'шага', 'шагов')}${spent}`;
  }
}

interface RunContext {
  routine: Routine;
  conversationId: string;
  vars: Record<string, string>;
  steps: StepLog[];
  tokens: number;
  budget: number;
  signal?: AbortSignal;
}

// ─── Переменные и условия ───────────────────────────────────────────────────

/**
 * Подстановка `${имя}`.
 *
 * Неизвестное имя остаётся как есть, а не превращается в пустоту: в логе сразу
 * видно, что шаг сослался на переменную, которой нет, — вместо загадочно
 * усечённого текста.
 */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(VARIABLE, (match, name: string) =>
    name in vars ? vars[name]! : match,
  );
}

/**
 * Имя переменной.
 *
 * Буквы любые, а не только латинские: компилятор получает задачу по-русски и
 * называет переменные так же — `${состояние}`, `${список}`. Латинский алфавит
 * здесь означал бы, что половина собранных сценариев молча не подставляет
 * значения.
 */
const VARIABLE = /\$\{(\p{L}[\p{L}\p{N}_]*)\}/gu;

/** То же по всей структуре аргументов инструмента. */
function fillDeep(value: unknown, vars: Record<string, string>): Record<string, unknown> {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return fill(node, vars);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, walk(item)]));
    }
    return node;
  };
  return walk(value) as Record<string, unknown>;
}

/** Проверка условия шага `if`. */
export function evaluate(condition: Condition, vars: Record<string, string>): boolean {
  const left = fill(condition.left, vars).trim();
  const right = condition.right ? fill(condition.right, vars).trim() : '';

  switch (condition.op) {
    case 'equals':
      return left.toLowerCase() === right.toLowerCase();
    case 'notEquals':
      return left.toLowerCase() !== right.toLowerCase();
    case 'contains':
      return left.toLowerCase().includes(right.toLowerCase());
    case 'notContains':
      return !left.toLowerCase().includes(right.toLowerCase());
    case 'matches':
      try {
        return new RegExp(right, 'i').test(left);
      } catch {
        // Кривое выражение — не совпадение, а не падение всей рутины.
        return false;
      }
    case 'empty':
      return left.length === 0;
    case 'notEmpty':
      return left.length > 0;
    case 'greaterThan':
      return Number(left) > Number(right);
    case 'lessThan':
      return Number(left) < Number(right);
  }
}

/**
 * Список для `foreach`: массив JSON, если текст им является, иначе строки.
 * Второе — самый частый случай: вывод инструмента почти всегда построчный.
 */
function toList(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown[];
      if (Array.isArray(parsed)) {
        return parsed.map((item) =>
          typeof item === 'string' ? item : JSON.stringify(item),
        );
      }
    } catch {
      // Не JSON — разберём построчно.
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Достать объект JSON из ответа модели, даже если она обернула его в разметку. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1]! : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cut(text: string): string {
  return text.length <= LOG_LIMIT ? text : `${text.slice(0, LOG_LIMIT)}…`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
