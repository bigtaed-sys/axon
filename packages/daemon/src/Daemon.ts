import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { CoreConfig, Runtime } from '@axon/core';
import { createRuntime, logger } from '@axon/core';
import { authenticate, PairingService } from './auth.js';
import { PermissionHub } from './PermissionHub.js';
import { BOT_TOKEN_SECRET, TelegramAdapter } from '@axon/telegram';
import { WsSession } from './WsSession.js';

/** Подставляется при сборке пакета; в разработке остаётся пометка. */
declare const __AXON_VERSION__: string;
export const DAEMON_VERSION =
  typeof __AXON_VERSION__ === 'string' ? __AXON_VERSION__ : '0.0.0-dev';
/** Потолок загружаемого блоба. Без него один запрос кладёт ядро по памяти. */
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export interface DaemonOptions {
  config?: Partial<CoreConfig>;
  host?: string;
  port?: number;
  /** `embedded` — ядро внутри десктопа, `standalone` — отдельный сервис. */
  mode?: 'embedded' | 'standalone';
}

export interface DaemonAddress {
  host: string;
  port: number;
  url: string;
}

/**
 * Демон: тонкая обвязка вокруг ядра.
 *
 * Живой канал — один WebSocket, по нему идёт всё, кроме блобов: файлы
 * качаются обычным HTTP, чтобы не забивать канал и не терять докачку с
 * кэшированием на стороне клиента.
 *
 * TLS здесь намеренно нет. Локально он не нужен, а для доступа снаружи
 * правильный слой — туннель или обратный прокси: самоподписанный сертификат
 * внутри демона дал бы иллюзию защиты и кучу проблем с доверием.
 */
export class Daemon {
  readonly runtime: Runtime;
  private readonly sessions = new Set<WsSession>();
  private readonly pairing: PairingService;
  private readonly permissions: PermissionHub;
  private readonly server: http.Server;
  private readonly wss: WebSocketServer;
  private address: DaemonAddress | null = null;
  private telegram: TelegramAdapter | null = null;
  /** Разрешается, когда все установленные плагины отработали запуск. */
  pluginsReady: Promise<void> = Promise.resolve();

  constructor(private readonly options: DaemonOptions = {}) {
    this.permissions = new PermissionHub(() => this.hasAudience());

    this.runtime = createRuntime({
      ...(options.config ? { config: options.config } : {}),
      permissions: this.permissions,
      sink: {
        emit: (signal) => {
          for (const session of this.sessions) session.emitSignal(signal);
        },
      },
      // Рабочее состояние плагина едет тем же каналом, что и остальная
      // эфемерика: клиент, который подключится позже, возьмёт актуальное из
      // снапшота, а досылать пропущенные статусы бессмысленно.
      onPluginStatus: (plugin) => {
        for (const session of this.sessions) session.emitSignal({ type: 'plugin.status', plugin });
      },
    });

    this.pairing = new PairingService(
      this.runtime,
      path.join(this.runtime.config.dataDir, 'bootstrap.code'),
    );

    this.server = http.createServer((req, res) => {
      void this.onRequest(req, res).catch((e) => {
        logger.error({ err: (e as Error).message }, 'HTTP-обработчик упал');
        respond(res, 500, { error: 'internal' });
      });
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
  }

  async start(): Promise<{ address: DaemonAddress; bootstrapCode: string | null }> {
    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? 8787;

    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    const actual = this.server.address();
    const boundPort = typeof actual === 'object' && actual ? actual.port : port;
    this.address = { host, port: boundPort, url: `http://${host}:${boundPort}` };

    const bootstrapCode = this.pairing.ensureBootstrapCode();
    this.announce();
    logger.info({ url: this.address.url, coreId: this.runtime.coreId }, 'демон слушает');

    // Плагины поднимаются после того, как ядро начало слушать, и не задерживают
    // готовность: `npx`, тянущий MCP-сервер из сети, думает десятки секунд, и
    // всё это время приложение видело бы «ядро не отвечает». Клиенты узнают о
    // каждом плагине сигналом, когда он поднимется.
    this.pluginsReady = this.runtime.startPlugins().catch((error: Error) => {
      logger.error({ err: error.message }, 'плагины не поднялись');
    });

    void this.syncTelegram();

    /**
     * Токен бота вписывают в настройках уже работающего ядра — значит,
     * адаптер должен подниматься без перезапуска. Слушаем изменение секретов
     * тем же журналом, что и клиенты: отдельного канала «для телеграма»,
     * который однажды разойдётся с настоящим, здесь нет.
     */
    this.runtime.store.journal.subscribe((entry) => {
      const event = entry.event;
      if (event.type !== 'settings.changed') return;
      if (!event.keys.includes(BOT_TOKEN_SECRET)) return;
      void this.syncTelegram();
    });

    return { address: this.address, bootstrapCode };
  }

  /**
   * Поднять или погасить телеграм по наличию токена.
   *
   * Токен есть — бот работает, токена нет — не работает. Отдельного
   * переключателя «включить телеграм» нет намеренно: он был бы вторым
   * источником правды, и рано или поздно человек оказался бы с введённым
   * токеном и выключенным ботом, не понимая почему.
   */
  private async syncTelegram(): Promise<void> {
    const token = this.runtime.store.secrets.reveal(BOT_TOKEN_SECRET);

    if (this.telegram) {
      await this.telegram.stop();
      this.telegram = null;
    }
    if (!token) return;

    const adapter = new TelegramAdapter(
      {
        runtime: this.runtime,
        pair: (code, name) => this.pairing.complete(code, name),
        resolvePermission: (requestId, allow) =>
          void this.permissions.resolve(requestId, allow ? 'allow_once' : 'deny_once'),
      },
      token,
    );

    try {
      const { username } = await adapter.start();
      this.telegram = adapter;
      logger.info({ username }, 'телеграм на связи');
    } catch (error) {
      // Неверный токен — обычное дело при вводе руками. Ядро из-за этого
      // падать не должно: остальные каналы работают.
      logger.warn({ err: (error as Error).message }, 'телеграм не поднялся');
      await adapter.stop().catch(() => undefined);
    }
  }

  /**
   * Заявка о себе рядом с данными.
   *
   * Ядро — самостоятельная программа, и запустить его может кто угодно:
   * автозагрузка, systemd, рука в терминале, приложение. Чтобы клиент на этой
   * же машине мог его найти, не завися от того, кто его поднял, адрес и pid
   * кладутся в файл рядом с базой.
   */
  private announce(): void {
    const file = path.join(this.runtime.config.dataDir, 'core.json');
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          url: this.address!.url,
          pid: process.pid,
          coreId: this.runtime.coreId,
          mode: this.options.mode ?? 'standalone',
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  private withdraw(): void {
    fs.rmSync(path.join(this.runtime.config.dataDir, 'core.json'), { force: true });
  }

  async stop(): Promise<void> {
    // Порядок важен: сначала снимаем прогоны, потом закрываем базу. Иначе
    // прогон, дошедший до записи в журнал после close(), роняет процесс.
    this.runtime.orchestrator.cancelAll();
    await this.telegram?.stop();
    this.permissions.shutdown();
    for (const session of this.sessions) session.close();
    this.sessions.clear();

    // Открытые сокеты надо рвать явно: они прошли через upgrade, поэтому
    // http-сервер считает их своими и `close()` будет ждать их вечно.
    for (const socket of this.wss.clients) socket.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.withdraw();
    await this.runtime.close();
    logger.info('демон остановлен');
  }

  get url(): string {
    if (!this.address) throw new Error('Демон ещё не запущен');
    return this.address.url;
  }

  /** Есть ли на связи устройство, способное ответить на запрос разрешения. */
  private hasAudience(): boolean {
    for (const session of this.sessions) {
      if (session.canReceiveSignals()) return true;
    }
    // Ядро на сервере обычно работает без открытого десктопа, и телеграм там —
    // единственный, кто может подтвердить действие.
    return this.telegram?.hasAudience ?? false;
  }

  // ─── HTTP ─────────────────────────────────────────────────────────────────

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return respond(res, 200, {
        ok: true,
        coreId: this.runtime.coreId,
        version: DAEMON_VERSION,
        mode: this.options.mode ?? 'standalone',
        devices: this.sessions.size,
        pendingPermissions: this.permissions.pendingCount,
      });
    }

    // Единственная ручка без токена: новому устройству его ещё неоткуда взять.
    if (req.method === 'POST' && url.pathname === '/v1/pair') {
      const body = await readJson(req);
      const code = typeof body?.['code'] === 'string' ? body['code'] : '';
      const name = typeof body?.['name'] === 'string' ? body['name'] : undefined;

      const paired = this.pairing.complete(code.trim().toUpperCase(), name);
      if (!paired) return respond(res, 403, { error: 'invalid_code' });

      return respond(res, 200, {
        token: paired.token,
        device: paired.device,
        core: { coreId: this.runtime.coreId, version: DAEMON_VERSION },
      });
    }

    const device = authenticate(this.runtime, tokenFrom(req, url));
    if (!device) return respond(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname.startsWith('/v1/blobs/')) {
      if (!device.scopes.includes('chat.read')) return respond(res, 403, { error: 'forbidden' });
      return this.sendBlob(res, url.pathname.slice('/v1/blobs/'.length));
    }

    if (req.method === 'POST' && url.pathname === '/v1/blobs') {
      if (!device.scopes.includes('chat.write')) return respond(res, 403, { error: 'forbidden' });
      const data = await readBody(req);
      if (!data) return respond(res, 413, { error: 'too_large' });

      const written = await this.runtime.blobs.write({
        data,
        mime: req.headers['content-type'] ?? 'application/octet-stream',
        ...(url.searchParams.get('name') ? { name: url.searchParams.get('name')! } : {}),
      });
      return respond(res, 200, written);
    }

    respond(res, 404, { error: 'not_found' });
  }

  private sendBlob(res: http.ServerResponse, blobId: string): void {
    const meta = this.runtime.blobs.meta(blobId);
    const filePath = this.runtime.blobs.pathOf(blobId);
    if (!meta || !filePath) return respond(res, 404, { error: 'not_found' });

    res.writeHead(200, {
      'Content-Type': meta.mime,
      'Content-Length': String(meta.bytes),
      // Содержимое адресуется хэшем и никогда не меняется под тем же id.
      'Cache-Control': 'private, max-age=31536000, immutable',
      ETag: `"${meta.sha256}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  private onUpgrade(
    req: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/v1/ws') {
      socket.destroy();
      return;
    }

    const device = authenticate(this.runtime, tokenFrom(req, url));
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const session = new WsSession(ws, device, {
        runtime: this.runtime,
        pairing: this.pairing,
        permissions: this.permissions,
        version: DAEMON_VERSION,
        mode: this.options.mode ?? 'standalone',
      });
      this.sessions.add(session);
      ws.on('close', () => this.sessions.delete(session));
    });
  }
}

// ─── Вспомогательное ────────────────────────────────────────────────────────

/**
 * Токен ищем и в заголовке, и в query: браузер не умеет ставить заголовки
 * при открытии WebSocket, так что query — не удобство, а необходимость.
 */
function tokenFrom(req: http.IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return url.searchParams.get('token');
}

function respond(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_UPLOAD_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  const body = await readBody(req);
  if (!body || body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
