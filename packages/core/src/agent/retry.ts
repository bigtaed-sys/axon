import { ProviderError } from '../providers/types.js';

/**
 * Когда повторять обращение к модели, а когда сдаваться.
 *
 * До этого `ProviderError.retryable` вычислялся и не читался никем: любой 429
 * или моргнувшая сеть убивали ход целиком. Для агента с циклом инструментов
 * это особенно обидно — падение на девятом шаге стоит всех восьми, а ядру на
 * сервере некому сказать «попробуй ещё раз».
 *
 * ## Главное правило: повторяем только с чистого места
 *
 * Если модель успела прислать хоть слово, повтор запрещён. Технически ничего
 * не мешает: в хранилище ещё ничего не записано. Но куски ответа уже ушли
 * клиенту сигналами, и человек увидит, как половина ответа печатается дважды.
 * Оборванный ответ с честной ошибкой лучше склеенного из двух половин.
 *
 * Поэтому чинится ровно то, что чинится хорошо: отказ до первого байта —
 * лимит запросов, отказ соединения, таймаут на установке связи. Это и есть
 * подавляющее большинство случаев.
 */

/** Сколько раз пробовать сверх первой попытки. */
const MAX_ATTEMPTS = 3;

/** Задержки по попыткам. Растут, чтобы не долбить лежащего провайдера. */
const BACKOFF_MS = [1_000, 4_000, 12_000];

/** Дольше ждать нет смысла: человек уже решил, что всё сломалось. */
const MAX_WAIT_MS = 60_000;

export interface RetryDecision {
  /** Сколько ждать перед следующей попыткой. */
  waitMs: number;
  /** Что показать человеку вместо тишины. */
  reason: string;
}

/**
 * Решение о повторе. `null` — не повторять.
 *
 * @param error      что случилось
 * @param attempt    номер уже сделанной попытки, с нуля
 * @param untouched  ничего ли ещё не пришло от модели
 */
export function decideRetry(
  error: unknown,
  attempt: number,
  untouched: boolean,
): RetryDecision | null {
  if (!untouched) return null;
  if (attempt >= MAX_ATTEMPTS) return null;
  if (!(error instanceof ProviderError)) return null;
  if (!error.retryable) return null;

  /**
   * Просьбу провайдера уважаем, но не безоговорочно.
   *
   * `Retry-After` в минутах встречается, и молчаливое ожидание десяти минут
   * неотличимо от зависания. Лучше честно сдаться и дать человеку решить.
   */
  const asked = error.options.retryAfterMs;
  if (asked !== undefined && asked > MAX_WAIT_MS) return null;

  const planned = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
  const base = Math.max(asked ?? 0, planned);

  return {
    /**
     * Разброс до четверти паузы.
     *
     * Без него все ожидающие запросы — свои же параллельные прогоны, рутины,
     * порывы инициативы — просыпаются одновременно и повторяют отказ хором.
     */
    waitMs: Math.round(base * (1 + Math.random() * 0.25)),
    reason:
      error.kind === 'rate_limit'
        ? 'провайдер просит подождать'
        : 'связь оборвалась, пробую снова',
  };
}

/** Пауза, которую прерывает отмена прогона. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'));

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
