import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/index.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-scaffold-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('заготовка плагина', () => {
  it('делает манифест, код и описание', () => {
    const created = scaffold(path.join(dir, 'my-plugin'));

    expect(created.id).toBe('my-plugin');
    expect(created.files.sort()).toEqual(['README.md', 'axon.plugin.json', 'index.js']);
  });

  it('манифест разбирается и задействует новые возможности', () => {
    // Заготовка должна показывать то, ради чего страница настроек и делалась:
    // разделы и кнопку. Пустой шаблон научил бы писать плагины прошлого года.
    const created = scaffold(path.join(dir, 'plug'));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(created.dir, 'axon.plugin.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(manifest['id']).toBe('plug');
    expect(manifest['sections']).toHaveLength(1);
    expect(manifest['actions']).toHaveLength(1);
  });

  it('берёт имя из папки, но принимает и своё', () => {
    const created = scaffold(path.join(dir, 'какая-то-папка'), 'my-name');
    expect(created.id).toBe('my-name');
  });

  it('не затирает существующий плагин', () => {
    // Иначе одна опечатка в пути стирает чужую работу.
    const target = path.join(dir, 'plug');
    scaffold(target);
    fs.writeFileSync(path.join(target, 'index.js'), 'моя работа', 'utf8');

    expect(() => scaffold(target)).toThrow(/уже есть плагин/);
    expect(fs.readFileSync(path.join(target, 'index.js'), 'utf8')).toBe('моя работа');
  });

  it('отказывается от негодного имени', () => {
    // Кириллица в id развалила бы манифест на первой же проверке ядра —
    // лучше сказать сразу, чем создать папку, которая не поставится.
    expect(() => scaffold(path.join(dir, 'мой-плагин'))).toThrow(/id/);
  });
});
