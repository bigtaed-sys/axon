import {
  PROTOCOL_REVISION,
  PROTOCOL_VERSION,
  zServerFrame,
  type CommandInput,
  type CommandName,
  type CommandRes,
  type CoreInfo,
  type JournalEntry,
  type ProtocolError,
  type ServerFrame,
  type Signal,
} from '@axon/protocol';
import { ClientState } from './ClientState.js';

export type ConnectionStatus = 'offline' | 'connecting' | 'syncing' | 'ready';

/** Минимум от WebSocket, который нужен клиенту — чтобы не тянуть DOM в типы. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface AxonClientOptions {
  /** Базовый адрес демона, например `http://127.0.0.1:8787`. */
  url: string;
  token: string;
  /**
   * Как создать сокет. По умолчанию берётся глобальный `WebSocket` — он есть
   * в браузере, в Electron-рендерере и в свежих Node. В остальных случаях
   * фабрику передают снаружи, чтобы SDK не тянул зависимость ради одного места.
   */
  socketFactory?: SocketFactory;
  /** Таймаут ответа на команду. */
  requestTimeoutMs?: number;
  /** Автоматически переподключаться. */
  reconnect?: boolean;
}

export class AxonError extends Error {
  constructor(readonly error: ProtocolError) {
    super(error.message);
    this.name = 'AxonError';
  }

  get code(): ProtocolError['code'] {
    return this.error.code;
  }
}

const DEFAULT_TIMEOUT = 30_000;
const PULL_LIMIT = 200;
const MAX_BACKOFF_MS = 30_000;

/**
 * Клиент Axon.
 *
 * Отвечает за три вещи, которые иначе пришлось бы писать в каждом приложении
 * заново: подключение с переподключением, догон журнала по курсору и
 * типизированный вызов команд.
 */
export class AxonClient {
  readonly state = new ClientState();

  private socket: SocketLike | null = null;
  private status: ConnectionStatus = 'offline';
  private core: CoreInfo | null = null;
  private attempt = 0;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /**
   * События, приехавшие живьём во время догона. Применить их сразу нельзя:
   * между снапшотом и подпиской образуется дыра, и порядок разъедется.
   */
  private readonly buffered: JournalEntry[] = [];
  /** Разговоры, для которых история уже подгружена. */
  private readonly historyLoaded = new Set<string>();
  private syncing = false;

  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly signalListeners = new Set<(signal: Signal) => void>();
  private readonly eventListeners = new Set<(entry: JournalEntry) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  /** Последняя ошибка, из-за которой связь оборвалась. */
  lastError: Error | null = null;
  /**
   * Ядро старее приложения: рукопожатие прошло, но части контракта оно не
   * знает. Не поломка — повод сказать человеку, что ядро пора обновить.
   */
  coreOutdated = false;

  constructor(private readonly options: AxonClientOptions) {}

  // ─── Подключение ──────────────────────────────────────────────────────────

  async connect(): Promise<CoreInfo> {
    this.closed = false;
    return await new Promise<CoreInfo>((resolve, reject) => {
      this.openSocket(resolve, reject);
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.setStatus('offline');
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get coreInfo(): CoreInfo | null {
    return this.core;
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onSignal(listener: (signal: Signal) => void): () => void {
    this.signalListeners.add(listener);
    return () => this.signalListeners.delete(listener);
  }

  /** Сбой, из-за которого связь оборвалась после успешного подключения. */
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onEvent(listener: (entry: JournalEntry) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  // ─── Команды ──────────────────────────────────────────────────────────────

  /**
   * Подгрузить переписку разговора.
   *
   * Журнал даёт живые изменения, снапшот — текущее состояние, но история
   * сообщений не входит ни туда, ни туда: она грузится по требованию, когда
   * разговор открыли. Повторный вызов для того же разговора ничего не делает,
   * если не попросить `force`.
   */
  async loadHistory(
    conversationId: string,
    options: { force?: boolean; limit?: number } = {},
  ): Promise<void> {
    if (!options.force && this.historyLoaded.has(conversationId)) return;

    const page = await this.call('message.history', {
      conversationId,
      limit: options.limit ?? 200,
    });
    this.state.mergeMessages(conversationId, page.messages);
    this.historyLoaded.add(conversationId);
    this.state.notify();
  }

  // ─── Вложения ─────────────────────────────────────────────────────────────

  /**
   * Загрузить файл в ядро и получить ссылку на него.
   *
   * Идёт по HTTP, а не через сокет, и это не обход архитектуры: команды —
   * это JSON-кадры, и картинка в них превратилась бы в base64, распухнув на
   * треть, да ещё и заблокировала бы канал команд на время передачи. Ссылка,
   * которая возвращается, кладётся в сообщение частью `blob`.
   */
  async uploadBlob(input: {
    data: Blob | ArrayBuffer | Uint8Array;
    mime: string;
    name?: string;
  }): Promise<{ blobId: string; bytes: number }> {
    const query = input.name ? `?name=${encodeURIComponent(input.name)}` : '';
    const response = await fetch(`${this.options.url}/v1/blobs${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': input.mime || 'application/octet-stream',
        Authorization: `Bearer ${this.options.token}`,
      },
      body: input.data as BodyInit,
    });

    if (!response.ok) {
      const reason =
        response.status === 413
          ? 'Файл слишком большой'
          : `Ядро отказало при загрузке (${response.status})`;
      throw new AxonError({ code: 'internal', message: reason, retryable: false });
    }

    return (await response.json()) as { blobId: string; bytes: number };
  }

  /**
   * Адрес для показа вложения. Токен уходит в строке запроса, потому что
   * `<img src>` не умеет заголовки — а лежит этот адрес внутри окна
   * приложения, к чужим глазам он не попадает.
   */
  blobUrl(blobId: string): string {
    return `${this.options.url}/v1/blobs/${blobId}?token=${encodeURIComponent(this.options.token)}`;
  }

  async call<K extends CommandName>(cmd: K, payload: CommandInput<K>): Promise<CommandRes<K>> {
    if (!this.socket || this.status === 'offline') {
      throw new AxonError({ code: 'internal', message: 'Нет соединения с ядром', retryable: true });
    }

    const id = uuid();
    const socket = this.socket;

    return await new Promise<CommandRes<K>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AxonError({ code: 'internal', message: `Команда ${cmd} без ответа`, retryable: true }),
        );
      }, this.options.requestTimeoutMs ?? DEFAULT_TIMEOUT);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      socket.send(JSON.stringify({ t: 'req', id, cmd, payload }));
    });
  }

  // ─── Внутреннее: сокет ────────────────────────────────────────────────────

  private openSocket(onReady?: (core: CoreInfo) => void, onFail?: (e: Error) => void): void {
    this.setStatus('connecting');

    const url = `${this.options.url.replace(/^http/, 'ws')}/v1/ws?token=${encodeURIComponent(
      this.options.token,
    )}`;
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(url);
    this.socket = socket;

    socket.onmessage = (event) => this.onFrame(String(event.data), onReady, onFail);
    socket.onerror = () => {
      if (this.status === 'connecting' && onFail) onFail(new Error('Не удалось подключиться'));
    };
    socket.onclose = () => {
      // Закрытие старого сокета приходит с задержкой и вполне может застать
      // уже открытый новый. Без проверки на тождество этот обработчик обнулял
      // бы ссылку на живое соединение и ронял только что поднятую сессию.
      if (this.socket !== socket) return;

      this.socket = null;
      this.failPending('Соединение закрыто');
      this.setStatus('offline');
      if (!this.closed && (this.options.reconnect ?? true)) this.scheduleReconnect();
    };
  }

  /**
   * Пауза перед повтором растёт вдвое и разбавлена случайностью: без неё
   * все клиенты, отвалившиеся при перезапуске ядра, вернутся одновременно.
   */
  private scheduleReconnect(): void {
    this.attempt++;
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.attempt - 1));
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private onFrame(
    raw: string,
    onReady?: (core: CoreInfo) => void,
    onFail?: (e: Error) => void,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = zServerFrame.safeParse(parsed);
    // Кадр, который не проходит схему, — признак несовместимости версий.
    // Молча игнорируем: пусть лучше не работает функция, чем ломается сессия.
    if (!frame.success) return;

    this.handle(frame.data, onReady, onFail);
  }

  private handle(
    frame: ServerFrame,
    onReady?: (core: CoreInfo) => void,
    onFail?: (e: Error) => void,
  ): void {
    switch (frame.t) {
      case 'hello': {
        this.attempt = 0;
        this.core = frame.core;
        if (frame.protocol !== PROTOCOL_VERSION) {
          this.failPending(`Версия протокола ядра (${frame.protocol}) не совпадает с клиентом`);
          this.close();
          return;
        }
        // Другое ядро — восстановленный бэкап, переезд, чужой адрес. Курсор
        // из прошлой жизни указывает в чужой журнал, состояние надо строить с нуля.
        if (this.state.coreId && this.state.coreId !== frame.core.coreId) {
          this.state.reset();
          this.historyLoaded.clear();
        }
        this.state.coreId = frame.core.coreId;

        // Ревизия ниже нашей — ядро законно старее приложения. Работать это не
        // мешает: списки, которых оно не знает, приедут пустыми. Но человеку
        // об этом надо сказать, иначе он будет искать пропавший раздел.
        this.coreOutdated = frame.revision < PROTOCOL_REVISION;

        void this.sync().then(() => {
          // Подключение считается удавшимся только после успешного догона.
          // Иначе `connect()` разрешался бы при оборванной синхронизации — или,
          // хуже, не разрешался никогда, и приложение висело бы молча.
          if (this.status === 'ready') onReady?.(frame.core);
          else onFail?.(this.lastError ?? new Error('Синхронизация не удалась'));
        });
        return;
      }

      case 'res': {
        const waiting = this.pending.get(frame.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(frame.id);
        waiting.resolve(frame.payload);
        return;
      }

      case 'err': {
        const waiting = this.pending.get(frame.id);
        if (!waiting) return;
        clearTimeout(waiting.timer);
        this.pending.delete(frame.id);
        waiting.reject(new AxonError(frame.error));
        return;
      }

      case 'evt': {
        const entry: JournalEntry = { seq: frame.seq, at: frame.at, event: frame.event };
        if (this.syncing) {
          this.buffered.push(entry);
          return;
        }
        this.applyEntry(entry);
        this.state.notify();
        return;
      }

      case 'sig':
        this.applySignal(frame.signal);
        for (const listener of this.signalListeners) listener(frame.signal);
        this.state.notify();
        return;

      case 'pong':
        return;
    }
  }

  // ─── Внутреннее: синхронизация ────────────────────────────────────────────

  /**
   * Догон журнала. Холодный старт идёт снапшотом — проигрывать всю историю
   * с начала времён ради текущего состояния незачем; дальше обычная догрузка
   * по курсору, пока не упрёмся в вершину.
   */
  private async sync(): Promise<void> {
    this.syncing = true;
    this.setStatus('syncing');

    try {
      if (this.state.cursor === 0) {
        const snapshot = await this.call('sync.snapshot', {});
        this.state.reset();
        this.historyLoaded.clear();

        // Списки читаем терпимо: ядро — отдельная программа и вполне законно
        // может быть старше приложения. Раздела, которого оно не знает, просто
        // не будет — и это гораздо лучше, чем упасть посреди догона.
        for (const conversation of snapshot.conversations ?? []) {
          this.state.conversations.set(conversation.id, conversation);
        }
        for (const fact of snapshot.facts ?? []) this.state.facts.set(fact.id, fact);
        for (const observation of snapshot.observations ?? []) {
          this.state.observations.set(observation.id, observation);
        }
        for (const device of snapshot.devices ?? []) this.state.devices.set(device.id, device);
        for (const tool of snapshot.tools ?? []) this.state.tools.set(tool.name, tool);
        for (const plugin of snapshot.plugins ?? []) this.state.plugins.set(plugin.id, plugin);
        for (const routine of snapshot.routines ?? []) {
          this.state.routines.set(routine.id, routine);
        }
        this.state.cursor = snapshot.cursor;
      }

      for (;;) {
        const page = await this.call('sync.pull', { since: this.state.cursor, limit: PULL_LIMIT });
        for (const entry of page.entries) this.applyEntry(entry);
        this.state.cursor = page.cursor;
        if (!page.hasMore) break;
      }

      // Живые события, накопленные во время догона, применяем по порядку;
      // те, что уже вошли в выдачу, отсеются по seq.
      this.buffered.sort((a, b) => a.seq - b.seq);
      for (const entry of this.buffered) this.applyEntry(entry);
      this.buffered.length = 0;

      this.ack();
      this.setStatus('ready');
      this.state.notify();
    } catch (error) {
      // Догон сорвался. Молчать здесь нельзя ни в коем случае: статус
      // «синхронизация» останется навсегда, и снаружи это выглядит как
      // повисшее приложение без единого слова о том, что произошло.
      this.fail(
        error instanceof Error ? error : new Error('Синхронизация не удалась'),
      );
    } finally {
      this.syncing = false;
    }
  }

  /** Сообщить о сбое и уйти в offline, а не остаться в промежуточном статусе. */
  private fail(error: Error): void {
    this.lastError = error;
    this.setStatus('offline');
    for (const listener of this.errorListeners) listener(error);
  }

  /** Единственное место, где двигается курсор, — иначе дыры неизбежны. */
  private applyEntry(entry: JournalEntry): void {
    if (entry.seq <= this.state.cursor) return;
    this.state.apply(entry.event);
    this.state.cursor = entry.seq;
    for (const listener of this.eventListeners) listener(entry);
  }

  private applySignal(signal: Signal): void {
    if (signal.type === 'presence') return;

    // Статус плагина не привязан к прогону: он приходит и когда никто ничего
    // не спрашивал — например, когда MCP-сервер поднялся через полминуты
    // после старта ядра.
    if (signal.type === 'plugin.status') {
      this.state.plugins.set(signal.plugin.id, signal.plugin);
      this.state.notify();
      return;
    }

    const stream = this.state.streams.get(signal.runId);
    // Сигнал по прогону, о котором мы ещё не знаем: догон не закончился либо
    // прогон стартовал до подключения. Терять не жалко — это эфемерика.
    if (!stream) return;

    switch (signal.type) {
      case 'run.delta':
        stream.text += signal.text;
        break;
      case 'run.phase':
        stream.phase = signal.phase;
        if (signal.detail !== undefined) stream.detail = signal.detail;
        break;
      case 'usage.tick':
        stream.tokensSpent += signal.usage.inputTokens + signal.usage.outputTokens;
        stream.costUsd += signal.usage.costUsd ?? 0;
        stream.budgetRemaining = signal.budgetRemaining;
        break;
    }
  }

  private ack(): void {
    this.socket?.send(JSON.stringify({ t: 'ack', cursor: this.state.cursor }));
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  private failPending(message: string): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new AxonError({ code: 'internal', message, retryable: true }));
    }
    this.pending.clear();
  }
}

function defaultSocketFactory(url: string): SocketLike {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => SocketLike }).WebSocket;
  if (!Ctor) {
    throw new Error(
      'В этой среде нет глобального WebSocket — передайте socketFactory в AxonClient',
    );
  }
  return new Ctor(url);
}

/**
 * Идентификатор запроса. Форма обязана быть настоящим UUID: ядро проверяет
 * кадр схемой и отбросит всё остальное — «лишь бы уникально» тут не работает.
 */
function uuid(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();

  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const variant = ((Math.floor(Math.random() * 4) + 8) & 0xf).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}
