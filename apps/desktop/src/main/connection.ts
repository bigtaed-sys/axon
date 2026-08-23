import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalCore } from './daemon.js';

export type ConnectionMode = 'embedded' | 'remote';

export interface Connection {
  mode: ConnectionMode;
  url: string;
  token: string;
  /** Человеческая подпись удалённого ядра — показывается в интерфейсе. */
  label?: string;
  /** Своё ядро доступно из локальной сети. */
  exposed?: boolean;
  /** Адреса, по которым до него можно достучаться с других устройств. */
  lan?: string[];
}

interface StoredConfig {
  active: ConnectionMode;
  embedded?: { token: string; exposed?: boolean };
  remote?: { url: string; token: string; label?: string };
}

/**
 * Куда подключается приложение.
 *
 * Два режима: своё ядро рядом с приложением и чужое — на сервере, на другом
 * компьютере, где угодно. Токены обоих хранятся раздельно, поэтому переключение
 * туда-обратно не требует нового пейринга: подключился к серверу, вернулся к
 * своему ядру — оба помнят.
 */
export class ConnectionManager {
  private readonly local: LocalCore;
  private current: Connection | null = null;

  constructor(private readonly userDataDir: string) {
    this.local = new LocalCore(path.join(userDataDir, 'core'));
  }

  get connection(): Connection | null {
    return this.current;
  }

  /** Поднять то, что было выбрано в прошлый раз. */
  async start(): Promise<Connection> {
    const config = this.load();
    if (config.active === 'remote' && config.remote) {
      this.current = { mode: 'remote', ...config.remote };
      return this.current;
    }
    return await this.useEmbedded();
  }

  /**
   * Своё ядро: поднимаем процесс рядом и подключаемся к нему.
   *
   * По умолчанию оно слушает только локальный адрес — до него не достучаться
   * даже из своей сети. Это правильный дефолт: агент с доступом к файлам и
   * оболочке не должен становиться сетевой службой без явного согласия.
   */
  async useEmbedded(options: { expose?: boolean } = {}): Promise<Connection> {
    const config = this.load();
    const expose = options.expose ?? config.embedded?.exposed ?? false;

    // Смена доступности требует другого адреса прослушивания, а значит
    // перезапуска: работающее ядро само по себе останавливать незачем.
    if (options.expose !== undefined && options.expose !== config.embedded?.exposed) {
      this.local.stop();
      await waitUntilStopped(this.local);
    }

    const url = await this.local.ensureRunning(expose ? '0.0.0.0' : '127.0.0.1');
    const token = await this.local.obtainToken(url, config.embedded?.token ?? null);

    config.active = 'embedded';
    config.embedded = { token, exposed: expose };
    this.save(config);

    this.current = {
      mode: 'embedded',
      // Само приложение всегда ходит через localhost, даже когда ядро
      // слушает шире: незачем гонять свой же трафик через сетевой интерфейс.
      url: url.replace('0.0.0.0', '127.0.0.1'),
      token,
      exposed: expose,
      ...(expose ? { lan: lanAddresses(new URL(url).port) } : {}),
    };
    return this.current;
  }

  /** Остановить своё ядро — по явной просьбе. */
  stopLocal(): boolean {
    return this.local.stop();
  }

  /**
   * Перезапустить своё ядро.
   *
   * Нужно, когда ядро старее приложения: обновился десктоп, а рядом работает
   * ядро, поднятое до обновления. Чинится это перезапуском, и человек должен
   * уметь сделать это кнопкой, а не командой в терминале — иначе единственный
   * способ узнать про такую ситуацию будет «половина интерфейса пустая».
   */
  async restartLocal(): Promise<Connection> {
    if (this.load().active !== 'embedded') {
      throw new Error('Перезапустить можно только ядро на этой машине');
    }

    await this.local.stopAndWait();
    return await this.useEmbedded();
  }

  /** Работает ли ядро на этой машине прямо сейчас. */
  async localRunning(): Promise<boolean> {
    return (await this.local.discover()) !== null;
  }

  /** Что записать в автозагрузку, чтобы ядро поднималось при входе в систему. */
  autostartTarget(): { command: string; args: string[]; env: Record<string, string> } {
    const exposed = this.load().embedded?.exposed ?? false;
    return this.local.launchSpec(exposed ? '0.0.0.0' : '127.0.0.1');
  }

  /**
   * Чужое ядро: меняем код подключения на токен.
   *
   * Своё ядро при этом останавливается — держать его запущенным незачем, а
   * пара запущенных ядер на одной машине путает и пользователя, и порты.
   */
  async connectRemote(input: { url: string; code: string; name: string }): Promise<Connection> {
    const url = normalizeUrl(input.url);

    const response = await fetch(`${url}/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: input.code.trim().toUpperCase(), name: input.name }),
    }).catch(() => {
      throw new Error(`Не удалось достучаться до ${url}. Проверьте адрес и что ядро запущено.`);
    });

    if (response.status === 403) {
      // Код одноразовый и сгорает даже от неудачной попытки. Человек, у
      // которого он не сработал, первым делом ищет, где взять новый.
      throw new Error(
        'Код неверен или уже использован. Новый выдаёт ядро: axon code на той машине, где оно запущено',
      );
    }
    if (!response.ok) throw new Error(`Ядро ответило ошибкой ${response.status}`);

    const paired = (await response.json()) as { token: string; core?: { coreId?: string } };

    // Своё ядро не трогаем: оно живёт само по себе, и переключение окна на
    // другое ядро — не повод его останавливать.
    const config = this.load();
    config.active = 'remote';
    config.remote = { url, token: paired.token, label: hostOf(url) };
    this.save(config);

    this.current = { mode: 'remote', url, token: paired.token, label: hostOf(url) };
    return this.current;
  }

  /** Проверить адрес до пейринга — чтобы не вводить код вслепую. */
  async probe(url: string): Promise<{ coreId: string; version: string; devices: number }> {
    const target = normalizeUrl(url);
    const response = await fetch(`${target}/health`).catch(() => {
      throw new Error('Ядро по этому адресу не отвечает');
    });
    if (!response.ok) throw new Error(`Ядро ответило ошибкой ${response.status}`);
    return (await response.json()) as { coreId: string; version: string; devices: number };
  }

  /** Забыть удалённое ядро и вернуться к своему. */
  async forgetRemote(): Promise<Connection> {
    const config = this.load();
    delete config.remote;
    config.active = 'embedded';
    this.save(config);
    return await this.useEmbedded();
  }

  private get configPath(): string {
    return path.join(this.userDataDir, 'connection.json');
  }

  private load(): StoredConfig {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as StoredConfig;
    } catch {
      return this.migrateLegacy();
    }
  }

  /**
   * До появления выбора ядра токен лежал в `device.json`.
   *
   * Без переноса обновление выглядит как поломка: ядро уже знает устройство,
   * код первого подключения оно больше не выдаёт, а токен приложение
   * «потеряло». Один раз перекладываем и удаляем старый файл.
   */
  private migrateLegacy(): StoredConfig {
    const legacyPath = path.join(this.userDataDir, 'device.json');
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as { token?: string };
      if (legacy.token) {
        const config: StoredConfig = { active: 'embedded', embedded: { token: legacy.token } };
        this.save(config);
        fs.rmSync(legacyPath, { force: true });
        return config;
      }
    } catch {
      // Старого файла нет — обычный первый запуск.
    }
    return { active: 'embedded' };
  }

  private save(config: StoredConfig): void {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
}

/** Пользователь вводит адрес руками — приводим к виду, который поймёт fetch. */
function normalizeUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  // Без порта почти наверняка имелся в виду порт ядра по умолчанию.
  const parsed = new URL(url);
  if (!parsed.port && parsed.protocol === 'http:') parsed.port = '8787';
  return parsed.origin;
}

/** Дождаться, пока остановленное ядро действительно отпустит порт. */
async function waitUntilStopped(local: LocalCore): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await local.discover()) === null) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Адреса, которые нужно набрать на другом устройстве. Показываем только
 * реальные сетевые интерфейсы: `0.0.0.0` человеку ни о чём не говорит.
 */
function lanAddresses(port: string): string[] {
  const found: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      found.push(`${iface.address}:${port}`);
    }
  }
  return found;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
