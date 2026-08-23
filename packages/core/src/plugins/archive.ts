import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Распаковка архива с плагином.
 *
 * Zip, потому что его отдают все: «Download ZIP» на гитхабе, «сжать папку» в
 * проводнике и в Finder. Просить человека сделать `tar.gz` значит просить его
 * открыть терминал — то есть половина не поставит плагин вовсе.
 *
 * Читатель свой, без зависимости. Формат для чтения простой: в конце файла
 * оглавление, в нём смещения записей, содержимое сжато обычным deflate,
 * который умеет встроенный `zlib`. Ради сотни строк тянуть пакет в ядро,
 * которое ставится глобально, не стоит.
 *
 * Заодно понимаем `tar.gz` — он уже умеется ради резервных копий, и человеку
 * с терминалом приятно, что его архив тоже приняли.
 */

/** Потолок распаковки: защита от архива, который разворачивается в гигабайты. */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** Потолок на файл — по той же причине. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface ArchiveEntry {
  name: string;
  data: Buffer;
}

/**
 * Развернуть архив в папку.
 *
 * Возвращает путь к корню плагина — тому, где лежит `axon.plugin.json`. Он не
 * обязан совпадать с корнем архива: и гитхаб, и проводник заворачивают всё в
 * одну папку с именем проекта, и требовать от человека «сжимайте содержимое,
 * а не папку» — верный способ получить поток одинаковых жалоб.
 */
export function unpack(archive: Buffer, target: string): string {
  const entries = read(archive);
  if (entries.length === 0) throw new Error('Архив пуст или испорчен');

  let total = 0;
  for (const entry of entries) {
    if (entry.data.length > MAX_FILE_BYTES) {
      throw new Error(`Файл ${entry.name} слишком велик для плагина`);
    }
    total += entry.data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('Архив разворачивается в слишком большую папку');
  }

  fs.mkdirSync(target, { recursive: true });

  for (const entry of entries) {
    const to = safeJoin(target, entry.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, entry.data);
  }

  return findRoot(target);
}

/**
 * Куда распаковывать файл архива.
 *
 * Путь из архива — данные из чужих рук, и в них бывает `../../.ssh/authorized_keys`.
 * Это не паранойя, а известная и живая атака на распаковщики: без проверки
 * архив с плагином переписывает что угодно правами ядра.
 */
function safeJoin(root: string, name: string): string {
  /**
   * Корень тоже приводим к каноническому виду.
   *
   * Сравнивать разрешённый путь с неразрешённым нельзя: `path.resolve` на
   * Windows отдаёт обратные слеши, а пришедший корень может быть с прямыми — и
   * тогда проверка отвергает совершенно законный архив из проводника. Первая
   * версия споткнулась ровно об это, на первом же настоящем zip.
   */
  const base = path.resolve(root);
  const cleaned = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(base, cleaned);

  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Архив пытается писать за пределы папки: ${name}`);
  }
  return full;
}

/**
 * Найти в распакованном корень плагина.
 *
 * Ищем `axon.plugin.json` — сначала рядом, потом на уровень глубже. Глубже
 * второго уровня не спускаемся: это уже не «завернули в папку», а какой-то
 * другой архив, и молча копаться в нём хуже, чем честно отказать.
 */
function findRoot(dir: string): string {
  if (fs.existsSync(path.join(dir, 'axon.plugin.json'))) return dir;

  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const nested = path.join(dir, item.name);
    if (fs.existsSync(path.join(nested, 'axon.plugin.json'))) return nested;
  }

  throw new Error('В архиве нет файла axon.plugin.json — это не плагин Axon');
}

/** Разобрать архив: сначала пробуем zip, потом gzip-tar. */
function read(archive: Buffer): ArchiveEntry[] {
  if (archive.length >= 4 && archive.readUInt32LE(0) === 0x04034b50) return unzip(archive);
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) {
    return untar(zlib.gunzipSync(archive));
  }
  throw new Error('Непонятный формат: нужен .zip или .tar.gz');
}

// ─── Zip ────────────────────────────────────────────────────────────────────

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Прочитать zip.
 *
 * Идём от оглавления в конце файла, а не от начала: только оно достоверно
 * говорит, где какая запись и сколько их. Локальные заголовки при потоковой
 * записи содержат нули в полях размера, и архив, собранный на лету, по ним
 * не читается.
 */
function unzip(archive: Buffer): ArchiveEntry[] {
  const eocd = findEocd(archive);
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  const entries: ArchiveEntry[] = [];

  for (let i = 0; i < count; i += 1) {
    if (archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error('Оглавление архива испорчено');
    }

    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    offset += 46 + nameLength + extraLength + commentLength;

    // Папки внутри архива создаём по путям файлов — отдельные записи не нужны.
    if (name.endsWith('/')) continue;

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressed);

    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`В архиве неизвестное сжатие (${method}) у файла ${name}`);
  }

  return entries;
}

/**
 * Найти оглавление.
 *
 * Оно в конце, но за ним может лежать комментарий архива до 64 КБ, поэтому
 * ищем подпись с конца, а не читаем последние двадцать два байта.
 */
function findEocd(archive: Buffer): number {
  const from = Math.max(0, archive.length - 22 - 0xffff);

  for (let i = archive.length - 22; i >= from; i -= 1) {
    if (archive.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error('Это не zip: не нашлось оглавления');
}

// ─── Tar ────────────────────────────────────────────────────────────────────

const BLOCK = 512;

function untar(archive: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;

    const name = block.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(block.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim(), 8);
    const kind = String.fromCharCode(block[156] ?? 0);

    offset += BLOCK;
    if (Number.isNaN(size)) throw new Error('Архив испорчен: не читается размер файла');

    // '0' и '\0' — обычный файл; остальное (папки, ссылки) пропускаем.
    if (name && (kind === '0' || kind === '\0')) {
      entries.push({ name, data: Buffer.from(archive.subarray(offset, offset + size)) });
    }
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }

  return entries;
}
