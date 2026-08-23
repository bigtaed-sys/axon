import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, type Logger } from '../logger.js';
import { HOST_READY, TO_PLUGIN, type ActivateParams, type HostReadyParams } from './contract.js';
import { RpcError, RpcPeer, type CallOptions, type RpcFrame, type RpcHandler } from './rpc.js';

export interface LogLine {
  at: string;
  level: string;
  text: string;
}

export interface PluginProcessOptions {
  pluginId: string;
  /** Корень плагина на диске. */
  dir: string;
  /** Личная папка данных плагина. */
  dataDir: string;
  /** Значения настроек, которые уедут в `activate`. */
  settings: Record<string, unknown>;
  /** Что делать, когда процесс умер сам. */
  onExit(reason: string): void;
  /** Сколько ждать `activate`, прежде чем считать плагин зависшим. */
  startTimeoutMs?: number;
}

/** Сколько строк вывода плагина держать. Больше — просто мусор в памяти. */
const LOG_CAPACITY = 300;
const DEFAULT_START_TIMEOUT = 30_000;
/** Сколько ждать корректного завершения, прежде чем убивать. */
const STOP_GRACE_MS = 3_000;

/**
 * Один плагин — один процесс.
 *
 * Именно здесь окупается решение вынести плагины наружу: бесконечный цикл,
 * утечка памяти или `process.exit()` внутри плагина убивают только его. Ядро
 * узнаёт об этом из `exit`, показывает статус и продолжает работать.
 */
export class PluginProcess {
  readonly peer: RpcPeer;
  private child: ChildProcess | null = null;
  private readonly log: Logger;
  private readonly lines: LogLine[] = [];
  private ready = false;
  private stopping = false;

  constructor(private readonly options: PluginProcessOptions) {
    this.log = logger.child({ plugin: options.pluginId });
    this.peer = new RpcPeer((frame) => {
      // Процесс мог умереть между решением отправить и отправкой.
      if (!this.child?.connected) throw new RpcError('Процесс плагина не на связи', 'not_running');
      this.child.send(frame);
    });
  }

  get running(): boolean {
    return this.ready && this.child?.connected === true;
  }

  /** Последние строки вывода — то, что показывается в «Логах» плагина. */
  logs(limit: number): LogLine[] {
    return this.lines.slice(-limit);
  }

  record(level: string, text: string): void {
    this.lines.push({ at: new Date().toISOString(), level, text });
    if (this.lines.length > LOG_CAPACITY) this.lines.splice(0, this.lines.length - LOG_CAPACITY);
  }

  /** Обработчик вызова со стороны плагина. Ставится до `start`. */
  handle(method: string, handler: RpcHandler): void {
    this.peer.handle(method, handler);
  }

  call<T>(method: string, params?: unknown, options?: CallOptions): Promise<T> {
    return this.peer.call<T>(method, params, options);
  }

  emit(method: string, params?: unknown): void {
    this.peer.emit(method, params);
  }

  // ─── Жизненный цикл ───────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.child) throw new Error('Процесс плагина уже запущен');
    this.stopping = false;
    this.ready = false;

    const script = resolveHostScript();
    const child = fork(script, [], {
      cwd: this.options.dir,
      // stdout/stderr отдельными трубами: всё, что плагин напечатает, попадает
      // в его собственный лог, а не в вывод ядра, где его никто не свяжет с
      // источником.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        AXON_PLUGIN_ID: this.options.pluginId,
        AXON_PLUGIN_DIR: this.options.dir,
        AXON_PLUGIN_DATA_DIR: this.options.dataDir,
        // Если ядро встроено в десктоп, execPath — это Electron, и без этого
        // флага он поднимет второе окно вместо процесса Node.
        ELECTRON_RUN_AS_NODE: '1',
      },
      /**
       * Без этого на Windows у каждого плагина открывается чёрное окно консоли.
       *
       * Node запускается новым процессом, и система заводит ему окно, даже
       * когда вывод перехвачен трубами. Для MCP-серверов это уже учтено, а
       * форк плагина был пропущен: человек включает плагин и получает поверх
       * приложения консоль, которую нельзя закрыть, не убив плагин.
       *
       * В типах `ForkOptions` этого поля нет, хотя `fork` передаёт опции в
       * `spawn`, где оно работает. Приведение — цена за расхождение типов с
       * поведением, и молчаливое окно у пользователя дороже.
       */
      ...({ windowsHide: true } as object),
    });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.recordOutput('info', chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.recordOutput('error', chunk));
    child.on('message', (frame) => this.peer.receive(frame as RpcFrame));

    const started = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Плагин не отозвался за ${this.startTimeout() / 1000} с`));
      }, this.startTimeout());
      timer.unref?.();

      this.peer.onEvent<HostReadyParams>(HOST_READY, () => {
        clearTimeout(timer);
        this.ready = true;
        resolve();
      });

      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`Процесс завершился до готовности (${signal ?? code})`));
      });
    });

    child.once('exit', (code, signal) => {
      this.child = null;
      this.ready = false;
      this.peer.dispose(new RpcError('Процесс плагина завершён', 'not_running'));
      if (this.stopping) return;
      const reason = signal ? `убит сигналом ${signal}` : `завершился с кодом ${code}`;
      this.log.warn({ code, signal }, 'плагин упал');
      this.options.onExit(reason);
    });

    await started;

    const params: ActivateParams = {
      pluginId: this.options.pluginId,
      dir: this.options.dir,
      dataDir: this.options.dataDir,
      settings: this.options.settings,
    };
    await this.peer.call(TO_PLUGIN.activate, params, { timeoutMs: this.startTimeout() });
  }

  /**
   * Остановить: сначала по-хорошему, потом силой.
   *
   * Ждать бесконечно нельзя — плагин с зависшим `deactivate` не должен мешать
   * ядру выключиться. Поэтому граница по времени, и после неё SIGKILL.
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;

    try {
      await this.peer.call(TO_PLUGIN.deactivate, {}, { timeoutMs: STOP_GRACE_MS });
    } catch {
      // Уже мёртв, не отвечает или не успел — дальше всё равно убиваем.
    }

    if (!child.connected && child.exitCode !== null) {
      this.child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, STOP_GRACE_MS);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });

    this.child = null;
    this.ready = false;
    this.peer.dispose(new RpcError('Плагин остановлен', 'not_running'));
  }

  private startTimeout(): number {
    return this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT;
  }

  private recordOutput(level: string, chunk: Buffer): void {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) this.record(level, line);
    }
  }
}

/**
 * Где лежит скрипт хоста.
 *
 * Вариантов два, и оба настоящие: в собранном npm-пакете рядом с бандлом лежит
 * `plugin-host.js`, а в разработке и тестах — обычная сборка tsc в dist ядра.
 * Проверяем оба, потому что угадать по флагу окружения нельзя: тесты гоняют
 * тот же код, что и продакшен.
 */
export function resolveHostScript(): string {
  const override = process.env['AXON_PLUGIN_HOST'];
  if (override) return override;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Бандл демона: точка входа хоста лежит соседним файлом.
    path.join(here, 'plugin-host.js'),
    // Обычная сборка: этот файл в dist/plugins, там же и host-entry.js.
    path.join(here, 'host-entry.js'),
    // Тесты: vitest исполняет исходники, и `here` указывает в src. Собранный
    // хост при этом лежит в dist — форкать .ts всё равно нельзя.
    path.join(here, '..', '..', 'dist', 'plugins', 'host-entry.js'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Не найден скрипт хоста плагинов. Искал: ${candidates.join(', ')}. ` +
      'Задай путь через AXON_PLUGIN_HOST.',
  );
}
