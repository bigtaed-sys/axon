import { randomUUID } from 'node:crypto';
import type {
  DevicePlatform,
  ContentPart,
  Message,
  PermissionRequest,
  Scope,
  Signal,
  StopReason,
  ToolCall,
  Usage,
} from '@axon/protocol';
import { logger } from '../logger.js';
import { decideRetry, sleep } from './retry.js';
import { ProviderError } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { Store } from '../storage/Store.js';
import type { ToolExecutor } from '../tools/ToolExecutor.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { BlobWriter } from '../tools/types.js';
import type { ContextBuilder } from './ContextBuilder.js';
import { denyAllBroker, isGranted, persistDecision, type PermissionBroker } from './permissions.js';
import { Vision } from './Vision.js';
import type { Summarizer } from './Summarizer.js';
import { TokenBudget } from './tokens.js';

/** Потолок цикла «модель → инструмент → модель». */
export const MAX_ITERATIONS = 12;
/** Сколько ждать ответа на запрос разрешения, прежде чем считать его протухшим. */
export const PERMISSION_TTL_MS = 5 * 60 * 1000;

/** Куда уходит эфемерика: дельты, фазы, счётчик расхода. */
export interface RunSink {
  emit(signal: Signal): void;
}

export interface OrchestratorDeps {
  store: Store;
  context: ContextBuilder;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  executor: ToolExecutor;
  sink: RunSink;
  summarizer?: Summarizer;
  permissions?: PermissionBroker;
  blobs?: BlobWriter;
  /** Кто описывает вложенные картинки. Не задан — картинки уходят как есть. */
  vision?: Vision;
}

export interface StartRunInput {
  conversationId: string;
  parts: ContentPart[];
  /** Права устройства, от имени которого идёт запрос. */
  scopes: Scope[];
  /** Откуда пришёл вопрос: от этого зависит, каким должен быть ответ. */
  platform?: DevicePlatform;
  /** Инструменты, разрешённые сверх прав устройства на этот прогон. */
  allowTools?: string[];
  /** Потолок расхода. `undefined` — взять из настроек, `null` — без потолка. */
  budgetTokens?: number | null;
}

export interface StartedRun {
  runId: string;
  message: Message;
}

/**
 * Оркестратор — цикл одного прогона агента.
 *
 * Что здесь сделано иначе, чем в старом проекте:
 *
 * - **Бюджет проверяется до вызова модели, а не после.** Агент, заметивший
 *   перерасход постфактум, уже потратил деньги.
 * - **Доступ к инструментам решают права, а не регулярка по тексту.** В старом
 *   коде computer-агент включался регуляркой на 200 символов, ищущей в
 *   сообщении «в режиме агента» — костыль, который заодно намертво прибивал
 *   продукт к русскому языку.
 * - **Эфемерика и журнал разведены.** Дельты уходят в sink и нигде не
 *   хранятся; в журнал попадают только факты, меняющие состояние.
 */
export class Orchestrator {
  private readonly active = new Map<string, AbortController>();
  private readonly permissions: PermissionBroker;

  constructor(private readonly deps: OrchestratorDeps) {
    this.permissions = deps.permissions ?? denyAllBroker;
  }

  /**
   * Записать сообщение пользователя и запустить прогон. Возвращает управление
   * сразу — дальше всё едет событиями и сигналами.
   */
  startRun(input: StartRunInput): StartedRun {
    const runId = randomUUID();
    const controller = new AbortController();
    this.active.set(runId, controller);

    const message = this.deps.store.appendMessage({
      conversationId: input.conversationId,
      role: 'user',
      parts: input.parts,
    });

    void this.describeImages(message, controller.signal)
      .then(() => this.run(runId, input, controller.signal))
      .catch((e) => {
        const error = e as Error;
        logger.error({ err: error.message, runId }, 'прогон упал');
        this.active.delete(runId);
        this.deps.store.transact(() => {
          this.deps.store.record({
            type: 'run.failed',
            runId,
            conversationId: input.conversationId,
            error: error.message,
          });
        });
      })
      .finally(() => {
        this.active.delete(runId);
      });

    return { runId, message };
  }

  /**
   * Описать вложенные картинки назначенной для этого моделью — до того, как
   * разговор попадёт в основную.
   *
   * Описание дописывается в само сообщение, поэтому остаётся в истории текстом
   * и считается один раз: картинка не переотправляется на каждом следующем
   * ходу. Если модель распознавания не назначена, шаг пропускается молча, и
   * вложение уходит в основную модель как есть.
   */
  private async describeImages(message: Message, signal: AbortSignal): Promise<void> {
    const vision = this.deps.vision;
    if (!vision || !Vision.needsDescription(message)) return;

    const parts = await vision.describe(message, signal);
    if (!parts) return;

    this.deps.store.amendMessage({ ...message, parts });
  }

  cancel(runId: string): boolean {
    const controller = this.active.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  isRunning(runId: string): boolean {
    return this.active.has(runId);
  }

  /**
   * Остановить всё. Вызывается при выключении: прогон, продолжающий писать в
   * уже закрытую базу, роняет процесс на выходе.
   */
  cancelAll(): void {
    for (const controller of this.active.values()) controller.abort();
  }

  // ─── Цикл ─────────────────────────────────────────────────────────────────

  private async run(runId: string, input: StartRunInput, signal: AbortSignal): Promise<void> {
    const { store, context, providers, tools, executor, sink } = this.deps;
    const conversationId = input.conversationId;

    const budget = new TokenBudget(
      input.budgetTokens === undefined
        ? (store.settings.get<number | null>('run.budgetTokens') ?? null)
        : input.budgetTokens,
    );

    store.transact(() => {
      store.record({
        type: 'run.started',
        runId,
        conversationId,
        budgetTokens: budget.total,
      });
    });

    const userText = textOf(input.parts);
    const totals = new UsageTotals();
    /**
     * Подсказка модели, которая живёт только внутри прогона и не попадает
     * в историю: незачем засорять журнал служебными репликами.
     */
    let transientNote: string | null = null;
    let hadToolCalls = false;
    let nudged = false;
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      if (signal.aborted) return this.finish(runId, conversationId, 'cancelled', totals, iterations);

      sink.emit({ type: 'run.phase', runId, phase: 'thinking' });

      const { provider, model } = providers.current();

      // Когда картинки распознаёт отдельная модель, их описания уже лежат в
      // истории текстом — слать в основную модель ещё и байты незачем: она
      // может их не принять, а если и примет, заплатим дважды за одно и то же.
      const built = await context.build({
        conversationId,
        userText,
        allowImages: !this.deps.vision?.enabled,
        ...(input.platform ? { platform: input.platform } : {}),
      });
      if (transientNote) {
        built.messages.push({ role: 'user', parts: [{ type: 'text', text: transientNote }] });
        transientNote = null;
      }

      // Гейт до вызова: если ожидаемого промпта уже не хватает — не звоним.
      if (budget.total !== null && budget.remaining < built.estimatedTokens) {
        return this.finish(runId, conversationId, 'budget_exhausted', totals, iterations);
      }

      const access = {
        scopes: input.scopes,
        ...(input.allowTools ? { allow: input.allowTools } : {}),
      };

      let text = '';
      const calls: ToolCall[] = [];
      let stopReason: StopReason = 'end_turn';

      /**
       * Обращение к модели с повтором.
       *
       * Повторяем только пока ничего не пришло: куски ответа уходят клиенту
       * сигналами по мере генерации, и вторая попытка после половины ответа
       * напечатала бы эту половину дважды. Правило и задержки — в `retry.ts`.
       */
      for (let attempt = 0; ; attempt += 1) {
      try {
        for await (const event of provider.chat({
          model,
          messages: built.messages,
          tools: tools.select(access),
          ...(store.settings.get<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('run.effort')
            ? { effort: store.settings.get<'low' | 'medium' | 'high' | 'xhigh' | 'max'>('run.effort')! }
            : {}),
          signal,
        })) {
          switch (event.type) {
            case 'text':
              text += event.delta;
              sink.emit({ type: 'run.delta', runId, text: event.delta });
              break;
            case 'thinking':
              // Ход рассуждений наружу не транслируем — только факт, что он идёт.
              break;
            case 'tool_call':
              calls.push(event.call);
              break;
            case 'usage':
              totals.add(event.usage);
              budget.spend(event.usage.inputTokens + event.usage.outputTokens);
              store.usage.record({
                runId,
                conversationId,
                usage: event.usage,
                at: new Date().toISOString(),
              });
              sink.emit({
                type: 'usage.tick',
                runId,
                usage: event.usage,
                budgetRemaining: budget.total === null ? null : budget.remaining,
              });
              break;
            case 'done':
              stopReason = toStopReason(event.stopReason);
              break;
          }
        }
        break;
      } catch (e) {
        if (signal.aborted || (e instanceof ProviderError && e.kind === 'cancelled')) {
          return this.finish(runId, conversationId, 'cancelled', totals, iterations);
        }

        const again = decideRetry(e, attempt, text === '' && calls.length === 0);
        if (!again) throw e;

        // Молчаливая пауза в восемь секунд неотличима от зависания, и человек
        // жмёт «стоп» ровно тогда, когда ядро само бы справилось.
        sink.emit({ type: 'run.phase', runId, phase: 'retrying', detail: again.reason });
        logger.warn(
          { err: (e as Error).message, attempt, waitMs: again.waitMs },
          'повтор обращения к модели',
        );

        await sleep(again.waitMs, signal);
      }
      }

      if (calls.length === 0) {
        // Защита от пустого ответа после инструмента: малые модели (Hermes,
        // Llama-3.1-Instruct, Qwen) регулярно замолкают, получив результат.
        // Один раз подталкиваем — дальше отдаём заглушку, чтобы пользователь
        // не смотрел в пустой пузырь.
        if (!text.trim() && hadToolCalls && !nudged) {
          nudged = true;
          transientNote =
            store.settings.get<string>('prompt.nudge') ??
            'Сформулируй ответ пользователю по результатам вызовов инструментов. ' +
              'Обычным текстом, без новых вызовов.';
          continue;
        }

        const content =
          text.trim() ||
          (hadToolCalls
            ? '(модель не сформировала ответ после инструмента — попробуй переспросить)'
            : '(пустой ответ модели)');

        store.appendMessage({
          conversationId,
          role: 'assistant',
          parts: [{ type: 'text', text: content }],
          ...(totals.isEmpty ? {} : { usage: totals.snapshot() }),
        });

        this.finish(runId, conversationId, stopReason, totals, iterations);
        void this.deps.summarizer?.maybeSummarize(conversationId);
        return;
      }

      hadToolCalls = true;
      const assistant = store.appendMessage({
        conversationId,
        role: 'assistant',
        parts: text ? [{ type: 'text', text }] : [],
        toolCalls: calls,
      });

      for (const call of calls) {
        if (signal.aborted) {
          return this.finish(runId, conversationId, 'cancelled', totals, iterations);
        }
        await this.runTool(runId, conversationId, call, access, signal, assistant.id);
      }
    }

    this.finish(runId, conversationId, 'max_iterations', totals, iterations);
  }

  private async runTool(
    runId: string,
    conversationId: string,
    call: ToolCall,
    access: { scopes: readonly Scope[]; allow?: readonly string[] },
    signal: AbortSignal,
    _assistantMessageId: string,
  ): Promise<void> {
    const { store, executor, sink } = this.deps;

    store.transact(() => {
      store.record({ type: 'tool_call.started', runId, conversationId, call });
    });
    sink.emit({ type: 'run.phase', runId, phase: 'calling_tool', detail: call.name });

    const result = await executor.execute({
      name: call.name,
      args: call.arguments,
      access,
      ctx: {
        conversationId,
        runId,
        signal,
        logger,
        requestPermission: (ask) => this.ask(runId, ask),
        ...(this.deps.blobs ? { blobs: this.deps.blobs } : {}),
      },
    });

    store.transact(() => {
      store.record({
        type: 'tool_call.finished',
        runId,
        conversationId,
        callId: call.id,
        result,
      });
    });

    store.appendMessage({
      conversationId,
      role: 'tool',
      toolCallId: call.id,
      parts: [{ type: 'text', text: result.ok ? result.preview : `Ошибка: ${result.error}` }],
    });
  }

  /**
   * Запрос разрешения: факт запроса и факт ответа — журнальные события, чтобы
   * любое устройство увидело их и могло ответить, а история осталась в логе.
   */
  private async ask(
    runId: string,
    ask: { toolName: string; tier: PermissionRequest['tier']; reason: string; arguments: Record<string, unknown> },
  ): Promise<boolean> {
    const { store, sink } = this.deps;

    const request: PermissionRequest = {
      id: randomUUID(),
      runId,
      toolName: ask.toolName,
      tier: ask.tier,
      reason: ask.reason,
      arguments: ask.arguments,
      expiresAt: new Date(Date.now() + PERMISSION_TTL_MS).toISOString(),
    };

    store.transact(() => store.record({ type: 'permission.requested', request }));
    sink.emit({ type: 'run.phase', runId, phase: 'awaiting_permission', detail: ask.toolName });

    const decision = await this.permissions.request(request);

    store.transact(() => {
      persistDecision(store, ask.toolName, decision);
      store.record({ type: 'permission.resolved', requestId: request.id, decision });
    });

    return isGranted(decision);
  }

  /**
   * Пометку «выполняется» снимаем здесь, а не в `finally` промиса: иначе между
   * событием `run.finished` и снятием пометки остаётся микротакт, в котором
   * `isRunning` отвечает «да» на уже завершённый прогон. Демон реагирует на
   * журнал, и такая щель ему видна. Повторное удаление в `finally` безвредно.
   */
  private finish(
    runId: string,
    conversationId: string,
    stopReason: StopReason,
    totals: UsageTotals,
    iterations: number,
  ): void {
    this.active.delete(runId);
    this.deps.store.transact(() => {
      this.deps.store.record({
        type: 'run.finished',
        runId,
        conversationId,
        stopReason,
        iterations,
        ...(totals.isEmpty ? {} : { usage: totals.snapshot() }),
      });
    });
  }
}

// ─── Вспомогательное ────────────────────────────────────────────────────────

/** Накопитель расхода за весь прогон, включая все итерации с инструментами. */
class UsageTotals {
  private input = 0;
  private cached = 0;
  private cacheWrite = 0;
  private output = 0;
  private cost = 0;
  private provider = '';
  private model = '';

  add(usage: Usage): void {
    this.input += usage.inputTokens;
    this.cached += usage.cachedInputTokens;
    this.cacheWrite += usage.cacheWriteTokens;
    this.output += usage.outputTokens;
    this.cost += usage.costUsd ?? 0;
    this.provider = usage.provider;
    this.model = usage.model;
  }

  get isEmpty(): boolean {
    return this.provider === '';
  }

  snapshot(): Usage {
    return {
      provider: this.provider,
      model: this.model,
      inputTokens: this.input,
      cachedInputTokens: this.cached,
      cacheWriteTokens: this.cacheWrite,
      outputTokens: this.output,
      costUsd: this.cost,
    };
  }
}

function toStopReason(reason: string): StopReason {
  switch (reason) {
    case 'refusal':
      return 'refusal';
    case 'max_tokens':
      return 'max_iterations';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'end_turn';
  }
}

function textOf(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
