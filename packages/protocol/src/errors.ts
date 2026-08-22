import { z } from 'zod';

/**
 * Коды ошибок протокола. Клиент принимает решения по коду, а не по тексту —
 * `message` предназначен человеку и может быть переведён или изменён в любой версии.
 */
export const zErrorCode = z.enum([
  /** Кадр не прошёл валидацию схемы. */
  'bad_request',
  /** Токен устройства отсутствует, истёк или отозван. */
  'unauthorized',
  /** Токен валиден, но у устройства нет нужного scope. */
  'forbidden',
  /** Разговор / сообщение / устройство не найдены. */
  'not_found',
  /** Команда неизвестна этой версии ядра. */
  'unknown_command',
  /** Major протокола клиента не совпал с ядром. */
  'protocol_mismatch',
  /** Клиент просит события, которые уже вычищены компактификацией журнала. */
  'cursor_too_old',
  /** Операция отменена пользователем или обрывом соединения. */
  'cancelled',
  /** Упёрлись в лимит: бюджет токенов, размер файла, частота запросов. */
  'limit_exceeded',
  /** Ошибка внешнего провайдера (AI, умный дом, telegram). */
  'upstream_failed',
  /** Всё остальное. */
  'internal',
]);
export type ErrorCode = z.infer<typeof zErrorCode>;

export const zProtocolError = z.object({
  code: zErrorCode,
  /** Человекочитаемое описание. Не парсить. */
  message: z.string(),
  /** Дополнительные поля под конкретный код: `{ retryAfterMs }`, `{ requiredScope }` и т.п. */
  details: z.record(z.unknown()).optional(),
  /** Есть ли смысл повторить запрос. Клиент не должен угадывать это по коду. */
  retryable: z.boolean().default(false),
});
export type ProtocolError = z.infer<typeof zProtocolError>;
