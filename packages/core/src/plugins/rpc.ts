/**
 * Симметричный RPC поверх канала «одна сторона шлёт объект — другая получает».
 *
 * Симметричный он не для красоты: ядро вызывает плагин (выполни инструмент),
 * а плагин вызывает ядро (спроси разрешение, дай секрет) — причём второе часто
 * происходит внутри первого. Односторонний протокол здесь означал бы взаимную
 * блокировку на первом же инструменте, которому нужно подтверждение.
 *
 * Кадры JSON-сериализуемы: канал — `process.send`, а не структурное
 * клонирование. Это ограничение осознанное — так тот же код работает и через
 * сокет, если плагины однажды поедут на другую машину.
 */

export type RpcFrame =
  | { t: 'req'; id: number; method: string; params: unknown }
  | { t: 'res'; id: number; ok: true; result: unknown }
  | { t: 'res'; id: number; ok: false; error: { message: string; code?: string } }
  /** Кусок потока для незавершённого запроса — так стримит провайдер плагина. */
  | { t: 'chunk'; id: number; value: unknown }
  /** Односторонний вызов: ответа не будет и не ожидается. */
  | { t: 'evt'; method: string; params: unknown }
  /** Отмена незавершённого запроса. */
  | { t: 'cancel'; id: number };

export interface HandlerContext {
  /** Отменён ли запрос вызывающей стороной. */
  signal: AbortSignal;
  /** Отправить кусок потока. До ответа, не после. */
  push(value: unknown): void;
}

export type RpcHandler = (params: never, ctx: HandlerContext) => Promise<unknown> | unknown;

export interface CallOptions {
  signal?: AbortSignal;
  /** Куски потока приезжают сюда; итог — в результат вызова. */
  onChunk?: (value: unknown) => void;
  /** Через сколько считать, что ответа не будет. 0 — ждать вечно. */
  timeoutMs?: number;
}

/** Ошибка на той стороне. Сохраняет код, чтобы решения принимались не по тексту. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string = 'plugin_error',
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onChunk?: (value: unknown) => void;
  timer?: NodeJS.Timeout;
  detach(): void;
}

export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly events = new Map<string, (params: never) => void>();
  /** Запросы, которые сейчас выполняем мы — по ним может прийти `cancel`. */
  private readonly inflight = new Map<number, AbortController>();
  private closed: Error | null = null;

  constructor(private readonly send: (frame: RpcFrame) => void) {}

  // ─── Приём ────────────────────────────────────────────────────────────────

  handle(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  onEvent<P>(method: string, handler: (params: P) => void): void {
    this.events.set(method, handler as (params: never) => void);
  }

  /** Скормить входящий кадр. Вызывается транспортом. */
  receive(frame: RpcFrame): void {
    switch (frame.t) {
      case 'req':
        void this.dispatch(frame);
        return;
      case 'res': {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        pending.detach();
        if (pending.timer) clearTimeout(pending.timer);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new RpcError(frame.error.message, frame.error.code));
        return;
      }
      case 'chunk':
        this.pending.get(frame.id)?.onChunk?.(frame.value);
        return;
      case 'evt': {
        const handler = this.events.get(frame.method);
        // Неизвестное событие — не ошибка: сторона может быть старее и просто
        // не знать про него. Ронять из-за этого связь было бы неразумно.
        if (handler) handler(frame.params as never);
        return;
      }
      case 'cancel':
        this.inflight.get(frame.id)?.abort();
        return;
    }
  }

  private async dispatch(frame: { id: number; method: string; params: unknown }): Promise<void> {
    const handler = this.handlers.get(frame.method);
    if (!handler) {
      this.send({
        t: 'res',
        id: frame.id,
        ok: false,
        error: { message: `Неизвестный метод ${frame.method}`, code: 'unknown_method' },
      });
      return;
    }

    const controller = new AbortController();
    this.inflight.set(frame.id, controller);
    try {
      const result = await handler(frame.params as never, {
        signal: controller.signal,
        push: (value) => this.send({ t: 'chunk', id: frame.id, value }),
      });
      this.send({ t: 'res', id: frame.id, ok: true, result: result ?? null });
    } catch (error) {
      this.send({
        t: 'res',
        id: frame.id,
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof RpcError ? { code: error.code } : {}),
        },
      });
    } finally {
      this.inflight.delete(frame.id);
    }
  }

  // ─── Отправка ─────────────────────────────────────────────────────────────

  call<T>(method: string, params: unknown = {}, options: CallOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        if (!this.pending.delete(id)) return;
        this.send({ t: 'cancel', id });
        reject(new RpcError('Вызов отменён', 'cancelled'));
      };
      options.signal?.addEventListener('abort', abort, { once: true });

      const pending: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        detach: () => options.signal?.removeEventListener('abort', abort),
        ...(options.onChunk ? { onChunk: options.onChunk } : {}),
      };

      if (options.timeoutMs && options.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return;
          pending.detach();
          reject(new RpcError(`Ответ не пришёл за ${options.timeoutMs} мс`, 'timeout'));
        }, options.timeoutMs);
        // Ожидание ответа не должно удерживать процесс от выхода.
        pending.timer.unref?.();
      }

      this.pending.set(id, pending);
      try {
        this.send({ t: 'req', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        pending.detach();
        if (pending.timer) clearTimeout(pending.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  emit(method: string, params: unknown = {}): void {
    if (this.closed) return;
    this.send({ t: 'evt', method, params });
  }

  /**
   * Закрыть пира: все незавершённые вызовы падают, новые сразу отклоняются.
   *
   * Без этого падение процесса плагина оставляло бы висеть промисы навсегда, и
   * прогон агента замирал бы молча — худший из возможных способов сломаться.
   */
  dispose(reason: Error): void {
    this.closed = reason;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.detach();
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(reason);
    }
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
  }
}
