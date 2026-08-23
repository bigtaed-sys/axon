import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unpack } from './archive.js';
import { promisify } from 'node:util';
import type {
  CatalogEntry,
  McpTransport,
  PluginManifest,
  PluginOrigin,
  PluginSource,
} from '@axon/protocol';
import { catalogEntry } from './catalog.js';
import { MANIFEST_FILE, readManifest } from './manifest.js';

const run = promisify(execFile);

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

export interface InstallResult {
  manifest: PluginManifest;
  dir: string;
  origin: PluginOrigin;
  /** Значения, которые пользователь ввёл при установке из каталога. */
  values: Record<string, string>;
  /** Какие из них — секреты. Их нельзя класть в обычные настройки. */
  secretKeys: string[];
}

/**
 * Поставить плагин.
 *
 * Три пути, и они разные по существу, а не по параметру: каталожный плагин
 * вокруг MCP-сервера ядро собирает само, git — выкачивает, локальная папка
 * подключается на месте и остаётся под управлением автора.
 */
export async function install(
  source: PluginSource,
  pluginsDir: string,
  taken: (id: string) => boolean,
): Promise<InstallResult> {
  switch (source.type) {
    case 'catalog':
      return installFromCatalog(source.id, source.values, pluginsDir, taken);
    case 'git':
      return installFromGit(source.url, source.ref, pluginsDir, taken);
    case 'mcp':
      return installMcp(source, pluginsDir, taken);
    case 'link':
      return linkFolder(source.path, taken);
    default:
      // Архив разворачивает PluginHost: ему нужны байты из блоб-хранилища,
      // о котором эта функция не знает и знать не должна.
      throw new InstallError(`Такой источник здесь не ставится: ${source.type}`);
  }
}

/**
 * Поставить плагин из распакованного архива.
 *
 * Отдельно от `install`, потому что сюда приходят уже байты: достать их из
 * блоб-хранилища может только тот, у кого оно есть, а `install` про хранилище
 * не знает и знать не должен.
 */
export function installFromArchive(
  archive: Buffer,
  pluginsDir: string,
  taken: (id: string) => boolean,
): InstallResult {
  // Разворачиваем во временное место: пока не прочитан манифест, неизвестно
  // даже, как плагин зовут, а значит и куда его класть.
  const staging = path.join(pluginsDir, `.распаковка-${Date.now()}`);

  try {
    const root = unpack(archive, staging);
    const manifest = readManifest(root);

    if (taken(manifest.id)) throw new InstallError(`Плагин ${manifest.id} уже установлен`);

    const target = path.join(pluginsDir, manifest.id);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(root, target);

    return {
      dir: target,
      manifest,
      origin: { type: 'archive' as const, ref: manifest.id },
      values: {},
      secretKeys: [],
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ─── Свой MCP-сервер ────────────────────────────────────────────────────────

/**
 * Обернуть чужой MCP-сервер в плагин.
 *
 * Никакого кода не пишется и не скачивается: плагин — это манифест из
 * нескольких строк, а сам сервер поднимет ядро той командой, которую дал
 * пользователь. Ровно то же самое делает установка из каталога — просто
 * конфигурацию там мы заготовили заранее.
 */
function installMcp(
  source: Extract<PluginSource, { type: 'mcp' }>,
  pluginsDir: string,
  taken: (id: string) => boolean,
): InstallResult {
  if (taken(source.name)) throw new InstallError(`Плагин ${source.name} уже установлен`);

  const dir = path.join(pluginsDir, source.name);
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    id: source.name,
    name: source.title || source.name,
    description: describeTransport(source.transport),
    version: '1.0.0',
    api: 1,
    // Сервер запускает ядро на своей машине, поэтому права заявляем честно:
    // stdio — это чужой процесс, http — это выход в сеть.
    permissions: source.transport.type === 'stdio' ? ['shell', 'net'] : ['net'],
    mcpServers: { [source.name]: source.transport },
  };
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    manifest: readManifest(dir),
    dir,
    origin: { type: 'catalog', ref: `mcp:${source.name}` },
    values: {},
    secretKeys: [],
  };
}

/** Строчка про сервер для списка: откуда он берётся, без выдумок. */
function describeTransport(transport: McpTransport): string {
  return transport.type === 'stdio'
    ? `MCP-сервер: ${[transport.command, ...transport.args].join(' ')}`.slice(0, 500)
    : `MCP-сервер: ${transport.url}`.slice(0, 500);
}

// ─── Каталог ────────────────────────────────────────────────────────────────

async function installFromCatalog(
  id: string,
  values: Record<string, string>,
  pluginsDir: string,
  taken: (id: string) => boolean,
): Promise<InstallResult> {
  const entry = catalogEntry(id);
  if (!entry) throw new InstallError(`В каталоге нет плагина ${id}`);
  if (taken(id)) throw new InstallError(`Плагин ${id} уже установлен`);

  const missing = entry.setup
    .filter((field) => field.required && !values[field.key]?.trim())
    .map((field) => field.label);
  if (missing.length > 0) {
    throw new InstallError(`Не заполнено: ${missing.join(', ')}`);
  }

  if (entry.install.type === 'git') {
    const result = await installFromGit(entry.install.url, entry.install.ref, pluginsDir, taken);
    return { ...result, origin: { type: 'catalog', ref: id }, values, secretKeys: [] };
  }

  // Плагин-обёртка: кода нет, есть манифест с одним MCP-сервером и формой
  // настроек из каталога. Подстановка `${ключ}` происходит не здесь, а при
  // запуске — иначе токен пришлось бы писать в файл открытым текстом.
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify(wrapperManifest(entry), null, 2),
    'utf8',
  );

  return {
    manifest: readManifest(dir),
    dir,
    origin: { type: 'catalog', ref: id },
    values,
    secretKeys: entry.setup.filter((f) => f.type === 'secret').map((f) => f.key),
  };
}

function wrapperManifest(entry: CatalogEntry): Record<string, unknown> {
  const install = entry.install as Extract<CatalogEntry['install'], { type: 'mcp' }>;
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    version: '1.0.0',
    api: 1,
    ...(entry.homepage ? { homepage: entry.homepage } : {}),
    permissions: entry.permissions,
    settings: entry.setup,
    mcpServers: { [entry.id]: install.transport },
  };
}

// ─── Git ────────────────────────────────────────────────────────────────────

async function installFromGit(
  url: string,
  ref: string | undefined,
  pluginsDir: string,
  taken: (id: string) => boolean,
): Promise<InstallResult> {
  assertSafeGitUrl(url);

  // Клонируем во временную папку: id плагина известен только из манифеста, а
  // он внутри репозитория. Класть сразу в plugins/ значило бы придумывать имя
  // папки до того, как оно станет известно, и потом его чинить.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-plugin-'));
  try {
    const args = ['clone', '--depth', '1'];
    if (ref) args.push('--branch', ref);
    args.push('--', url, staging);

    try {
      await run('git', args, { timeout: 120_000, windowsHide: true });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      throw new InstallError(
        `Не удалось склонировать ${url}: ${stderr.trim() || (error as Error).message}`,
      );
    }

    const manifest = readManifest(staging);
    if (taken(manifest.id)) throw new InstallError(`Плагин ${manifest.id} уже установлен`);

    // .git больше не нужен: обновление — это переустановка, а лишние сотни
    // мегабайт истории в папке данных никому не помогают.
    fs.rmSync(path.join(staging, '.git'), { recursive: true, force: true });

    const dir = path.join(pluginsDir, manifest.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.cpSync(staging, dir, { recursive: true });

    return {
      manifest: readManifest(dir),
      dir,
      origin: { type: 'git', ref: url },
      values: {},
      secretKeys: [],
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Отсечь то, что git воспримет как команду, а не как адрес.
 *
 * `ext::`-транспорт запускает произвольную оболочку, а путь с `--` в начале
 * превращается в дополнительный флаг. И то и другое означает выполнение чужой
 * команды на машине ядра из строки, которую кто-то прислал как «ссылку».
 */
function assertSafeGitUrl(url: string): void {
  const value = url.trim();
  if (!value) throw new InstallError('Пустой адрес репозитория');
  if (value.startsWith('-')) throw new InstallError('Адрес репозитория не может начинаться с "-"');
  if (/^ext::/i.test(value)) throw new InstallError('Транспорт ext:: запрещён');

  const allowed = /^(https?:\/\/|git@[\w.-]+:|ssh:\/\/|git:\/\/)/i.test(value);
  if (!allowed) {
    throw new InstallError('Поддерживаются адреса https://, ssh://, git:// и git@host:path');
  }
}

// ─── Локальная папка ────────────────────────────────────────────────────────

/**
 * Подключить папку как есть, не копируя.
 *
 * Это режим разработки: автор правит файлы у себя и перезагружает плагин,
 * а не переустанавливает его после каждой правки. Поэтому в интерфейсе такого
 * пункта нет — только в CLI.
 */
function linkFolder(target: string, taken: (id: string) => boolean): InstallResult {
  const dir = path.resolve(target);
  if (!fs.existsSync(dir)) throw new InstallError(`Папки ${dir} нет`);

  const manifest = readManifest(dir);
  if (taken(manifest.id)) throw new InstallError(`Плагин ${manifest.id} уже установлен`);

  return { manifest, dir, origin: { type: 'link', ref: dir }, values: {}, secretKeys: [] };
}
