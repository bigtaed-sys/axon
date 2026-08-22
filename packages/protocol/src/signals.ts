import { z } from 'zod';
import { zId } from './primitives.js';
import { zUsage } from './domain.js';
import { zPluginInfo } from './plugins.js';

/**
 * Сигналы — эфемерика: живут только в момент подключения, не нумеруются, не
 * хранятся и не досылаются после реконнекта.
 *
 * Правило простое: если пропажа сигнала не ломает состояние — это сигнал.
 * Поток токенов можно потерять, потому что итоговое сообщение всё равно придёт
 * журнальным событием `message.created`. А вот сам факт создания сообщения
 * терять нельзя — поэтому он в журнале.
 */
export const zSignal = z.discriminatedUnion('type', [
  /** Кусок текста от модели. Клиент дорисовывает его в открытый пузырь. */
  z.object({
    type: z.literal('run.delta'),
    runId: zId,
    text: z.string(),
  }),
  /** Что агент делает прямо сейчас — для честного индикатора вместо вечного «печатает…». */
  z.object({
    type: z.literal('run.phase'),
    runId: zId,
    phase: z.enum(['thinking', 'calling_tool', 'awaiting_permission', 'summarizing']),
    /** Имя инструмента для фазы calling_tool. */
    detail: z.string().optional(),
  }),
  /**
   * Расход в реальном времени, пока прогон идёт. Пользователь видит счётчик,
   * а не узнаёт постфактум, что запрос стоил денег.
   */
  z.object({
    type: z.literal('usage.tick'),
    runId: zId,
    usage: zUsage,
    /** Остаток бюджета прогона в токенах. null — потолка нет. */
    budgetRemaining: z.number().int().nullable(),
  }),
  /** Какие ещё устройства сейчас на связи с ядром. */
  z.object({
    type: z.literal('presence'),
    deviceIds: z.array(zId),
  }),
  /**
   * Плагин сменил рабочее состояние: поднимается, поднялся, упал, отдал свои
   * инструменты. Пропажа такого сигнала не ломает состояние — при следующем
   * подключении клиент получит актуальную картину снапшотом.
   */
  z.object({
    type: z.literal('plugin.status'),
    plugin: zPluginInfo,
  }),
]);
export type Signal = z.infer<typeof zSignal>;
