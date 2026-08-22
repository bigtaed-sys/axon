import fs from 'node:fs';
import path from 'node:path';
import type {
  CatalogEntry,
  JournalEntry,
  PluginInfo,
  PluginSource,
} from '@axon/protocol';
import type { ContextBuilder } from '../agent/ContextBuilder.js';
import { logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { BlobStore } from '../storage/BlobStore.js';
import type { Store } from '../storage/Store.js';
import type { PluginRow } from '../storage/repos.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import { DISABLED_SKILLS_SETTING, type SkillRegistry } from '../skills/SkillRegistry.js';
import { CATALOG } from './catalog.js';
import { install } from './install.js';
import { LoadedPlugin, settingKey } from './LoadedPlugin.js';
import { readManifest } from './manifest.js';
import type { LogLine } from './PluginProcess.js';

export interface PluginHostOptions {
  store: Store;
  tools: ToolRegistry;
  context: ContextBuilder;
  providers: ProviderRegistry;
  skills: SkillRegistry;
  blobs: BlobStore;
  /** Куда складывать плагины и их данные. */
  dataDir: string;
  /** Рабочее состояние плагина изменилось — уходит клиентам сигналом. */
  onStatus?(plugin: PluginInfo): void;
}

export class PluginError extends Error {
  constructor(
    message: string,
    readonly code: string = 'plugin_error',
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

/**
 * Реестр установленных плагинов.
 *
 * Разделение обязанностей здесь простое и намеренное: база помнит, что
 * установлено и включено; папка на диске — что именно; `LoadedPlugin` — что
 * из этого сейчас работает. Никто не дублирует чужую половину, поэтому нет и
 * состояния «в базе одно, на диске другое», которое невозможно вылечить, не
 * зная, какая из двух записей правдивее.
 */
export class PluginHost {
  private readonly loaded = new Map<string, LoadedPlugin>();
  private readonly log = logger.child({ module: 'plugins' });
  readonly pluginsDir: string;
  readonly pluginDataDir: string;

  constructor(private readonly options: PluginHostOptions) {
    this.pluginsDir = path.join(options.dataDir, 'plugins');
    this.pluginDataDir = path.join(options.dataDir, 'plugin-data');
  }

  // ─── Чтение ───────────────────────────────────────────────────────────────

  catalog(): readonly CatalogEntry[] {
    return CATALOG;
  }

  list(): PluginInfo[] {
    return [...this.loaded.values()]
      .map((plugin) => plugin.info())
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): LoadedPlugin | null {
    return this.loaded.get(id) ?? null;
  }

  logs(id: string, limit: number): LogLine[] {
    const plugin = this.loaded.get(id);
    if (!plugin) throw new PluginError(`Плагин ${id} не установлен`, 'not_found');
    return plugin.logs(limit);
  }

  // ─── Загрузка при старте ──────────────────────────────────────────────────

  /**
   * Поднять всё установленное.
   *
   * Плагины стартуют параллельно и независимо: один зависший MCP-сервер не
   * должен задерживать запуск ядра на тридцать секунд, а его падение — мешать
   * остальным. Ошибка каждого остаётся в его собственном статусе.
   */
  async startAll(): Promise<void> {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    fs.mkdirSync(this.pluginDataDir, { recursive: true });

    const rows = this.options.store.plugins.list();
    await Promise.all(
      rows.map(async (row) => {
        const dir = row.originType === 'link' ? row.originRef : path.join(this.pluginsDir, row.id);
        try {
          const manifest = readManifest(dir);
          const plugin = new LoadedPlugin(
            row.id,
            manifest,
            dir,
            path.join(this.pluginDataDir, row.id),
            { type: row.originType, ref: row.originRef },
            row.installedAt,
            row.updatedAt,
            row.enabled,
            this.deps(),
          );
          this.loaded.set(row.id, plugin);
          await plugin.start();
        } catch (error) {
          // Папка потерялась или манифест испортился — плагин остаётся
          // записанным, но не поднимается. Молча выкидывать его из базы нельзя:
          // человек потеряет настройки, которые вводил.
          this.log.warn({ plugin: row.id, err: (error as Error).message }, 'плагин не прочитан');
        }
      }),
    );
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.loaded.values()].map((plugin) => plugin.stop()));
    this.loaded.clear();
  }

  /** Разослать журнальное событие тем плагинам, что просили право `journal`. */
  deliver(entries: readonly JournalEntry[]): void {
    for (const plugin of this.loaded.values()) {
      for (const entry of entries) plugin.deliverJournal(entry);
    }
  }

  // ─── Изменения ────────────────────────────────────────────────────────────

  async install(source: PluginSource): Promise<PluginInfo> {
    fs.mkdirSync(this.pluginsDir, { recursive: true });

    const result = await install(source, this.pluginsDir, (id) => this.loaded.has(id));
    const now = new Date().toISOString();

    // Настройки записываем до старта: плагин должен увидеть их в activate, а
    // не через секунду после — иначе его первое действие уйдёт без токена.
    this.writeSettings(result.manifest.id, result.values, result.secretKeys, now);

    this.options.store.transact(() => {
      this.options.store.plugins.upsert({
        id: result.manifest.id,
        originType: result.origin.type,
        originRef: result.origin.ref,
        enabled: true,
        installedAt: now,
        updatedAt: now,
      });
    });

    const plugin = new LoadedPlugin(
      result.manifest.id,
      result.manifest,
      result.dir,
      path.join(this.pluginDataDir, result.manifest.id),
      result.origin,
      now,
      now,
      true,
      this.deps(),
    );
    this.loaded.set(plugin.id, plugin);
    await plugin.start();

    this.announce(plugin);
    return plugin.info();
  }

  async remove(id: string): Promise<void> {
    const plugin = this.require(id);
    await plugin.stop();
    this.loaded.delete(id);

    // Папку сносим только если её создавали мы. Связанную папку разработчика
    // удалять нельзя ни при каких условиях: это его исходники.
    if (plugin.origin.type !== 'link') {
      fs.rmSync(path.join(this.pluginsDir, id), { recursive: true, force: true });
    }
    fs.rmSync(path.join(this.pluginDataDir, id), { recursive: true, force: true });

    this.options.store.transact(() => {
      for (const field of plugin.manifest.settings) {
        const key = settingKey(id, field.key);
        this.options.store.settings.delete(key);
        this.options.store.secrets.delete(key);
      }
      this.options.store.plugins.delete(id);
      this.options.store.record({ type: 'plugin.removed', id });
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.require(id);
    const now = new Date().toISOString();

    this.options.store.plugins.setEnabled(id, enabled, now);
    plugin.markUpdated(now);
    await plugin.setEnabled(enabled);
    this.announce(plugin);
  }

  /**
   * Обновить плагин, не потеряв то, что человек в нём настроил.
   *
   * Настройки живут в базе, а не в папке плагина, поэтому обновление — это
   * замена папки и перезагрузка. Настройки нового манифеста, которых не было в
   * старом, просто окажутся незаполненными, и плагин честно скажет «нужна
   * настройка» вместо того, чтобы падать.
   */
  async update(id: string): Promise<PluginInfo> {
    const plugin = this.require(id);
    const row = this.options.store.plugins.get(id);
    if (!row) throw new PluginError(`Плагин ${id} не установлен`, 'not_found');

    if (row.originType === 'link') {
      // Связанная папка и так живёт у автора: обновлять нечего, достаточно
      // перечитать её с диска.
      await this.reload(id);
      return this.require(id).info();
    }
    if (row.originType !== 'git') {
      throw new PluginError(
        'Обновляются только плагины из репозитория. Обёртки вокруг MCP-серверов ' +
          'обновлять нечего — их код не наш.',
        'bad_request',
      );
    }

    await plugin.stop();
    this.loaded.delete(id);

    const dir = path.join(this.pluginsDir, id);
    // Старую папку держим до успеха: если клон не удался, вернём как было и
    // человек останется с работающим плагином, а не с пустым местом.
    const backup = `${dir}.старая`;
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(dir)) fs.renameSync(dir, backup);

    try {
      const result = await install({ type: 'git', url: row.originRef }, this.pluginsDir, () => false);
      if (result.manifest.id !== id) {
        throw new PluginError(
          `В репозитории теперь плагин ${result.manifest.id}, а не ${id}. ` +
            'Поставьте его отдельно.',
          'bad_request',
        );
      }
      fs.rmSync(backup, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, dir);
      await this.restore(id, row);
      throw error;
    }

    const now = new Date().toISOString();
    this.options.store.plugins.upsert({ ...row, updatedAt: now });
    await this.restore(id, { ...row, updatedAt: now });

    const fresh = this.require(id);
    this.announce(fresh);
    return fresh.info();
  }

  /** Поднять плагин из его записи в базе — общий хвост обновления и отката. */
  private async restore(id: string, row: PluginRow): Promise<void> {
    const dir = row.originType === 'link' ? row.originRef : path.join(this.pluginsDir, id);
    const plugin = new LoadedPlugin(
      id,
      readManifest(dir),
      dir,
      path.join(this.pluginDataDir, id),
      { type: row.originType, ref: row.originRef },
      row.installedAt,
      row.updatedAt,
      row.enabled,
      this.deps(),
    );
    this.loaded.set(id, plugin);
    await plugin.start();
  }

  async reload(id: string): Promise<void> {
    const plugin = this.require(id);
    await plugin.stop();
    this.loaded.delete(id);

    const row = this.options.store.plugins.get(id);
    if (!row) throw new PluginError(`Плагин ${id} не установлен`, 'not_found');

    const dir = row.originType === 'link' ? row.originRef : path.join(this.pluginsDir, id);
    // Манифест перечитываем с диска: перезагрузка нужна именно затем, чтобы
    // подхватить правки автора, а не поднять заново то же самое из памяти.
    const manifest = readManifest(dir);

    const fresh = new LoadedPlugin(
      id,
      manifest,
      dir,
      path.join(this.pluginDataDir, id),
      { type: row.originType, ref: row.originRef },
      row.installedAt,
      new Date().toISOString(),
      row.enabled,
      this.deps(),
    );
    this.loaded.set(id, fresh);
    await fresh.start();
    this.announce(fresh);
  }

  async configure(
    id: string,
    values: Record<string, unknown>,
    secrets: Record<string, string | null>,
  ): Promise<void> {
    const plugin = this.require(id);
    const now = new Date().toISOString();

    this.options.store.transact(() => {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(values)) {
        this.options.store.settings.set(settingKey(id, key), value, now);
        keys.push(key);
      }
      for (const [key, value] of Object.entries(secrets)) {
        const full = settingKey(id, key);
        if (value === null || value === '') this.options.store.secrets.delete(full);
        else this.options.store.secrets.set(full, value);
        keys.push(key);
      }
      if (keys.length > 0) {
        this.options.store.record({
          type: 'settings.changed',
          keys: keys.map((key) => settingKey(id, key)),
        });
      }
    });

    plugin.markUpdated(now);

    // Плагин, который не поднялся из-за незаполненной настройки, должен
    // подняться сам, как только её заполнили: заставлять человека ещё и жать
    // «перезагрузить» после того, как он ввёл токен, — лишний шаг ни за чем.
    const status = plugin.info().status;
    if (plugin.isEnabled && (status === 'needs_setup' || status === 'failed')) {
      await this.reload(id);
      return;
    }

    plugin.notifySettings();
    this.announce(plugin);
  }

  // ─── Скиллы ───────────────────────────────────────────────────────────────

  setSkillEnabled(skillId: string, enabled: boolean): PluginInfo | null {
    const skill = this.options.skills.get(skillId);
    if (!skill) throw new PluginError(`Скилла ${skillId} нет`, 'not_found');

    this.options.skills.setEnabled(skillId, enabled);
    this.options.store.transact(() => {
      this.options.store.settings.set(
        DISABLED_SKILLS_SETTING,
        this.options.skills.disabledIds(),
        new Date().toISOString(),
      );
      this.options.store.record({ type: 'settings.changed', keys: [DISABLED_SKILLS_SETTING] });
    });

    const plugin = this.loaded.get(skill.pluginId);
    if (!plugin) return null;
    this.announce(plugin);
    return plugin.info();
  }

  // ─── Внутреннее ───────────────────────────────────────────────────────────

  private require(id: string): LoadedPlugin {
    const plugin = this.loaded.get(id);
    if (!plugin) throw new PluginError(`Плагин ${id} не установлен`, 'not_found');
    return plugin;
  }

  private writeSettings(
    id: string,
    values: Record<string, string>,
    secretKeys: string[],
    at: string,
  ): void {
    const secrets = new Set(secretKeys);
    this.options.store.transact(() => {
      for (const [key, value] of Object.entries(values)) {
        const full = settingKey(id, key);
        if (secrets.has(key)) this.options.store.secrets.set(full, value);
        else this.options.store.settings.set(full, value, at);
      }
    });
  }

  /**
   * Решение пользователя — в журнал, чтобы доехало до всех устройств и
   * пережило перезапуск. Рабочее состояние туда не пишется: см. events.ts.
   */
  private announce(plugin: LoadedPlugin): void {
    this.options.store.transact(() => {
      this.options.store.record({ type: 'plugin.changed', plugin: plugin.info() });
    });
  }

  private deps() {
    return {
      store: this.options.store,
      tools: this.options.tools,
      context: this.options.context,
      providers: this.options.providers,
      skills: this.options.skills,
      blobs: this.options.blobs,
      onStatus: (plugin: LoadedPlugin) => this.options.onStatus?.(plugin.info()),
    };
  }
}
