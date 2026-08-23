import fs from 'node:fs';
import path from 'node:path';
import { zCatalogEntry, type CatalogEntry } from '@axon/protocol';
import { logger } from '../logger.js';
import type { Store } from '../storage/Store.js';
import { CATALOG } from './catalog.js';

/**
 * Каталог плагинов: берётся из отдельного репозитория, а не из сборки.
 *
 * Каталог, обновляющийся вместе с ядром, — это не каталог, а список: чтобы
 * добавить в него плагин, пришлось бы выпускать новую версию ядра и ждать,
 * пока её у себя обновят все. Отдельный файл в репозитории правится за минуту
 * и виден всем сразу.
 *
 * ## Три источника, в таком порядке
 *
 * 1. **Сеть.** Свежий файл из репозитория каталога.
 * 2. **Кэш.** То, что скачалось в прошлый раз, — лежит рядом с данными.
 * 3. **Сборка.** Список, вшитый в ядро на момент выпуска.
 *
 * Третий пункт не противоречит замыслу: это не «встроенный каталог», а
 * последнее известное состояние на момент сборки. Без него человек, у которого
 * ядро стоит в локалке без выхода наружу, открыл бы пустой раздел — а обещание
 * работать без интернета никто не отменял.
 *
 * ## Ходим только когда попросили
 *
 * Обновление тянется в тот момент, когда человек открыл установку плагинов, и
 * никогда при запуске ядра. Разница существенная: ядро по-прежнему не ходит в
 * сеть само по себе, оно отвечает на действие человека. Иначе `axon start` на
 * сервере превратился бы в тихий стук по нашему адресу при каждом перезапуске.
 */

/** Откуда брать. Меняется в настройках — например, на свой форк. */
export const CATALOG_URL_SETTING = 'plugins.catalogUrl';

export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/bigtaed-sys/axon-catalog/main/catalog.json';

/** Как часто ходить за обновлением. Каталог меняется днями, а не минутами. */
const FRESH_FOR_MS = 6 * 60 * 60 * 1000;

/** Сколько ждать ответа. Дольше — и человек решит, что окно зависло. */
const TIMEOUT_MS = 8_000;

/** Потолок ответа: каталог — это килобайты, а не мегабайты. */
const MAX_BYTES = 2 * 1024 * 1024;

export type CatalogOrigin = 'network' | 'cache' | 'bundled';

export interface CatalogResult {
  entries: CatalogEntry[];
  origin: CatalogOrigin;
  /** Когда этот список получен. У встроенного — время сборки, то есть неизвестно. */
  fetchedAt?: string;
}

export class CatalogSource {
  private memory: CatalogResult | null = null;
  private fetchedAtMs = 0;

  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}

  private get cacheFile(): string {
    return path.join(this.dataDir, 'catalog.json');
  }

  /**
   * Отдать каталог.
   *
   * `force` — человек нажал «обновить»: идём в сеть, не глядя на свежесть.
   */
  async get(force = false): Promise<CatalogResult> {
    if (!force && this.memory && Date.now() - this.fetchedAtMs < FRESH_FOR_MS) {
      return this.memory;
    }

    const fetched = await this.download();
    if (fetched) {
      this.remember(fetched);
      this.writeCache(fetched);
      return fetched;
    }

    const cached = this.readCache();
    if (cached) {
      // Кэш в памяти не отмечаем свежим: в следующий раз снова попробуем сеть.
      return cached;
    }

    return { entries: [...CATALOG], origin: 'bundled' };
  }

  private remember(result: CatalogResult): void {
    this.memory = result;
    this.fetchedAtMs = Date.now();
  }

  private url(): string {
    const custom = this.store.settings.get<string>(CATALOG_URL_SETTING);
    return custom?.trim() || DEFAULT_CATALOG_URL;
  }

  private async download(): Promise<CatalogResult | null> {
    const url = this.url();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: abort.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const text = await response.text();
      if (text.length > MAX_BYTES) throw new Error('каталог подозрительно велик');

      const entries = parse(text);
      if (entries.length === 0) throw new Error('в каталоге не осталось ни одной годной записи');

      return { entries, origin: 'network', fetchedAt: new Date().toISOString() };
    } catch (error) {
      /**
       * Не достучались — не беда и не повод жаловаться человеку.
       *
       * Ядро в локалке, отвалившийся интернет, наш репозиторий переехал: во
       * всех случаях ниже по списку есть кэш и вшитый список, и раздел
       * откроется. В лог пишем, на экран — нет.
       */
      logger.info({ url, err: (error as Error).message }, 'каталог не обновился');
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private readCache(): CatalogResult | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as {
        entries?: unknown;
        fetchedAt?: string;
      };
      const entries = parseEntries(raw.entries);
      if (entries.length === 0) return null;

      return {
        entries,
        origin: 'cache',
        ...(raw.fetchedAt ? { fetchedAt: raw.fetchedAt } : {}),
      };
    } catch {
      return null;
    }
  }

  private writeCache(result: CatalogResult): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(
        this.cacheFile,
        JSON.stringify({ entries: result.entries, fetchedAt: result.fetchedAt }),
        'utf8',
      );
    } catch (error) {
      // Не записался кэш — работать это не мешает, в следующий раз сходим в сеть.
      logger.warn({ err: (error as Error).message }, 'каталог не закэшировался');
    }
  }
}

/** Разобрать файл каталога: и голый массив, и объект с полем `entries`. */
export function parse(text: string): CatalogEntry[] {
  const raw = JSON.parse(text) as unknown;
  return parseEntries(Array.isArray(raw) ? raw : (raw as { entries?: unknown })?.entries);
}

/**
 * Проверить записи по одной.
 *
 * Битая запись выбрасывается, остальные остаются. Каталог приезжает по сети,
 * и одна опечатка в нём не должна оставлять человека без всего раздела — а
 * доверять ему на слово нельзя тем более: из него ставят программы.
 */
function parseEntries(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: CatalogEntry[] = [];
  for (const item of raw) {
    const parsed = zCatalogEntry.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
    else logger.warn({ issue: parsed.error.issues[0]?.message }, 'запись каталога отброшена');
  }
  return entries;
}
