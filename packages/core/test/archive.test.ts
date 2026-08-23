import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unpack } from '../src/plugins/archive.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-archive-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Собрать zip без сжатия — этого хватает, чтобы проверить разбор. */
function zip(files: Array<{ name: string; text: string }>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.text, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // без сжатия
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const entry = Buffer.concat([local, name, data]);
    locals.push(entry);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(0, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, name]));

    offset += entry.length;
  }

  const body = Buffer.concat(locals);
  const directory = Buffer.concat(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(body.length, 16);

  return Buffer.concat([body, directory, end]);
}

describe('распаковка архива плагина', () => {
  it('находит плагин, лежащий в корне', () => {
    const archive = zip([
      { name: 'axon.plugin.json', text: '{"id":"мой"}' },
      { name: 'index.js', text: 'export const a = 1;' },
    ]);

    const root = unpack(archive, path.join(dir, 'out'));
    expect(fs.readdirSync(root).sort()).toEqual(['axon.plugin.json', 'index.js']);
  });

  it('находит плагин внутри обёрточной папки', () => {
    // Так делают все: «Download ZIP» на гитхабе и «сжать папку» в проводнике
    // заворачивают всё в одну папку с именем проекта.
    const archive = zip([
      { name: 'мой-плагин/axon.plugin.json', text: '{"id":"мой"}' },
      { name: 'мой-плагин/index.js', text: 'export const a = 1;' },
    ]);

    const root = unpack(archive, path.join(dir, 'out'));
    expect(path.basename(root)).toBe('мой-плагин');
    expect(fs.existsSync(path.join(root, 'index.js'))).toBe(true);
  });

  it('принимает пути с обратными слешами', () => {
    // Проводник Windows пишет в архив именно такие — и первая версия на этом
    // споткнулась, приняв законный архив за попытку побега.
    const archive = zip([{ name: String.raw`мой-плагин\axon.plugin.json`, text: '{"id":"мой"}' }]);

    const root = unpack(archive, path.join(dir, 'out'));
    expect(fs.existsSync(path.join(root, 'axon.plugin.json'))).toBe(true);
  });

  it('не даёт архиву писать за пределы папки', () => {
    // Живая и известная атака на распаковщики: без проверки такой архив
    // переписывает что угодно правами ядра.
    const archive = zip([{ name: '../../захвачено.txt', text: 'ой' }]);

    expect(() => unpack(archive, path.join(dir, 'out'))).toThrow(/за пределы/);
  });

  it('отказывается от архива без манифеста', () => {
    const archive = zip([{ name: 'readme.md', text: '# просто папка' }]);
    expect(() => unpack(archive, path.join(dir, 'out'))).toThrow(/axon\.plugin\.json/);
  });

  it('понимает tar.gz', () => {
    // Тот же формат, что у резервных копий: человеку с терминалом приятно,
    // что его архив тоже приняли.
    const header = Buffer.alloc(512);
    const name = 'axon.plugin.json';
    header.write(name, 0);
    header.write('0000644\0', 100);
    const data = Buffer.from('{"id":"мой"}', 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);

    const padded = Buffer.alloc(512);
    data.copy(padded);
    const archive = zlib.gzipSync(Buffer.concat([header, padded, Buffer.alloc(1024)]));

    const root = unpack(archive, path.join(dir, 'out'));
    expect(fs.existsSync(path.join(root, 'axon.plugin.json'))).toBe(true);
  });
});
