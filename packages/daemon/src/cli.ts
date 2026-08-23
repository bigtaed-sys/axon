#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createBackup, createRuntime, resolveConfig, restoreBackup, scaffold } from '@axon/core';
import { parseMcpConfig } from '@axon/protocol';
import { Daemon } from './Daemon.js';

interface CoreRecord {
  url: string;
  pid: number;
  coreId: string;
  mode: string;
  startedAt: string;
}

/** Что ядро о себе заявило. `null`, если оно не запущено. */
function readRecord(): CoreRecord | null {
  try {
    const file = path.join(resolveConfig().dataDir, 'core.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CoreRecord;
  } catch {
    return null;
  }
}

/**
 * Локальная CLI ядра.
 *
 * Здесь же живёт единственный способ увидеть секрет целиком (`secret get`):
 * по протоколу значение не отдаётся никогда, но у того, кто сидит за этой
 * машиной, и так есть и файл БД, и ключ шифрования рядом с ним. Прятать от
 * него значение — театр, а не безопасность.
 */
async function main(): Promise<void> {
  const [command = 'start', ...args] = process.argv.slice(2);

  switch (command) {
    case 'start':
      return await start(args);
    case 'secret':
      return await secret(args);
    case 'devices':
      return await devices();
    case 'plugin':
    case 'plugins':
      return await plugin(args);
    case 'backup':
      return await backup(args);
    case 'restore':
      return await restore(args);
    case 'status':
      return await status();
    case 'stop':
      return stop();
    case 'help':
    case '--help':
    case '-h':
      return usage();
    default:
      console.error(`Неизвестная команда: ${command}\n`);
      usage();
      process.exitCode = 1;
  }
}

async function start(args: string[]): Promise<void> {
  const port = Number(valueOf(args, '--port') ?? process.env['AXON_PORT'] ?? 8787);
  const host = valueOf(args, '--host') ?? process.env['AXON_HOST'] ?? '127.0.0.1';

  // `--json` — только про формат вывода: одна строка JSON вместо
  // человеческого текста, чтобы родительский процесс мог её разобрать.
  const asJson = args.includes('--json');
  // Режим — про смысл запуска, и одно с другим не связано: ядро, поднятое
  // десктопом, но открытое в сеть, для клиента всё равно встроенное.
  const mode = valueOf(args, '--mode') === 'embedded' ? 'embedded' : 'standalone';

  const daemon = new Daemon({ host, port, mode });
  const { address, bootstrapCode } = await daemon.start();

  if (asJson) {
    console.log(JSON.stringify({ ready: true, url: address.url, bootstrapCode }));
  } else {
    console.log(`Axon слушает ${address.url}`);
  }
  if (bootstrapCode && !asJson) {
    console.log('');
    console.log('  Устройств пока нет. Код для первого подключения:');
    console.log(`      ${bootstrapCode}`);
    console.log('  Он же записан в bootstrap.code рядом с данными и сгорает после');
    console.log('  первого использования.');
    console.log('');
  }

  const stop = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function secret(args: string[]): Promise<void> {
  const [action, key, value] = args;
  const runtime = createRuntime();

  try {
    switch (action) {
      case 'get': {
        if (!key) return fail('Нужен ключ: axon secret get <ключ>');
        const revealed = runtime.store.secrets.reveal(key);
        if (revealed === null) return fail(`Секрет "${key}" не задан`);
        console.log(revealed);
        return;
      }
      case 'set': {
        if (!key || value === undefined) return fail('Нужны ключ и значение');
        runtime.store.updateSettings({ secrets: { [key]: value } });
        console.log(`Записано: ${key}`);
        return;
      }
      case 'list': {
        const statuses = runtime.store.secrets.status();
        if (statuses.length === 0) return console.log('Секретов нет');
        for (const status of statuses) {
          console.log(`${status.key}\t${status.set ? `…${status.hint ?? ''}` : '(не задан)'}`);
        }
        return;
      }
      default:
        fail('Использование: axon secret <get|set|list> [ключ] [значение]');
    }
  } finally {
    await runtime.close();
  }
}

async function status(): Promise<void> {
  const record = readRecord();
  if (!record) return console.log('Ядро не запущено');

  const alive = await fetch(`${record.url}/health`)
    .then((r) => r.ok)
    .catch(() => false);

  if (!alive) {
    // Файл есть, а ядра нет: процесс убили жёстко и убраться он не успел.
    console.log(`Ядро не отвечает по ${record.url} (запись устарела)`);
    return;
  }

  console.log(`Ядро на связи: ${record.url}`);
  console.log(`  pid ${record.pid}, запущено ${new Date(record.startedAt).toLocaleString('ru')}`);
}

function stop(): void {
  const record = readRecord();
  if (!record) return console.log('Ядро не запущено');

  try {
    process.kill(record.pid, 'SIGTERM');
    console.log(`Остановлено (pid ${record.pid})`);
  } catch {
    console.log('Процесс уже не существует');
  }
  fs.rmSync(path.join(resolveConfig().dataDir, 'core.json'), { force: true });
}

async function devices(): Promise<void> {
  const runtime = createRuntime();
  try {
    const list = runtime.store.devices.list();
    if (list.length === 0) return console.log('Подключённых устройств нет');
    for (const device of list) {
      console.log(`${device.id}\t${device.platform}\t${device.name}\t${device.scopes.join(',')}`);
    }
  } finally {
    await runtime.close();
  }
}

/**
 * Плагины из терминала.
 *
 * Здесь, и только здесь, живёт `link` — подключение папки как есть. В
 * интерфейсе его нет намеренно: это режим разработки плагина, а не способ его
 * поставить. Автор правит файлы у себя и делает `reload`, а не переустановку
 * после каждой правки.
 *
 * Команды работают с базой напрямую, а не через запущенное ядро: чинить
 * плагин, из-за которого ядро не поднимается, иначе было бы нечем.
 */
async function plugin(args: string[]): Promise<void> {
  const [action = 'list', target] = args;

  /**
   * Заготовка не трогает ядро вовсе — она просто пишет файлы.
   *
   * Поэтому обрабатывается до всего остального: и до проверки «ядро
   * запущено», которая к ней не относится, и до создания рантайма, ради
   * которого пришлось бы открывать базу и поднимать плагины.
   */
  if (action === 'new') {
    const created = scaffold(target ?? '.', args[2]);
    console.log(`Плагин ${created.id} создан в ${created.dir}`);
    console.log(`  ${created.files.join(', ')}`);
    console.log('');
    console.log('  Подключить и посмотреть:');
    console.log(`    axon plugin link ${created.dir}`);
    console.log(`    axon plugin logs ${created.id}`);
    return;
  }

  const record = readRecord();
  if (record && action !== 'list') {
    return fail(
      'Ядро запущено — останови его (axon stop), иначе изменения потеряются при его выходе',
    );
  }

  const runtime = createRuntime();
  try {
    switch (action) {
      case 'list': {
        await runtime.startPlugins();
        const list = runtime.plugins.list();
        if (list.length === 0) return console.log('Плагинов нет');
        for (const item of list) {
          const tools = item.tools.length ? `${item.tools.length} инстр.` : '—';
          console.log(`${item.id}\t${item.status}\t${tools}\t${item.name}`);
          if (item.error) console.log(`  ${item.error}`);
        }
        return;
      }
      case 'catalog': {
        const catalog = await runtime.plugins.catalog(args[1] === '--refresh');

        for (const entry of catalog.entries) {
          console.log(`${entry.id}\t${entry.name}`);
          console.log(`  ${entry.description}`);
        }

        /**
         * Откуда список — важно сказать.
         *
         * Каталог из сборки полугодовой давности и свежий выглядят одинаково,
         * и без пометки непонятно, почему в нём нет того, о чём человеку
         * рассказали.
         */
        const where =
          catalog.origin === 'network'
            ? 'из репозитория каталога'
            : catalog.origin === 'cache'
              ? 'из кэша — сеть недоступна'
              : 'из сборки — сеть и кэш недоступны';

        console.log('');
        console.log(`  ${catalog.entries.length} записей, ${where}`);
        return;
      }
      case 'add': {
        if (!target) return fail('Нужен адрес: axon plugin add <git-url|id-из-каталога>');
        const source = /^(https?:|git@|ssh:|git:)/i.test(target)
          ? ({ type: 'git', url: target } as const)
          : ({ type: 'catalog', id: target, values: {} } as const);
        const installed = await runtime.plugins.install(source);
        console.log(`Установлен ${installed.id} (${installed.status})`);
        if (installed.error) console.log(`  ${installed.error}`);
        return;
      }
      case 'add-mcp': {
        // Конфигурацию берём с диска или со stdin: её копируют из README
        // сервера целиком, и переписывать её в аргументы командной строки —
        // лишний шаг, на котором легко ошибиться.
        const json = target
          ? fs.readFileSync(target, 'utf8')
          : fs.readFileSync(0, 'utf8');

        let servers;
        try {
          servers = parseMcpConfig(json);
        } catch (error) {
          return fail((error as Error).message);
        }

        for (const server of servers) {
          const added = await runtime.plugins.install({
            type: 'mcp',
            name: server.name,
            transport: server.transport,
          });
          console.log(`Поставлен ${added.id} (${added.status})`);
          if (added.error) console.log(`  ${added.error}`);
        }
        return;
      }
      case 'link': {
        if (!target) return fail('Нужен путь: axon plugin link <папка>');
        const linked = await runtime.plugins.install({ type: 'link', path: target });
        console.log(`Подключён ${linked.id} (${linked.status})`);
        if (linked.error) console.log(`  ${linked.error}`);
        return;
      }
      case 'update': {
        if (!target) return fail('Нужен id: axon plugin update <id>');
        await runtime.startPlugins();
        const updated = await runtime.plugins.update(target);
        console.log(`Обновлён ${updated.id} до ${updated.version} (${updated.status})`);
        if (updated.error) console.log(`  ${updated.error}`);
        return;
      }
      case 'remove': {
        if (!target) return fail('Нужен id: axon plugin remove <id>');
        await runtime.startPlugins();
        await runtime.plugins.remove(target);
        console.log(`Удалён ${target}`);
        return;
      }
      case 'logs': {
        if (!target) return fail('Нужен id: axon plugin logs <id>');
        await runtime.startPlugins();
        for (const line of runtime.plugins.logs(target, 200)) {
          console.log(`${line.at}\t${line.level}\t${line.text}`);
        }
        return;
      }
      default:
        fail(
          'Использование: axon plugin <list|catalog|add|add-mcp|link|update|remove|logs> [аргумент]',
        );
    }
  } finally {
    await runtime.close();
  }
}

/**
 * Снять копию.
 *
 * Ядро останавливать не нужно: база копируется средствами самой SQLite,
 * согласованным снимком.
 */
async function backup(args: string[]): Promise<void> {
  const withKeys = args.includes('--with-keys');
  const target = args.find((arg) => !arg.startsWith('--')) ?? defaultBackupName();

  const config = resolveConfig();
  const result = await createBackup(config, target, { includeSecretKey: withKeys });

  console.log(`Копия: ${result.path}`);
  console.log(`  ${result.files} файлов, ${(result.bytes / 1024 / 1024).toFixed(1)} МБ`);

  if (result.withSecretKey) {
    console.log('');
    console.log('  В копии лежит ключ шифрования — значит, и все секреты:');
    console.log('  ключи от моделей, токен бота, сессия телеграма.');
    console.log('  Держите её там же, где держали бы сами эти ключи.');
  } else {
    console.log('');
    console.log('  Ключ шифрования в копию не положен — секреты из неё не достать.');
    console.log('  После восстановления ключи придётся ввести заново.');
    console.log('  Нужен ключ внутри — добавьте --with-keys.');
  }
}

/**
 * Развернуть копию.
 *
 * Ядро при этом должно быть остановлено: разворачивать базу под живым
 * процессом — верный способ получить и битую копию, и битый оригинал.
 */
async function restore(args: string[]): Promise<void> {
  const archive = args.find((arg) => !arg.startsWith('--'));
  if (!archive) {
    console.error('Укажите файл копии: axon restore <файл>');
    process.exitCode = 1;
    return;
  }

  const config = resolveConfig();

  if (running(config.dataDir)) {
    console.error('Ядро запущено. Сначала остановите его: axon stop');
    process.exitCode = 1;
    return;
  }

  const result = await restoreBackup(archive, config.dataDir);
  console.log(`Развёрнуто в ${config.dataDir}: ${result.files} файлов.`);

  if (!result.withSecretKey) {
    console.log('');
    console.log('  Ключа шифрования в копии не было — секреты не восстановлены.');
    console.log('  Введите заново ключи провайдеров и, если пользуетесь, токен бота.');
  }
}

/** Имя копии по умолчанию: с датой, чтобы соседние не затирали друг друга. */
function defaultBackupName(): string {
  const now = new Date().toISOString().slice(0, 10);
  return `axon-${now}.axon-backup`;
}

/** Работает ли ядро прямо сейчас — по заявке, которую оно кладёт рядом с данными. */
function running(dataDir: string): boolean {
  const file = path.join(dataDir, 'core.json');
  if (!fs.existsSync(file)) return false;

  try {
    const { pid } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
    if (!pid) return false;
    // Сигнал 0 ничего не делает, но падает, если процесса нет.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function usage(): void {
  console.log(`Axon — персональный AI-агент

  axon start [--host 127.0.0.1] [--port 8787]   запустить ядро
      --host 0.0.0.0                            открыть для других устройств
  axon status                                   запущено ли ядро и где
  axon stop                                     остановить ядро
  axon secret list                              какие секреты заданы
  axon secret get <ключ>                        показать секрет целиком
  axon secret set <ключ> <значение>             записать секрет
  axon devices                                  список подключённых устройств

  axon backup [файл] [--with-keys]              снять копию (ядро можно не останавливать)
  axon restore <файл>                           развернуть копию (ядро должно быть остановлено)

  axon plugin new <папка> [id]                  заготовка своего плагина
  axon plugin list                              что установлено и в каком состоянии
  axon plugin catalog [--refresh]               каталог плагинов, --refresh тянет свежий
  axon plugin add <id|git-url>                  поставить из каталога или из репозитория
  axon plugin add-mcp [файл.json]               свой MCP-сервер (конфиг из его README, или stdin)
  axon plugin link <папка>                      подключить папку как есть (разработка)
  axon plugin update <id>                       подтянуть новую версию из репозитория
  axon plugin remove <id>                       удалить
  axon plugin logs <id>                         последние строки вывода плагина

Папка данных задаётся переменной AXON_DATA_DIR.`);
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

void main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
