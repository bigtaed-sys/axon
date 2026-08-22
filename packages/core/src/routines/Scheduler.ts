import { randomUUID } from 'node:crypto';
import type { Routine, RoutineRun } from '@axon/protocol';
import { logger } from '../logger.js';
import type { Store } from '../storage/Store.js';
import type { Compiler } from './Compiler.js';
import type { Executor } from './Executor.js';
import { nextRun } from './schedule.js';

/** Как часто смотреть, не пора ли кого-то запускать. */
const TICK_MS = 30_000;

export interface SchedulerDeps {
  store: Store;
  executor: Executor;
  compiler: Compiler;
  /** Сообщить клиентам, что рутина отработала. */
  onFinished?(routine: Routine, run: RoutineRun): void;
}

export class RoutineError extends Error {
  constructor(
    message: string,
    readonly code: string = 'routine_error',
  ) {
    super(message);
    this.name = 'RoutineError';
  }
}

/**
 * Планировщик рутин.
 *
 * Устроен как опрос базы раз в полминуты, а не как набор таймеров. Разница
 * важна для продукта, который стоит на личной машине: её выключают, усыпляют и
 * обновляют. Таймер в памяти этого не переживает — а запись «следующий запуск в
 * 9:00» переживает, и проснувшееся ядро видит, что момент прошёл, и
 * отрабатывает. Тот же механизм чинит пропущенное после падения.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  /** Рутины, прогон которых идёт: второй запуск поверх первого не нужен. */
  private readonly running = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;

    // Пересчитываем расписание при старте: пока ядро не работало, время могло
    // уйти далеко вперёд, а у разовых рутин — вообще истечь.
    this.plan();

    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ─── Чтение ───────────────────────────────────────────────────────────────

  list(): Routine[] {
    return this.deps.store.routines.list();
  }

  runs(routineId: string, limit: number): RoutineRun[] {
    return this.deps.store.routines.runs(routineId, limit);
  }

  compile(source: string, allowTools: string[]) {
    return this.deps.compiler.compile(source, allowTools);
  }

  // ─── Изменения ────────────────────────────────────────────────────────────

  create(input: {
    name: string;
    description: string;
    source: string;
    steps: Routine['steps'];
    schedule: Routine['schedule'];
    budgetTokens: number;
    allowTools: string[];
    notify: boolean;
  }): Routine {
    const now = new Date().toISOString();
    const next = nextRun(input.schedule);

    const routine: Routine = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      source: input.source,
      steps: input.steps,
      schedule: input.schedule,
      enabled: true,
      budgetTokens: input.budgetTokens,
      allowTools: input.allowTools,
      notify: input.notify,
      createdAt: now,
      updatedAt: now,
      ...(next ? { nextRunAt: next.toISOString() } : {}),
    };

    this.persist(routine);
    return routine;
  }

  update(id: string, patch: Partial<Routine>): Routine {
    const existing = this.require(id);
    const merged: Routine = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };

    // Расписание или включение изменились — время следующего запуска надо
    // пересчитать, иначе рутина сработает по старому плану.
    const next = merged.enabled ? nextRun(merged.schedule) : null;
    if (next) merged.nextRunAt = next.toISOString();
    else delete merged.nextRunAt;

    this.persist(merged);
    return merged;
  }

  remove(id: string): void {
    this.require(id);
    this.deps.store.transact(() => {
      this.deps.store.routines.delete(id);
      this.deps.store.record({ type: 'routine.removed', id });
    });
  }

  /** Запустить прямо сейчас, не трогая расписание. */
  async runNow(id: string): Promise<{ routine: Routine; run: RoutineRun }> {
    const routine = this.require(id);
    return await this.execute(routine, { trigger: 'manual', reschedule: false });
  }

  // ─── Работа по расписанию ─────────────────────────────────────────────────

  private tick(): void {
    const due = this.deps.store.routines.due(new Date().toISOString());
    for (const routine of due) {
      if (this.running.has(routine.id)) continue;
      void this.execute(routine, { trigger: 'schedule', reschedule: true }).catch(
        (error: Error) => {
          logger.warn({ routine: routine.id, err: error.message }, 'рутина не отработала');
        },
      );
    }
  }

  private plan(): void {
    const now = new Date().toISOString();

    for (const routine of this.deps.store.routines.list()) {
      if (!routine.enabled) continue;
      if (routine.schedule.kind === 'manual') continue;

      const next = nextRun(routine.schedule);
      if (!next) {
        // Разовая рутина, чьё время прошло, пока ядро не работало. Запускать её
        // сильно позже назначенного бессмысленно: «напомни в 15:00» в полночь
        // это не напоминание, а недоразумение.
        this.persist({
          ...routine,
          enabled: false,
          lastStatus: 'skipped',
          lastSummary: 'Время прошло, пока ядро не работало',
          updatedAt: now,
        });
        continue;
      }

      // Просроченное оставляем просроченным: тик подхватит его сразу и
      // отработает — пропущенное лучше выполнить с опозданием, чем потерять.
      if (routine.nextRunAt && routine.nextRunAt <= now) continue;
      if (routine.nextRunAt === next.toISOString()) continue;

      this.persist({ ...routine, nextRunAt: next.toISOString() });
    }
  }

  private async execute(
    routine: Routine,
    options: { trigger: RoutineRun['trigger']; reschedule: boolean },
  ): Promise<{ routine: Routine; run: RoutineRun }> {
    this.running.add(routine.id);
    const startedAt = new Date().toISOString();

    // Прогон заводим до работы: если ядро упадёт посреди, останется след, что
    // рутина запускалась, а не тишина.
    const runId = this.deps.store.routines.startRun({
      routineId: routine.id,
      startedAt,
      trigger: options.trigger,
    });

    try {
      const outcome = await this.deps.executor.run(routine);

      const run: RoutineRun = {
        id: runId,
        routineId: routine.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: outcome.status,
        trigger: options.trigger,
        steps: outcome.steps,
        summary: outcome.summary,
        tokens: outcome.tokens,
      };
      this.deps.store.routines.finishRun(run);

      const finished: Routine = {
        ...routine,
        conversationId: outcome.conversationId,
        lastRunAt: startedAt,
        lastStatus: outcome.status,
        lastSummary: outcome.summary,
        updatedAt: new Date().toISOString(),
      };

      if (options.reschedule) {
        const next = routine.schedule.kind === 'once' ? null : nextRun(routine.schedule);
        if (next) finished.nextRunAt = next.toISOString();
        else {
          // Разовая отработала — выключаем, а не удаляем: человек должен
          // увидеть, что она сделала, и решить сам.
          delete finished.nextRunAt;
          finished.enabled = false;
        }
      }

      this.persist(finished);
      this.deps.onFinished?.(finished, run);
      return { routine: finished, run };
    } finally {
      this.running.delete(routine.id);
    }
  }

  // ─── Внутреннее ───────────────────────────────────────────────────────────

  private persist(routine: Routine): void {
    this.deps.store.transact(() => {
      this.deps.store.routines.upsert(routine);
      this.deps.store.record({ type: 'routine.changed', routine });
    });
  }

  private require(id: string): Routine {
    const routine = this.deps.store.routines.get(id);
    if (!routine) throw new RoutineError(`Рутина ${id} не найдена`, 'not_found');
    return routine;
  }
}
