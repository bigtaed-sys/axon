import { z } from 'zod';
import { zExternalId, zId, zSeq, zTimestamp } from './primitives.js';
import {
  zConversation,
  zDevice,
  zFact,
  zMessage,
  zObservation,
  zPermissionDecision,
  zPermissionRequest,
  zStopReason,
  zToolCall,
  zToolInfo,
  zToolResult,
  zUsage,
} from './domain.js';
import { zPluginInfo } from './plugins.js';
import { zRoutine } from './routines.js';

/**
 * Журнал — единственный источник правды в Axon.
 *
 * Всё, что меняет состояние, дописывается сюда фактом в прошедшем времени и
 * получает монотонный `seq`. Клиент хранит только последний виденный seq и при
 * подключении просит «дай всё после N». Оффлайн, переподключение, три устройства
 * одновременно — всё это один и тот же механизм, а не три разных.
 *
 * Сюда НЕ попадает поток токенов и прочая эфемерика — для неё есть сигналы
 * (см. signals.ts). Если писать в журнал каждую дельту, он распухнет в тысячу раз
 * и синк на слабом канале умрёт.
 */
export const zJournalEvent = z.discriminatedUnion('type', [
  // ── Разговоры ──
  z.object({ type: z.literal('conversation.created'), conversation: zConversation }),
  z.object({ type: z.literal('conversation.renamed'), id: zId, title: z.string() }),
  z.object({ type: z.literal('conversation.archived'), id: zId, archived: z.boolean() }),
  z.object({ type: z.literal('conversation.deleted'), id: zId }),

  // ── Сообщения ──
  z.object({ type: z.literal('message.created'), message: zMessage }),
  /**
   * Сообщение изменено задним числом: правка пользователя или подстановка
   * итогового текста после стрима. Клиент заменяет содержимое целиком.
   */
  z.object({ type: z.literal('message.amended'), message: zMessage }),
  z.object({ type: z.literal('message.deleted'), id: zId, conversationId: zId }),

  // ── Прогоны агента ──
  z.object({
    type: z.literal('run.started'),
    runId: zId,
    conversationId: zId,
    /** Сколько токенов прогону разрешено сжечь. null — без потолка. */
    budgetTokens: z.number().int().positive().nullable(),
  }),
  z.object({
    type: z.literal('run.finished'),
    runId: zId,
    conversationId: zId,
    stopReason: zStopReason,
    /** Суммарный расход за весь прогон, включая все итерации с инструментами. */
    usage: zUsage.optional(),
    iterations: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('run.failed'),
    runId: zId,
    conversationId: zId,
    error: z.string(),
  }),

  // ── Инструменты ──
  z.object({
    type: z.literal('tool_call.started'),
    runId: zId,
    conversationId: zId,
    call: zToolCall,
  }),
  z.object({
    type: z.literal('tool_call.finished'),
    runId: zId,
    conversationId: zId,
    callId: zExternalId,
    result: zToolResult,
  }),

  // ── Разрешения ──
  z.object({ type: z.literal('permission.requested'), request: zPermissionRequest }),
  z.object({
    type: z.literal('permission.resolved'),
    requestId: zId,
    decision: zPermissionDecision,
    /** Какое устройство ответило. Пусто, если решение принято по правилу или по таймауту. */
    deviceId: zId.optional(),
  }),

  // ── Память ──
  z.object({ type: z.literal('fact.upserted'), fact: zFact }),
  z.object({ type: z.literal('fact.forgotten'), id: zId }),
  z.object({ type: z.literal('observation.noticed'), observation: zObservation }),
  z.object({ type: z.literal('observation.forgotten'), id: zId }),

  // ── Инициатива ──
  /**
   * Агент написал первым.
   *
   * Отдельное событие, а не просто сообщение в разговоре: клиент должен
   * показать уведомление, а по `message.created` отличить собственный порыв
   * агента от обычного ответа невозможно — роль там одна и та же.
   */
  z.object({
    type: z.literal('impulse.sent'),
    conversationId: zId,
    messageId: zId,
    /** Чем агент объяснил себе, зачем пишет. Видно человеку в интерфейсе. */
    reason: z.string(),
  }),

  // ── Инструменты ──
  /**
   * Инструмент включили, выключили или переопределили. Без этого события
   * клиент не узнаёт о смене состояния и показывает старое: переключатель
   * выглядит нажатым вхолостую.
   */
  z.object({ type: z.literal('tool.changed'), tool: zToolInfo }),

  // ── Плагины ──
  /**
   * Плагин поставлен, настроен, включён или выключен — то есть изменилось
   * решение пользователя. Смена рабочего состояния (запускается, упал,
   * поднялся) сюда не пишется: это сигнал. Иначе журнал получал бы по паре
   * записей на плагин при каждом старте ядра — навсегда.
   */
  z.object({ type: z.literal('plugin.changed'), plugin: zPluginInfo }),
  z.object({ type: z.literal('plugin.removed'), id: z.string() }),

  // ── Рутины ──
  /**
   * Рутина заведена, изменена или отработала. Исход прогона тоже сюда: это
   * состояние, которое должно пережить перезапуск и доехать до всех устройств,
   * а не мигнуть уведомлением у того, кто в этот момент смотрел в экран.
   */
  z.object({ type: z.literal('routine.changed'), routine: zRoutine }),
  z.object({ type: z.literal('routine.removed'), id: zId }),
  /**
   * Рутина просит показать уведомление. В журнале, а не сигналом: у ядра нет
   * экрана, а показать должен тот клиент, который сейчас на связи — и увидеть
   * пропущенное при следующем подключении тоже нужно.
   */
  z.object({
    type: z.literal('routine.notified'),
    routineId: zId,
    title: z.string(),
    body: z.string().optional(),
  }),

  // ── Устройства ──
  z.object({ type: z.literal('device.paired'), device: zDevice }),
  z.object({ type: z.literal('device.revoked'), id: zId }),

  // ── Настройки ──
  /**
   * Значения не передаются: среди настроек лежат API-ключи, и им нечего делать
   * в журнале, который синкается на все устройства. Клиент, увидев событие,
   * перезапрашивает то, к чему у него есть доступ.
   */
  z.object({ type: z.literal('settings.changed'), keys: z.array(z.string()) }),
]);
export type JournalEvent = z.infer<typeof zJournalEvent>;

export type JournalEventType = JournalEvent['type'];

/** Запись журнала: событие плюс его позиция и время. */
export const zJournalEntry = z.object({
  seq: zSeq,
  at: zTimestamp,
  event: zJournalEvent,
});
export type JournalEntry = z.infer<typeof zJournalEntry>;
