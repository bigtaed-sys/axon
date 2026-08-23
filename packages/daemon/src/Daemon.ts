import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { CoreConfig, Runtime } from '@axon/core';
import { createRuntime, logger } from '@axon/core';
import { authenticate, PairingService } from './auth.js';
import { PermissionHub } from './PermissionHub.js';
import type { Signal } from '@axon/protocol';
import {
  API_HASH_SECRET,
  API_ID_SETTING,
  BOT_TOKEN_SECRET,
  SESSION_SECRET,
  TelegramAdapter,
  Userbot,
  UserbotAuth,
} from '@axon/telegram';
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
  /**
   * Адрес, по которому к ядру действительно можно обратиться.
   *
   * Не то же самое, что `host`: при `--host 0.0.0.0` ядро слушает все
   * интерфейсы, но `http://0.0.0.0:8787` — не адрес, а маска. Обратиться по
   * ней нельзя, а её печатали и складывали в `core.json`, откуда её брали и
   * `axon status`, и десктоп.
   */
  url: string;
  /** Куда стучаться с других устройств. Пусто, если слушаем только себя. */
  reachable: string[];
}

/** Маска «слушать всё», а не адрес: обратиться по ней нельзя. */
function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '';
}

/** IPv6 в URL пишется в скобках, иначе двоеточия съедает разбор порта. */
function asAuthority(host: string, port: number): string {
  return host.includes(':') ? `http://[${host}]:${port}` : `http://${host}:${port}`;
}

/**
 * Адреса, по которым ядро видно с других машин.
 *
 * Человек, поднявший ядро на сервере, следующим действием вводит адрес в
 * приложении. Без этого списка он ищет его сам — `ip a`, панель хостера,
 * догадки, — хотя ядро знает его лучше.
 */
function reachableUrls(port: number): string[] {
  const found: Array<{ address: string; v4: boolean }> = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const item of addresses ?? []) {
      if (item.internal) continue;
      // Link-local — адрес для разговора внутри одного сегмента, и без
      // указания интерфейса (`%eth0`) он не работает даже там. В списке
      // «куда подключаться» это чистый шум: их обычно больше, чем настоящих.
      if (item.address.startsWith('fe80') || item.address.startsWith('169.254.')) continue;
      found.push({ address: item.address, v4: item.family === 'IPv4' });
    }
  }
  // Сначала IPv4: их набирают руками, и человек скорее узнает свой адрес в них.
  found.sort((a, b) => Number(b.v4) - Number(a.v4));
  return found.map((item) => asAuthority(item.address, port));
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
  /** Агент под аккаунтом владельца. Поднимается, когда в секретах есть сессия. */
  readonly userbot: Userbot;
  /** Незавершённый вход: живёт между шагами «телефон → код → пароль». */
  private auth: UserbotAuth | null = null;
  /**
   * Кто ещё слушает эфемерику, кроме сокетов.
   *
   * Сигналы — куски ответа, фазы, расход — не журналируются и до сих пор
   * уходили только в WS-сессии. Телеграм живёт в этом же процессе и обычно без
   * единого открытого сокета: без такой подписки он не увидел бы, как растёт
   * ответ, и мог бы показать его только целиком в самом конце.
   */
  private readonly signalListeners = new Set<(signal: Signal) => void>();
  /**
   * Пропуск для того, кто сидит за этой машиной: им подписан запрос на новый
   * код подключения. Живёт в файле рядом с базой, с правами 0600.
   */
  private readonly controlToken = crypto.randomBytes(24).toString('hex');
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
          for (const listener of this.signalListeners) listener(signal);
        },
      },
      // Рабочее состояние плагина едет тем же каналом, что и остальная
      // эфемерика: клиент, который подключится позже, возьмёт актуальное из
      // снапшота, а досылать пропущенные статусы бессмысленно.
      onPluginStatus: (plugin) => {
        for (const session of this.sessions) session.emitSignal({ type: 'plugin.status', plugin });
      },
    });

    this.userbot = new Userbot({ runtime: this.runtime });

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
    this.address = {
      host,
      port: boundPort,
      url: isWildcard(host) ? `http://127.0.0.1:${boundPort}` : asAuthority(host, boundPort),
      reachable: isWildcard(host) ? reachableUrls(boundPort) : [],
    };

    const bootstrapCode = this.pairing.ensureBootstrapCode();
    this.writeControlToken();
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
    void this.syncUserbot();

    /**
     * Токен бота вписывают в настройках уже работающего ядра — значит,
     * адаптер должен подниматься без перезапуска. Слушаем изменение секретов
     * тем же журналом, что и клиенты: отдельного канала «для телеграма»,
     * который однажды разойдётся с настоящим, здесь нет.
     */
    this.runtime.store.journal.subscribe((entry) => {
      const event = entry.event;
      if (event.type !== 'settings.changed') return;
      if (event.keys.includes(BOT_TOKEN_SECRET)) void this.syncTelegram();
      if (event.keys.includes(SESSION_SECRET)) void this.syncUserbot();
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
        onSignal: (listener) => {
          this.signalListeners.add(listener);
          return () => this.signalListeners.delete(listener);
        },
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
   * Поднять или погасить юзербота по наличию сессии.
   *
   * Отдельно от бота: это разные вещи, и одна работает без другой. Бот —
   * канал к агенту, юзербот — команда `.axon` в чужих чатах от твоего имени.
   */
  private async syncUserbot(): Promise<void> {
    const session = this.runtime.store.secrets.reveal(SESSION_SECRET);
    const apiHash = this.runtime.store.secrets.reveal(API_HASH_SECRET);
    const apiId = Number(this.runtime.store.settings.get<string | number>(API_ID_SETTING) ?? 0);

    if (this.userbot.running) await this.userbot.stop();
    if (!session || !apiHash || !apiId) return;

    try {
      const { name } = await this.userbot.start(session, apiId, apiHash);
      logger.info({ name }, 'юзербот на связи');
    } catch (error) {
      // Сессия могла протухнуть: человек вышел из аккаунта в другом клиенте.
      logger.warn({ err: (error as Error).message }, 'юзербот не поднялся');
      await this.userbot.stop().catch(() => undefined);
    }
  }

  /**
   * Шаг входа в аккаунт.
   *
   * Состояние живёт между вызовами в `this.auth`: телеграм присылает код между
   * первым шагом и вторым, и всё это время соединение должно оставаться тем же.
   */
  async telegramLogin(step: 'phone' | 'code' | 'password' | 'cancel', value: string) {
    if (step === 'cancel') {
      await this.auth?.cancel();
      this.auth = null;
      return { state: 'cancelled' as const };
    }

    if (step === 'phone') {
      const apiId = Number(this.runtime.store.settings.get<string | number>(API_ID_SETTING) ?? 0);
      const apiHash = this.runtime.store.secrets.reveal(API_HASH_SECRET);
      if (!apiId || !apiHash) {
        throw new Error('Сначала укажите api_id и api_hash с my.telegram.org');
      }
      this.auth = new UserbotAuth(apiId, apiHash);
    }

    if (!this.auth) throw new Error('Вход не начат');

    const result =
      step === 'phone'
        ? await this.auth.sendCode(value)
        : step === 'code'
          ? await this.auth.signIn(value)
          : await this.auth.checkPassword(value);

    if (result.kind === 'code_sent') return { state: 'code_sent' as const, hint: result.hint };
    if (result.kind === 'password_needed') return { state: 'password_needed' as const };

    // Сессия уходит прямо в секреты и наружу не возвращается никогда.
    this.runtime.store.updateSettings({ secrets: { [SESSION_SECRET]: result.session } });
    this.auth = null;
    await this.syncUserbot();

    return { state: 'done' as const, name: result.name };
  }

  async telegramLogout(): Promise<void> {
    await this.userbot.stop();
    this.runtime.store.updateSettings({ secrets: { [SESSION_SECRET]: null } });
  }

  telegramStatus() {
    return {
      bot: this.telegram !== null,
      user: this.userbot.running,
    };
  }

  /**
   * Заявка о себе рядом с данными.
   *
   * Ядро — самостоятельная программа, и запустить его может кто угодно:
   * автозагрузка, systemd, рука в терминале, приложение. Чтобы клиент на этой
   * же машине мог его найти, не завися от того, кто его поднял, адрес и pid
   * кладутся в файл рядом с базой.
   */
  private controlPath(): string {
    return path.join(this.runtime.config.dataDir, 'control.token');
  }

  /**
   * Пропуск переписывается на каждом запуске: старый файл, оставшийся от
   * убитого процесса, не должен открывать двери в новое ядро.
   */
  private writeControlToken(): void {
    fs.mkdirSync(this.runtime.config.dataDir, { recursive: true });
    fs.writeFileSync(this.controlPath(), `${this.controlToken}\n`, { mode: 0o600 });
  }

  /** Сравнение постоянного времени: пропуск подбирают по одному символу. */
  private controlAllowed(given: string | string[] | undefined): boolean {
    const value = Array.isArray(given) ? given[0] : given;
    if (!value) return false;
    const a = Buffer.from(value.trim());
    const b = Buffer.from(this.controlToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private announce(): void {
    const file = path.join(this.runtime.config.dataDir, 'core.json');
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          url: this.address!.url,
          reachable: this.address!.reachable,
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
    await this.userbot.stop();
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

    /**
     * Выдать код подключения тому, кто сидит за этой машиной.
     *
     * Без неё человек, потерявший единственное устройство (или потративший
     * одноразовый код на неудачную попытку), оставался запертым снаружи: код
     * первого подключения живёт только пока устройств нет, а попросить новый
     * можно было лишь с уже подключённого устройства.
     *
     * Доказательство права — не пароль, а доступ к файлу `control.token`
     * рядом с базой: он лежит с правами 0600, и прочитать его может тот же,
     * кто и так может прочитать саму базу с ключом шифрования. Проверять
     * что-то сверх этого — театр. Но и меньше нельзя: ядро слушает сеть, и
     * без файла ручка выдавала бы полный доступ любому, кто дотянется.
     */
    if (req.method === 'POST' && url.pathname === '/v1/control/pair') {
      if (!this.controlAllowed(req.headers['x-axon-control'])) {
        return respond(res, 403, { error: 'forbidden' });
      }

      const body = await readJson(req);
      const chatOnly = body?.['scopes'] === 'chat';
      const ttl = Number(body?.['ttlSeconds'] ?? 300);

      const issued = this.pairing.begin({
        name: typeof body?.['name'] === 'string' ? (body['name'] as string) : 'Новое устройство',
        platform: 'desktop',
        scopes: chatOnly
          ? ['chat.read', 'chat.write', 'tools.safe']
          : [
              'chat.read',
              'chat.write',
              'tools.safe',
              'tools.sensitive',
              'tools.dangerous',
              'settings.write',
              'devices.manage',
            ],
        ttlSeconds: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 3600) : 300,
      });
      return respond(res, 200, issued);
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
        telegram: this,
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
