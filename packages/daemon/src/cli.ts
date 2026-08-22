#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRuntime, resolveConfig } from '@axon/core';
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
        for (const entry of runtime.plugins.catalog()) {
          console.log(`${entry.id}\t${entry.name}`);
          console.log(`  ${entry.description}`);
        }
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

  axon plugin list                              что установлено и в каком состоянии
  axon plugin catalog                           встроенный каталог
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
