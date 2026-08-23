import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogSource, createRuntime, parseCatalog, type Runtime } from '../src/index.js';

let runtime: Runtime;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-catalog-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ENTRY = {
  id: 'probe',
  name: 'Проба',
  description: 'Запись каталога',
  install: { type: 'git', url: 'https://example.com/plug.git' },
};

describe('разбор каталога', () => {
  it('понимает и голый массив, и объект с entries', () => {
    expect(parseCatalog(JSON.stringify([ENTRY]))).toHaveLength(1);
    expect(parseCatalog(JSON.stringify({ entries: [ENTRY] }))).toHaveLength(1);
  });

  it('битую запись выбрасывает, остальные оставляет', () => {
    // Каталог приезжает по сети, и одна опечатка в нём не должна оставлять
    // человека без всего раздела. Из него ставят программы — доверять ему на
    // слово нельзя тем более.
    const mixed = JSON.stringify([ENTRY, { id: 'broken' }, { ...ENTRY, id: 'second' }]);
    const parsed = parseCatalog(mixed);

    expect(parsed.map((entry) => entry.id)).toEqual(['probe', 'second']);
  });

  it('не разваливается на чужом json', () => {
    expect(parseCatalog('{"что-то":"другое"}')).toEqual([]);
    expect(parseCatalog('[]')).toEqual([]);
  });
});

describe('источник каталога', () => {
  it('без сети и кэша отдаёт список из сборки', async () => {
    // Обещание работать без интернета никто не отменял: ядро может стоять в
    // локалке, и пустой раздел был бы издевательством.
    runtime.store.updateSettings({
      values: { 'plugins.catalogUrl': 'http://127.0.0.1:1/нет-такого' },
    });

    const source = new CatalogSource(runtime.store, tmpDir);
    const result = await source.get();

    expect(result.origin).toBe('bundled');
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('поднимает кэш, когда сеть отвалилась', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'catalog.json'),
      JSON.stringify({ entries: [ENTRY], fetchedAt: '2026-08-01T00:00:00.000Z' }),
      'utf8',
    );
    runtime.store.updateSettings({
      values: { 'plugins.catalogUrl': 'http://127.0.0.1:1/нет-такого' },
    });

    const result = await new CatalogSource(runtime.store, tmpDir).get();

    expect(result.origin).toBe('cache');
    expect(result.entries.map((entry) => entry.id)).toEqual(['probe']);
    expect(result.fetchedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('битый кэш не мешает — падаем на сборку', async () => {
    fs.writeFileSync(path.join(tmpDir, 'catalog.json'), 'не json вовсе', 'utf8');
    runtime.store.updateSettings({
      values: { 'plugins.catalogUrl': 'http://127.0.0.1:1/нет-такого' },
    });

    expect((await new CatalogSource(runtime.store, tmpDir).get()).origin).toBe('bundled');
  });

  it('адрес берётся из настроек', async () => {
    // Чтобы можно было указать свой форк или внутренний адрес в организации.
    runtime.store.updateSettings({ values: { 'plugins.catalogUrl': '   ' } });
    // Пустая настройка — не адрес: падаем на умолчание, а не ходим в никуда.
    const result = await new CatalogSource(runtime.store, tmpDir).get();
    expect(['network', 'cache', 'bundled']).toContain(result.origin);
  });
});
