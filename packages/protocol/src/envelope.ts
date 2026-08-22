import { z } from 'zod';
import { PROTOCOL_VERSION, zCursor, zId, zSeq, zTimestamp } from './primitives.js';
import { zProtocolError } from './errors.js';
import { zJournalEvent } from './events.js';
import { zSignal } from './signals.js';
import { zScope } from './domain.js';

/**
 * Кадры соединения ядро ↔ клиент.
 *
 * Живой канал — один WebSocket, по нему идёт всё, кроме блобов: файлы и
 * картинки качаются обычным HTTP GET, чтобы не забивать канал и не ломать
 * докачку и кэширование.
 */

// ─── Клиент → ядро ──────────────────────────────────────────────────────────

export const zClientFrame = z.discriminatedUnion('t', [
  /** Вызов команды. `id` возвращается в ответном кадре. */
  z.object({
    t: z.literal('req'),
    id: zId,
    cmd: z.string(),
    payload: z.unknown(),
  }),
  /**
   * Подтверждение позиции в журнале. Ядро запоминает курсор устройства, чтобы
   * при следующем подключении сразу знать, с чего досылать.
   */
  z.object({
    t: z.literal('ack'),
    cursor: zCursor,
  }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientFrame = z.infer<typeof zClientFrame>;

// ─── Ядро → клиент ──────────────────────────────────────────────────────────

export const zCoreInfo = z.object({
  /** Постоянный id этой установки ядра. Клиент по нему отличает «переехал на другое ядро». */
  coreId: zId,
  version: z.string(),
  /** Как ядро запущено: встроено в десктоп или отдельным сервисом. */
  mode: z.enum(['embedded', 'standalone']),
  /** Права выданного устройству токена — клиент прячет то, что всё равно не разрешат. */
  scopes: z.array(zScope),
});
export type CoreInfo = z.infer<typeof zCoreInfo>;

export const zServerFrame = z.discriminatedUnion('t', [
  /** Первый кадр после подключения. До него клиент не шлёт ничего, кроме ping. */
  z.object({
    t: z.literal('hello'),
    protocol: z.number().int(),
    /**
     * Ревизия контракта у ядра. `default` здесь обязателен: ядра, выпущенные
     * до её появления, этого поля не шлют, и без умолчания разбор кадра упал
     * бы ровно на тех, ради кого она и заводится.
     */
    revision: z.number().int().default(0),
    core: zCoreInfo,
    /** Текущая вершина журнала — сразу видно, насколько клиент отстал. */
    head: zSeq,
  }),
  z.object({
    t: z.literal('res'),
    id: zId,
    payload: z.unknown(),
  }),
  z.object({
    t: z.literal('err'),
    id: zId,
    error: zProtocolError,
  }),
  /** Новая запись журнала. Клиент применяет её и двигает курсор. */
  z.object({
    t: z.literal('evt'),
    seq: zSeq,
    at: zTimestamp,
    event: zJournalEvent,
  }),
  /** Эфемерика: поток токенов, фазы, счётчик расхода. Потеря не страшна. */
  z.object({
    t: z.literal('sig'),
    signal: zSignal,
  }),
  z.object({ t: z.literal('pong') }),
]);
export type ServerFrame = z.infer<typeof zServerFrame>;

/** Совместимы ли версии протокола. Пока major один — ломающих изменений нет. */
export function isProtocolCompatible(clientProtocol: number): boolean {
  return clientProtocol === PROTOCOL_VERSION;
}
