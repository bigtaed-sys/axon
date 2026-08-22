import { z } from 'zod';
import { zId, zTimestamp } from './primitives.js';

/**
 * Рутины — то, что агент делает сам, без человека рядом.
 *
 * Устройство держится на одном решении: рутина **компилируется один раз**.
 * Человек описывает задачу словами, модель превращает описание в явный список
 * шагов, и дальше рутина исполняется детерминированно — без обращения к
 * модели, если шаги того не требуют.
 *
 * Альтернатива — хранить описание как есть и каждый раз запускать полный цикл
 * агента — выглядит проще, но проигрывает по всем трём статьям:
 *
 * - **Цена.** Рутина «каждые полчаса» это сорок восемь прогонов в сутки. Цикл
 *   агента везёт с собой контекст и схемы всех инструментов; скомпилированные
 *   шаги не стоят почти ничего.
 * - **Предсказуемость.** Фоновая задача, каждый раз заново решающая, что
 *   делать, — самая пугающая разновидность автоматизации. Шаги можно прочитать
 *   до того, как включишь.
 * - **Ошибки.** Несуществующий инструмент или забытый обязательный аргумент
 *   видно при создании, а не в три часа ночи на первом прогоне.
 *
 * При этом жёсткий конвейер не умеет того, ради чего заводят агента, — решать
 * по обстановке. Для этого есть шаг `agent`: один шаг с бюджетом там, где
 * правда нужно суждение, вместо агента на каждом шагу.
 */

// ─── Расписание ─────────────────────────────────────────────────────────────

/** Время суток «ЧЧ:ММ» по часам той машины, где стоит ядро. */
const zTimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время задаётся как ЧЧ:ММ, например 09:30');

export const zSchedule = z.discriminatedUnion('kind', [
  /**
   * Через равные промежутки. Минимум пять минут: всё, что чаще, — это уже не
   * расписание, а фоновый цикл, и для него есть плагины.
   */
  z.object({
    kind: z.literal('interval'),
    everyMinutes: z.number().int().min(5).max(60 * 24 * 30),
  }),
  z.object({ kind: z.literal('daily'), time: zTimeOfDay }),
  z.object({
    kind: z.literal('weekly'),
    /** 0 — воскресенье, как в JS. */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    time: zTimeOfDay,
  }),
  /** Разовое напоминание. После срабатывания рутина выключается сама. */
  z.object({ kind: z.literal('once'), at: zTimestamp }),
  /** Только вручную: кнопкой «Запустить сейчас». */
  z.object({ kind: z.literal('manual') }),
]);
export type Schedule = z.infer<typeof zSchedule>;

// ─── Условия ────────────────────────────────────────────────────────────────

/**
 * Условие для шага `if`.
 *
 * Это структура, а не выражение на языке. Выражение потребовало бы либо
 * интерпретатора, либо `eval` — а рутина составлена моделью по тексту
 * пользователя, и давать такому источнику исполняемый код нельзя. Проверок из
 * списка ниже хватает на всё, ради чего условия в рутинах заводят, и каждую
 * видно в интерфейсе как готовую фразу.
 */
export const zCondition = z.object({
  /** Что проверяем: имя переменной или строка с подстановками `${…}`. */
  left: z.string().max(2000),
  op: z.enum([
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'matches',
    'empty',
    'notEmpty',
    'greaterThan',
    'lessThan',
  ]),
  /** С чем сравниваем. Для `empty` и `notEmpty` не нужно. */
  right: z.string().max(2000).optional(),
});
export type Condition = z.infer<typeof zCondition>;

// ─── Шаги ───────────────────────────────────────────────────────────────────

/**
 * Имя переменной. Буквы любые, а не только латинские: задачу описывают
 * по-русски, и переменные называют так же — `${состояние}`, `${список}`.
 */
const NAME = /^\p{L}[\p{L}\p{N}_]*$/u;

/** Куда положить результат шага, чтобы сослаться на него дальше. */
const zOutputVar = z
  .string()
  .regex(NAME, 'Имя переменной: буква, дальше буквы, цифры и подчёркивание')
  .max(40)
  .optional();

export type RoutineStep =
  /** Вызвать инструмент. Основной шаг: дёшево и предсказуемо. */
  | {
      kind: 'tool';
      tool: string;
      args: Record<string, unknown>;
      outputVar?: string | undefined;
      /** Продолжать, если шаг упал. По умолчанию рутина останавливается. */
      continueOnError?: boolean | undefined;
    }
  /**
   * Один вопрос к модели без инструментов. Для «перескажи», «переформулируй»,
   * «реши да или нет» — там, где цикл агента избыточен.
   */
  | {
      kind: 'prompt';
      prompt: string;
      outputVar?: string | undefined;
      maxTokens?: number | undefined;
    }
  /**
   * Разобрать текст на именованные поля. Отличается от `prompt` тем, что даёт
   * не строку, а переменные, по которым можно ветвиться.
   */
  | {
      kind: 'extract';
      /** Откуда берём текст: строка с подстановками. */
      from: string;
      fields: Array<{ name: string; description: string }>;
      /** Куда положить всё разом, как JSON. */
      outputVar?: string | undefined;
    }
  /**
   * Полноценный агент с инструментами — для шага, где нужно решение по
   * обстановке. Дорогой, поэтому со своим потолком токенов.
   */
  | {
      kind: 'agent';
      task: string;
      /** Инструменты сверх безопасных. Пусто — только безопасные. */
      allowTools?: string[] | undefined;
      budgetTokens?: number | undefined;
      outputVar?: string | undefined;
    }
  /** Ветвление. */
  | {
      kind: 'if';
      condition: Condition;
      then: RoutineStep[];
      otherwise?: RoutineStep[] | undefined;
    }
  /** Повтор по списку. `${item}` и `${index}` доступны внутри. */
  | {
      kind: 'foreach';
      /** Переменная или текст: массив JSON либо строки через перевод строки. */
      source: string;
      steps: RoutineStep[];
      /** Потолок повторов — защита от списка на десять тысяч элементов. */
      limit?: number | undefined;
    }
  /** Присвоить переменную: склеить, подставить, задать константу. */
  | { kind: 'set'; name: string; value: string }
  /** Показать уведомление системы. */
  | { kind: 'notify'; title: string; body?: string | undefined }
  /** Написать сообщение в разговор рутины — так человек читает результат. */
  | { kind: 'message'; text: string }
  /** Запомнить факт в долговременной памяти ядра. */
  | { kind: 'remember'; key: string; value: string }
  /** Подождать. Секунды, с потолком: рутина не должна спать часами. */
  | { kind: 'wait'; seconds: number }
  /** Закончить досрочно — «сообщать не о чем». */
  | { kind: 'stop'; reason?: string | undefined };

/**
 * Вход объявлен как `unknown`, а не как сам тип шага: у `args` есть значение
 * по умолчанию, поэтому разобранный шаг и шаг «как прислали» — разные типы, и
 * связать их одним параметром нельзя.
 */
export const zRoutineStep: z.ZodType<RoutineStep, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('tool'),
      tool: z.string().min(1).max(80),
      args: z.record(z.unknown()).default({}),
      outputVar: zOutputVar,
      continueOnError: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('prompt'),
      prompt: z.string().min(1).max(8000),
      outputVar: zOutputVar,
      maxTokens: z.number().int().positive().max(4000).optional(),
    }),
    z.object({
      kind: z.literal('extract'),
      from: z.string().min(1).max(2000),
      fields: z
        .array(z.object({ name: z.string().min(1).max(40), description: z.string().max(300) }))
        .min(1)
        .max(12),
      outputVar: zOutputVar,
    }),
    z.object({
      kind: z.literal('agent'),
      task: z.string().min(1).max(4000),
      allowTools: z.array(z.string()).optional(),
      budgetTokens: z.number().int().positive().optional(),
      outputVar: zOutputVar,
    }),
    z.object({
      kind: z.literal('if'),
      condition: zCondition,
      then: z.array(zRoutineStep).max(40),
      otherwise: z.array(zRoutineStep).max(40).optional(),
    }),
    z.object({
      kind: z.literal('foreach'),
      source: z.string().min(1).max(2000),
      steps: z.array(zRoutineStep).max(40),
      limit: z.number().int().positive().max(500).optional(),
    }),
    z.object({
      kind: z.literal('set'),
      name: z.string().regex(NAME).max(40),
      value: z.string().max(8000),
    }),
    z.object({
      kind: z.literal('notify'),
      title: z.string().min(1).max(200),
      body: z.string().max(1000).optional(),
    }),
    z.object({ kind: z.literal('message'), text: z.string().min(1).max(20_000) }),
    z.object({
      kind: z.literal('remember'),
      key: z.string().min(1).max(200),
      value: z.string().min(1).max(4000),
    }),
    z.object({ kind: z.literal('wait'), seconds: z.number().int().min(1).max(3600) }),
    z.object({ kind: z.literal('stop'), reason: z.string().max(500).optional() }),
  ]),
);

export type RoutineStepKind = RoutineStep['kind'];

// ─── Рутина ─────────────────────────────────────────────────────────────────

export const zRoutineStatus = z.enum(['ok', 'failed', 'skipped', 'running']);
export type RoutineStatus = z.infer<typeof zRoutineStatus>;

export const zRoutine = z.object({
  id: zId,
  name: z.string().min(1).max(120),
  /** Что делает рутина — одной фразой, для списка. */
  description: z.string().max(500).default(''),
  /**
   * Исходное описание словами. Хранится, чтобы рутину можно было пересобрать
   * после появления новых инструментов или правки текста.
   */
  source: z.string().max(8000).default(''),
  steps: z.array(zRoutineStep).max(60).default([]),
  schedule: zSchedule,
  enabled: z.boolean(),

  /**
   * Разговор, в который пишутся шаги `message`. Заводится при первом прогоне и
   * живёт дальше: результат рутины — обычная переписка, которую можно открыть,
   * прочитать и продолжить руками.
   */
  conversationId: zId.optional(),
  /**
   * Потолок токенов на прогон. Обязателен: за фоновой задачей никто не
   * смотрит, и перерасход обнаруживается по счёту, а не сразу.
   */
  budgetTokens: z.number().int().positive(),
  /**
   * Инструменты сверх безопасных, разрешённые этой рутине. Рядом нет человека,
   * который подтвердит опасное действие, и подтверждать его молча нельзя.
   */
  allowTools: z.array(z.string()).default([]),
  notify: z.boolean().default(true),

  createdAt: zTimestamp,
  updatedAt: zTimestamp,
  nextRunAt: zTimestamp.optional(),
  lastRunAt: zTimestamp.optional(),
  lastStatus: zRoutineStatus.optional(),
  lastSummary: z.string().optional(),
});
export type Routine = z.infer<typeof zRoutine>;

// ─── Прогоны ────────────────────────────────────────────────────────────────

/**
 * Запись об одном шаге. Отлаживать фоновую задачу без пошагового следа —
 * гадание: видно только, что «не получилось», и негде посмотреть, на чём.
 */
export const zStepLog = z.object({
  /** Путь до шага: «2» — третий шаг, «2.1» — второй шаг внутри него. */
  path: z.string(),
  kind: z.string(),
  ok: z.boolean(),
  /** Что шаг вернул, обрезанное до разумного. */
  output: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative(),
  /** Сколько токенов стоил шаг. У большинства шагов — ноль. */
  tokens: z.number().int().nonnegative().default(0),
});
export type StepLog = z.infer<typeof zStepLog>;

export const zRoutineRun = z.object({
  id: z.number().int().positive(),
  routineId: zId,
  startedAt: zTimestamp,
  finishedAt: zTimestamp.optional(),
  status: zRoutineStatus,
  trigger: z.enum(['schedule', 'manual']),
  steps: z.array(zStepLog).default([]),
  summary: z.string().default(''),
  tokens: z.number().int().nonnegative().default(0),
});
export type RoutineRun = z.infer<typeof zRoutineRun>;

// ─── Команды ────────────────────────────────────────────────────────────────

/** Собрать шаги из описания словами. Отдельно от создания: результат показывают. */
export const zRoutineCompileReq = z.object({
  source: z.string().min(1).max(8000),
  /** Инструменты, которые компилятору разрешено использовать в шагах. */
  allowTools: z.array(z.string()).default([]),
});
export const zRoutineCompileRes = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(zRoutineStep),
  schedule: zSchedule,
  /** Замечания компилятора: чего он не смог, что заменил. */
  warnings: z.array(z.string()).default([]),
});

export const zRoutineCreateReq = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  source: z.string().max(8000).default(''),
  steps: z.array(zRoutineStep).max(60),
  schedule: zSchedule,
  budgetTokens: z.number().int().positive().default(20_000),
  allowTools: z.array(z.string()).default([]),
  notify: z.boolean().default(true),
});

export const zRoutineUpdateReq = z.object({
  id: zId,
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  source: z.string().max(8000).optional(),
  steps: z.array(zRoutineStep).max(60).optional(),
  schedule: zSchedule.optional(),
  enabled: z.boolean().optional(),
  budgetTokens: z.number().int().positive().optional(),
  allowTools: z.array(z.string()).optional(),
  notify: z.boolean().optional(),
});

export const zRoutineRunsReq = z.object({
  routineId: zId,
  limit: z.number().int().positive().max(50).default(10),
});
export const zRoutineRunsRes = z.object({ runs: z.array(zRoutineRun) });
