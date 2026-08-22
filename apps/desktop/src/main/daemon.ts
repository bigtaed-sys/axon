import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = __dirname;
const STARTUP_TIMEOUT_MS = 20_000;
/** Сколько ждать корректного завершения, прежде чем убивать процесс. */
const SHUTDOWN_GRACE_MS = 6_000;

interface CoreRecord {
  url: string;
  pid: number;
  coreId: string;
}

/**
 * Ядро на этой машине.
 *
 * Оно самостоятельная программа со своей жизнью: приложение его находит, при
 * необходимости запускает — и на этом всё. Закрытие окна ядро не останавливает,
 * иначе «агент живёт на машине» было бы неправдой: ни рутин по расписанию, ни
 * телеграма, ни фоновой работы.
 *
 * Отсюда и способ обнаружения: ядро при старте кладёт рядом с базой файл со
 * своим адресом, а приложение его читает. Кто именно запустил ядро —
 * автозагрузка, терминал, прошлый сеанс приложения — значения не имеет.
 */
export class LocalCore {
  constructor(private readonly dataDir: string) {}

  /** Адрес запущенного ядра или `null`. */
  async discover(): Promise<string | null> {
    const record = this.record();
    if (!record) return null;

    const alive = await fetch(`${record.url}/health`)
      .then((r) => r.ok)
      .catch(() => false);

    // Запись могла остаться от убитого процесса — тогда она бесполезна.
    return alive ? record.url : null;
  }

  /** Найти запущенное ядро или поднять своё. */
  async ensureRunning(host: string): Promise<string> {
    const existing = await this.discover();
    if (existing) return existing;

    this.spawnDetached(host);
    return await this.waitForStartup();
  }

  /**
   * Чем и как запускать ядро — для записи в автозагрузку.
   *
   * Порт здесь фиксированный, в отличие от запуска из приложения: адрес,
   * поднятый при входе в систему, должен быть предсказуемым — по нему будут
   * подключаться другие устройства.
   */
  launchSpec(host: string, port = 8787): {
    command: string;
    args: string[];
    env: Record<string, string>;
  } {
    const runtime = resolveNodeRuntime();
    return {
      command: runtime.command,
      args: [this.resolveCli(), 'start', '--port', String(port), '--host', host],
      env: { ...runtime.env, AXON_DATA_DIR: this.dataDir },
    };
  }

  /** Остановить ядро — по явной просьбе пользователя, не при выходе. */
  stop(): boolean {
    const record = this.record();
    if (!record) return false;
    try {
      process.kill(record.pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Остановить и дождаться, пока ядро действительно уйдёт.
   *
   * Просто послать SIGTERM недостаточно: если ядро завязло — например, ждёт
   * ответа от зависшего MCP-сервера, — то следующий `ensureRunning` найдёт его
   * живым и вернёт как есть. Снаружи это выглядит как перезапуск, который
   * молча ничего не сделал: худший вид отказа. Поэтому после отведённого
   * времени процесс убивается жёстко.
   */
  async stopAndWait(): Promise<void> {
    const record = this.record();
    if (!record) return;

    this.stop();

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (Date.now() < deadline) {
      if ((await this.discover()) === null) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    try {
      process.kill(record.pid, 'SIGKILL');
    } catch {
      // Уже умер между проверкой и убийством — ровно то, чего мы и хотели.
    }
    // Запись могла остаться от убитого процесса: убираем, иначе `discover`
    // будет ходить по мёртвому адресу, пока новое ядро не перезапишет файл.
    fs.rmSync(path.join(this.dataDir, 'core.json'), { force: true });
  }

  /**
   * Токен для разговора с ядром.
   *
   * Если сохранённый не подошёл, берём код первого подключения из файла рядом
   * с базой — тот же приём, что у Jupyter. Мы на той же машине, что и ядро,
   * поэтому право прочитать этот файл и есть доказательство, что подключаться
   * нам можно.
   */
  async obtainToken(url: string, knownToken: string | null): Promise<string> {
    if (knownToken && (await this.tokenWorks(url, knownToken))) return knownToken;

    const codePath = path.join(this.dataDir, 'bootstrap.code');
    const code = fs.existsSync(codePath) ? fs.readFileSync(codePath, 'utf8').trim() : null;
    if (!code) {
      throw new Error(
        'Ядро уже знает другие устройства, а токен этого потерян. ' +
          'Выдайте код подключения с доверенного устройства.',
      );
    }

    const response = await fetch(`${url}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: 'Десктоп' }),
    });
    if (!response.ok) throw new Error('Ядро отклонило подключение');

    return ((await response.json()) as { token: string }).token;
  }

  // ─── Внутреннее ───────────────────────────────────────────────────────────

  private record(): CoreRecord | null {
    try {
      return JSON.parse(
        fs.readFileSync(path.join(this.dataDir, 'core.json'), 'utf8'),
      ) as CoreRecord;
    } catch {
      return null;
    }
  }

  private spawnDetached(host: string): void {
    const runtime = resolveNodeRuntime();
    const args = [
      this.resolveCli(),
      'start',
      '--port',
      '0',
      '--host',
      host,
      '--mode',
      'embedded',
    ];

    // detached + unref: процесс отвязывается от приложения и переживает его
    // выход. Потоки закрыты — иначе дочерний процесс держал бы наши каналы.
    const child = spawn(runtime.command, args, {
      env: { ...process.env, ...runtime.env, AXON_DATA_DIR: this.dataDir },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  /** Ждём, пока ядро объявится файлом и начнёт отвечать. */
  private async waitForStartup(): Promise<string> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const url = await this.discover();
      if (url) return url;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Ядро не отозвалось за 20 секунд');
  }

  private async tokenWorks(url: string, token: string): Promise<boolean> {
    try {
      const response = await fetch(`${url}/v1/blobs/проверка`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // 404 — токен принят, файла нет. 401 — токен отозван.
      return response.status !== 401;
    } catch {
      return false;
    }
  }

  /** В разработке ядро лежит в монорепе, в собранном приложении — в ресурсах. */
  private resolveCli(): string {
    const candidates = [
      path.resolve(here, '../../../../packages/daemon/dist/cli.js'),
      path.resolve(process.resourcesPath ?? '', 'daemon/cli.js'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error(`Не нашёл ядро. Искал: ${candidates.join(', ')}`);
    return found;
  }
}

interface NodeRuntime {
  command: string;
  env: Record<string, string>;
}

/**
 * Чем запускать ядро.
 *
 * `ELECTRON_RUN_AS_NODE` даёт не системный Node, а тот, что внутри Electron —
 * со своей версией ABI. Нативный better-sqlite3, собранный под обычный Node,
 * под ним не загрузится, и наоборот: выбор рантайма и сборка нативного модуля —
 * одно решение, а не два.
 *
 * Пока действуем так: если рядом есть системный Node — берём его, потому что
 * под него модуль уже собран. Для собранного приложения нужен бинарник,
 * пересобранный под ABI Electron, — тогда сработает вторая ветка.
 */
function resolveNodeRuntime(): NodeRuntime {
  const explicit = process.env['AXON_NODE'];
  if (explicit) return { command: explicit, env: {} };

  const probe = spawnSync('node', ['-v'], { encoding: 'utf8' });
  if (probe.status === 0) return { command: 'node', env: {} };

  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}
