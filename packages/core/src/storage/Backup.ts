import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import type { CoreConfig } from '../config.js';
import { logger } from '../logger.js';

/**
 * Резервная копия: вся память агента в одном файле.
 *
 * Личный агент накапливает то, что нигде больше не лежит: переписку за месяцы,
 * память о человеке, договорённости. Один снесённый контейнер — и всего этого
 * не стало. Копия здесь не «хорошо бы иметь», а разница между «мой агент» и
 * «мой агент, пока что-нибудь не сломается».
 *
 * ## Почему свой архиватор
 *
 * В Node нет ни zip, ни tar, а тянуть зависимость ради сотни строк не хочется
 * — тем более в ядро, которое ставится глобально. Tar выбран потому, что он
 * прост до неприличия: заголовок в 512 байт, содержимое, выравнивание нулями.
 * Читается любым архиватором на любой системе, а не только нами.
 *
 * ## Почему база копируется через VACUUM INTO
 *
 * Простое копирование файла SQLite на работающем ядре даёт битую копию: часть
 * данных лежит в журнале WAL, часть в основном файле, и момент между записями
 * поймать нельзя. `VACUUM INTO` делает согласованный снимок средствами самой
 * SQLite, не останавливая ядро и не мешая тем, кто в это время пишет.
 *
 * ## Про ключ шифрования
 *
 * По умолчанию `secret.key` в копию **не кладётся**, и это осознанный выбор.
 * С ним копия становится полноценной кражей: API-ключи, токен бота, сессия
 * телеграма — всё расшифровывается тем, кто её нашёл. А копию обычно кладут
 * туда, где безопасность ниже, чем у рабочей машины: в облако, на флешку, в
 * письмо самому себе.
 *
 * Расплата честная: после восстановления ключи придётся ввести заново. Всё
 * остальное — переписка, память, настройки, плагины — вернётся как было.
 */

const require = createRequire(import.meta.url);

/** Что не кладём в копию никогда. */
const SKIP = new Set([
  // Служебные файлы живого ядра: адрес, pid, одноразовый код подключения.
  'core.json',
  'bootstrap.code',
  // Журналы SQLite: их содержимое уже внутри снимка, снятого VACUUM INTO.
  'axon.db-wal',
  'axon.db-shm',
]);

export interface BackupOptions {
  /** Класть ли ключ шифрования. По умолчанию нет — см. заголовок файла. */
  includeSecretKey?: boolean;
}

export interface BackupResult {
  path: string;
  bytes: number;
  files: number;
  withSecretKey: boolean;
}

/**
 * Снять копию в один файл `.axon-backup` (это gzip-сжатый tar).
 *
 * Ядро останавливать не нужно.
 */
export async function createBackup(
  config: CoreConfig,
  target: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const withSecretKey = options.includeSecretKey ?? false;
  const entries: TarEntry[] = [];

  // Снимок базы — во временный файл рядом с целью, чтобы не писать в папку
  // данных: она может быть на диске, который как раз кончается.
  const snapshot = `${target}.db.tmp`;
  fs.rmSync(snapshot, { force: true });

  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(config.databasePath, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  entries.push({ name: 'axon.db', data: fs.readFileSync(snapshot) });
  fs.rmSync(snapshot, { force: true });

  if (withSecretKey && fs.existsSync(config.secretKeyPath)) {
    entries.push({ name: 'secret.key', data: fs.readFileSync(config.secretKeyPath) });
  }

  for (const relative of walk(config.dataDir)) {
    const base = path.basename(relative);
    if (SKIP.has(relative) || SKIP.has(base)) continue;
    if (relative === 'axon.db' || relative === 'secret.key') continue;

    entries.push({
      name: relative.split(path.sep).join('/'),
      data: fs.readFileSync(path.join(config.dataDir, relative)),
    });
  }

  const archive = zlib.gzipSync(tar(entries));
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, archive);

  logger.info({ target, files: entries.length, bytes: archive.length }, 'копия снята');
  return { path: target, bytes: archive.length, files: entries.length, withSecretKey };
}

export interface RestoreResult {
  files: number;
  /** Был ли в копии ключ шифрования. Нет — секреты придётся ввести заново. */
  withSecretKey: boolean;
}

/**
 * Развернуть копию в папку данных.
 *
 * Ядро при этом должно быть **остановлено**: разворачивать базу под живым
 * процессом — верный способ получить и битую копию, и битый оригинал.
 * Существующие файлы перезаписываются.
 */
export async function restoreBackup(archive: string, dataDir: string): Promise<RestoreResult> {
  const entries = untar(zlib.gunzipSync(fs.readFileSync(archive)));
  if (entries.length === 0) throw new Error('Копия пуста или испорчена');
  if (!entries.some((entry) => entry.name === 'axon.db')) {
    throw new Error('Это не копия Axon: в архиве нет базы');
  }

  fs.mkdirSync(dataDir, { recursive: true });

  /**
   * Журналы прежней базы удаляем до распаковки.
   *
   * Оставшийся от старой базы WAL SQLite попытается применить к новой — и
   * либо откажется открывать её, либо испортит.
   */
  for (const leftover of ['axon.db-wal', 'axon.db-shm']) {
    fs.rmSync(path.join(dataDir, leftover), { force: true });
  }

  for (const entry of entries) {
    const target = path.join(dataDir, ...entry.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }

  const withSecretKey = entries.some((entry) => entry.name === 'secret.key');
  logger.info({ dataDir, files: entries.length }, 'копия развёрнута');

  return { files: entries.length, withSecretKey };
}

// ─── Обход папки ────────────────────────────────────────────────────────────

/** Все файлы внутри папки, путями относительно неё. */
function walk(root: string, prefix = ''): string[] {
  const here = path.join(root, prefix);
  if (!fs.existsSync(here)) return [];

  const out: string[] = [];
  for (const item of fs.readdirSync(here, { withFileTypes: true })) {
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) out.push(...walk(root, relative));
    else if (item.isFile()) out.push(relative);
  }
  return out;
}

// ─── Tar ────────────────────────────────────────────────────────────────────

interface TarEntry {
  name: string;
  data: Buffer;
}

const BLOCK = 512;

/**
 * Собрать tar.
 *
 * Формат ustar: на каждый файл заголовок в 512 байт, следом содержимое,
 * добитое нулями до кратности 512. В конце два пустых блока. Всё.
 */
function tar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];

  for (const entry of entries) {
    chunks.push(header(entry));
    chunks.push(entry.data);

    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }

  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function header(entry: TarEntry): Buffer {
  const block = Buffer.alloc(BLOCK);

  const name = Buffer.from(entry.name, 'utf8');
  if (name.length > 100) {
    // Длинные имена требуют расширений формата. У нас таких путей не бывает,
    // и вместо тихой порчи архива лучше честный отказ.
    throw new Error(`Слишком длинный путь для архива: ${entry.name}`);
  }
  name.copy(block, 0);

  octal(block, 100, 8, 0o644); // права
  octal(block, 108, 8, 0); // владелец
  octal(block, 116, 8, 0); // группа
  octal(block, 124, 12, entry.data.length);
  octal(block, 136, 12, Math.floor(Date.now() / 1000));
  block.write('0', 156); // обычный файл
  block.write('ustar\0', 257);
  block.write('00', 263);

  /**
   * Контрольная сумма считается так, будто её поле заполнено пробелами.
   * Так велит формат, и архиваторы проверяют именно это.
   */
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  octal(block, 148, 8, sum);
  block.write('\0 ', 155);

  return block;
}

/** Число в восьмеричном виде с завершающим нулём — как требует формат. */
function octal(block: Buffer, offset: number, size: number, value: number): void {
  const text = value.toString(8).padStart(size - 1, '0');
  block.write(`${text}\0`, offset, size, 'ascii');
}

function untar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    // Два пустых блока подряд — конец архива.
    if (block.every((byte) => byte === 0)) break;

    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);

    offset += BLOCK;
    if (Number.isNaN(size)) throw new Error('Архив испорчен: не читается размер файла');

    if (name) entries.push({ name, data: Buffer.from(archive.subarray(offset, offset + size)) });
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }

  return entries;
}
