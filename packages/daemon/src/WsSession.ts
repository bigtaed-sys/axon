import type { WebSocket } from 'ws';
import {
  PROTOCOL_REVISION,
  PROTOCOL_VERSION,
  zClientFrame,
  type Device,
  type JournalEntry,
  type ServerFrame,
  type Signal,
} from '@axon/protocol';
import { logger, type Runtime } from '@axon/core';
import type { PairingService } from './auth.js';
import { CommandError, dispatch } from './commands.js';
import type { PermissionHub } from './PermissionHub.js';

/**
 * Порог буфера сокета, после которого перестаём слать эфемерику.
 *
 * Журнальные события мы обязаны доставить — на них держится синхронизация.
 * Поток токенов доставлять не обязаны: потеря дельты не ломает состояние,
 * итоговое сообщение всё равно придёт событием. Поэтому при заторе жертвуем
 * именно сигналами, а не событиями.
 */
const BACKPRESSURE_BYTES = 1 << 20;

export interface SessionDeps {
  runtime: Runtime;
  pairing: PairingService;
  permissions: PermissionHub;
  version: string;
  mode: 'embedded' | 'standalone';
}

export class WsSession {
  private readonly unsubscribe: () => void;
  private droppedSignals = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly device: Device,
    private readonly deps: SessionDeps,
  ) {
    this.send({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      revision: PROTOCOL_REVISION,
      core: {
        coreId: deps.runtime.coreId,
        version: deps.version,
        mode: deps.mode,
        scopes: device.scopes,
      },
      head: deps.runtime.store.head(),
    });

    this.unsubscribe = deps.runtime.store.journal.subscribe((entry) => this.onJournal(entry));
    socket.on('message', (data) => void this.onMessage(data.toString()));
    socket.on('close', () => this.close());
    socket.on('error', (e) => logger.warn({ err: e.message }, 'ошибка сокета'));

    deps.runtime.store.devices.seen(device.id, new Date().toISOString());
  }

  get deviceId(): string {
    return this.device.id;
  }

  canReceiveSignals(): boolean {
    return this.device.scopes.includes('chat.read');
  }

  /** Эфемерика: доставляется по возможности. */
  emitSignal(signal: Signal): void {
    if (!this.canReceiveSignals()) return;
    if (this.socket.bufferedAmount > BACKPRESSURE_BYTES) {
      this.droppedSignals++;
      return;
    }
    this.send({ t: 'sig', signal });
  }

  close(): void {
    this.unsubscribe();
    if (this.droppedSignals > 0) {
      logger.info({ device: this.device.id, dropped: this.droppedSignals }, 'сигналы отбрасывались');
    }
  }

  // ─── Внутреннее ───────────────────────────────────────────────────────────

  private onJournal(entry: JournalEntry): void {
    if (!this.device.scopes.includes('chat.read')) return;
    this.send({ t: 'evt', seq: entry.seq, at: entry.at, event: entry.event });
  }

  private async onMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.send({
        t: 'err',
        id: '00000000-0000-4000-8000-000000000000',
        error: { code: 'bad_request', message: 'Кадр не является JSON', retryable: false },
      });
    }

    const frame = zClientFrame.safeParse(parsed);
    if (!frame.success) {
      return this.send({
        t: 'err',
        id: '00000000-0000-4000-8000-000000000000',
        error: {
          code: 'bad_request',
          message: frame.error.issues.map((i) => i.message).join('; '),
          retryable: false,
        },
      });
    }

    switch (frame.data.t) {
      case 'ping':
        return this.send({ t: 'pong' });

      case 'ack':
        // Курсор устройства нужен, чтобы после переподключения знать,
        // с чего досылать, не полагаясь на память клиента.
        this.deps.runtime.store.devices.setCursor(this.device.id, frame.data.cursor);
        return;

      case 'req':
        return await this.handleRequest(frame.data.id, frame.data.cmd, frame.data.payload);
    }
  }

  private async handleRequest(id: string, cmd: string, payload: unknown): Promise<void> {
    try {
      const result = await dispatch(cmd, payload, {
        runtime: this.deps.runtime,
        device: this.device,
        pairing: this.deps.pairing,
        permissions: this.deps.permissions,
      });
      this.send({ t: 'res', id, payload: result });
    } catch (e) {
      if (e instanceof CommandError) {
        return this.send({
          t: 'err',
          id,
          error: { code: e.code, message: e.message, retryable: false },
        });
      }
      const error = e as Error;
      logger.error({ err: error.message, cmd }, 'команда упала');
      this.send({
        t: 'err',
        id,
        error: { code: 'internal', message: error.message, retryable: true },
      });
    }
  }

  private send(frame: ServerFrame): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }
}
