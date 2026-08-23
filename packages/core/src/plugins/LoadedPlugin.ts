import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Fact,
  JournalEntry,
  PluginInfo,
  PluginManifest,
  PluginOrigin,
  PluginStatus,
} from '@axon/protocol';
import type { ContextBuilder } from '../agent/ContextBuilder.js';
import { logger, type Logger } from '../logger.js';
import { McpConnection } from '../mcp/McpConnection.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { ChatEvent, ChatRequest, Provider } from '../providers/types.js';
import type { BlobStore } from '../storage/BlobStore.js';
import type { Store } from '../storage/Store.js';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { ToolContext, ToolDefinition } from '../tools/types.js';
import { readSkillsFromDir, type SkillRegistry } from '../skills/SkillRegistry.js';
import {
  TO_CORE,
  TO_PLUGIN,
  type AddSkillParams,
  type LogParams,
  type ProviderChatParams,
  type RegisterContributorParams,
  type RegisterProviderParams,
  type RegisterToolParams,
  type RequestPermissionParams,
  type ToolExecuteParams,
  type ToolExecuteResult,
  type WriteBlobParams,
} from './contract.js';
import { PluginProcess, type LogLine } from './PluginProcess.js';

export interface LoadedPluginDeps {
  store: Store;
  tools: ToolRegistry;
  context: ContextBuilder;
  providers: ProviderRegistry;
  skills: SkillRegistry;
  blobs: BlobStore;
  /** Позвать, когда изменилось рабочее состояние — оно уходит сигналом. */
  onStatus(plugin: LoadedPlugin): void;
}

/** Префикс, под которым настройки плагина лежат в общей таблице. */
export function settingKey(pluginId: string, key: string): string {
  return `plugin.${pluginId}.${key}`;
}

/**
 * Один установленный плагин со всем, что он принёс в ядро.
 *
 * Класс держит один инвариант, ради которого он и существует: всё, что плагин
 * зарегистрировал, записано здесь поимённо. Поэтому выгрузка — это не «попросим
 * его прибраться», а честное снятие регистрации по списку. Плагин, который
 * упал, забыл про `deactivate` или завис, не оставляет за собой инструментов,
 * на вызове которых прогон агента упрётся в мёртвый процесс.
 */
export class LoadedPlugin {
  private process: PluginProcess | null = null;
  private readonly mcp: McpConnection[] = [];
  private readonly ownTools = new Set<string>();
  private readonly contributors = new Set<string>();
  private readonly providerIds = new Set<string>();
  private readonly timers: NodeJS.Timeout[] = [];
  /** Контексты выполняющихся вызовов — по ним плагин просит разрешения. */
  private readonly calls = new Map<string, ToolContext>();
  private readonly jobState = new Map<string, { lastRunAt?: string; lastError?: string }>();
  private readonly lines: LogLine[] = [];
  private readonly log: Logger;

  private status: PluginStatus = 'disabled';
  private error: string | undefined;

  constructor(
    readonly id: string,
    readonly manifest: PluginManifest,
    readonly dir: string,
    readonly dataDir: string,
    readonly origin: PluginOrigin,
    readonly installedAt: string,
    private updatedAt: string,
    private enabled: boolean,
    private readonly deps: LoadedPluginDeps,
  ) {
    this.log = logger.child({ plugin: id });
    if (!enabled) this.status = 'disabled';
  }

  // ─── Наблюдение ───────────────────────────────────────────────────────────

  info(): PluginInfo {
    return {
      id: this.id,
      name: this.manifest.name,
      description: this.manifest.description,
      version: this.manifest.version,
      ...(this.manifest.author ? { author: this.manifest.author } : {}),
      ...(this.manifest.homepage ? { homepage: this.manifest.homepage } : {}),
      origin: this.origin,
      permissions: this.manifest.permissions,
      settings: this.manifest.settings,
      sections: this.manifest.sections,
      actions: this.manifest.actions,
      settingValues: this.publicSettings(),
      enabled: this.enabled,
      status: this.status,
      ...(this.error ? { error: this.error } : {}),
      // Свои инструменты и инструменты MCP-серверов — один список: для
      // пользователя это всё «что умеет этот плагин», и делить их по способу
      // появления значит перекладывать нашу внутреннюю кухню на него.
      tools: [...this.ownTools, ...this.mcp.flatMap((connection) => [...connection.toolNames])]
        .map((name) => this.deps.tools.get(name))
        .filter((tool): tool is ToolDefinition => tool !== null)
        .map((tool) => ({ name: tool.name, title: tool.title, tier: tool.tier })),
      skills: this.deps.skills.list(this.id),
      mcpServers: this.mcp.map((connection) => connection.info()),
      providers: [...this.providerIds],
      jobs: this.manifest.jobs.map((job) => {
        const state = this.jobState.get(job.name) ?? {};
        return {
          name: job.name,
          everySeconds: job.everySeconds,
          ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
          ...(state.lastError ? { lastError: state.lastError } : {}),
        };
      }),
      installedAt: this.installedAt,
      updatedAt: this.updatedAt,
    };
  }

  logs(limit: number): LogLine[] {
    const own = this.process?.logs(limit) ?? [];
    return [...this.lines, ...own].slice(-limit);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  markUpdated(at: string): void {
    this.updatedAt = at;
  }

  // ─── Настройки ────────────────────────────────────────────────────────────

  /**
   * Значения для интерфейса. Секрет отдаётся как `true`/`false`, а не текстом:
   * снапшот уезжает на все устройства, и токен из настроек плагина не должен
   * оказаться на телефоне, который просто подключился посмотреть чат.
   */
  private publicSettings(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const field of this.manifest.settings) {
      const key = settingKey(this.id, field.key);
      values[field.key] =
        field.type === 'secret'
          ? this.deps.store.secrets.has(key)
          : (this.deps.store.settings.get(key) ?? field.default);
    }
    return values;
  }

  /** Значения для самого плагина — здесь секреты настоящие. */
  private resolvedSettings(): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    for (const field of this.manifest.settings) {
      const key = settingKey(this.id, field.key);
      values[field.key] =
        field.type === 'secret'
          ? (this.deps.store.secrets.reveal(key) ?? undefined)
          : (this.deps.store.settings.get(key) ?? field.default);
    }
    return values;
  }

  /** Заполнено ли всё обязательное. Без этого запускать плагин бессмысленно. */
  private missingRequired(): string[] {
    const values = this.resolvedSettings();
    return this.manifest.settings
      .filter((field) => field.required)
      .filter((field) => {
        const value = values[field.key];
        return value === undefined || value === null || value === '' || value === false;
      })
      .map((field) => field.label);
  }

  /** Сообщить работающему плагину, что настройки поменялись. */
  notifySettings(): void {
    this.process?.emit(TO_PLUGIN.settingsChanged, { values: this.resolvedSettings() });
  }

  /** Переслать журнальное событие — только если плагин просил такое право. */
  deliverJournal(entry: JournalEntry): void {
    if (!this.manifest.permissions.includes('journal')) return;
    this.process?.emit(TO_PLUGIN.journalEvent, { entry });
  }

  // ─── Запуск ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.enabled) {
      this.setStatus('disabled');
      return;
    }

    const missing = this.missingRequired();
    if (missing.length > 0) {
      // Не «упал», а «не настроен»: разница видна пользователю и подсказывает,
      // что чинить — заполнить поле, а не читать логи.
      this.error = `Заполните: ${missing.join(', ')}`;
      this.setStatus('needs_setup');
      return;
    }

    this.error = undefined;
    this.setStatus('starting');

    try {
      // Прошлые подключения оставались ради их статусов; новый запуск начинает
      // с чистого списка, иначе после каждой перезагрузки серверов было бы вдвое.
      this.mcp.length = 0;
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.loadSkills();
      await this.startProcess();
      await this.startMcp();
      this.scheduleJobs();
      this.setStatus('ready');
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.log.warn({ err: this.error }, 'плагин не поднялся');
      await this.teardown();
      this.setStatus('failed');
    }
  }

  async stop(): Promise<void> {
    await this.teardown();
    this.setStatus(this.enabled ? 'disabled' : 'disabled');
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) await this.start();
    else await this.stop();
  }

  /**
   * Снять всё, что плагин зарегистрировал.
   *
   * Порядок важен: сначала убираем инструменты из реестра, потом гасим
   * процесс. Наоборот — и между двумя шагами модель успела бы вызвать
   * инструмент, за которым уже никого нет.
   */
  private async teardown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;

    for (const name of this.ownTools) this.deps.tools.unregister(name);
    this.ownTools.clear();

    for (const name of this.contributors) this.deps.context.removeContributor(name);
    this.contributors.clear();

    for (const id of this.providerIds) this.deps.providers.unregisterExternal(id);
    this.providerIds.clear();

    this.deps.skills.removeByPlugin(this.id);
    this.calls.clear();

    // Соединения останавливаем, но из списка не выкидываем: их статус —
    // единственное, что объясняет пользователю, почему плагин не поднялся.
    await Promise.all(this.mcp.map((connection) => connection.stop()));

    const process = this.process;
    this.process = null;
    await process?.stop();
  }

  private setStatus(status: PluginStatus): void {
    this.status = status;
    this.deps.onStatus(this);
  }

  private record(level: string, text: string): void {
    this.lines.push({ at: new Date().toISOString(), level, text });
    if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100);
  }

  // ─── Скиллы из папки ──────────────────────────────────────────────────────

  private loadSkills(): void {
    if (!this.manifest.skills) return;
    const dir = path.resolve(this.dir, this.manifest.skills);
    for (const skill of readSkillsFromDir(dir, this.id)) this.deps.skills.add(skill);
  }

  // ─── MCP-серверы ──────────────────────────────────────────────────────────

  private async startMcp(): Promise<void> {
    for (const [name, transport] of Object.entries(this.manifest.mcpServers)) {
      const connection = new McpConnection({
        pluginId: this.id,
        name,
        transport: this.expandTransport(transport),
        tools: this.deps.tools,
        onLog: (level, text) => this.record(level, text),
        onChanged: () => this.deps.onStatus(this),
      });
      this.mcp.push(connection);
      await connection.start();
    }

    // Сервер, который не поднялся, — это отказ плагина, а не мелочь: без него
    // половина обещанных инструментов просто отсутствует, и молчать об этом
    // значит оставить человека гадать, почему агент «не умеет».
    const broken = this.mcp.filter((connection) => connection.info().status === 'failed');
    if (broken.length > 0) {
      const details = broken
        .map((connection) => `${connection.info().name}: ${connection.info().error}`)
        .join('; ');
      throw new Error(`MCP-сервер не поднялся — ${details}`);
    }
  }

  /**
   * Подставить настройки плагина в конфигурацию MCP-сервера.
   *
   * Без этого каталожный плагин вокруг чужого сервера был бы невозможен: токен
   * вводит пользователь, а попасть он должен в переменные окружения процесса,
   * который запустит ядро.
   */
  private expandTransport(transport: PluginManifest['mcpServers'][string]) {
    const values = this.resolvedSettings();
    const substitute = (text: string): string =>
      text.replace(/\$\{([a-zA-Z0-9_.-]+)\}/g, (match, key: string) => {
        const value = values[key];
        return value === undefined || value === null ? match : String(value);
      });

    if (transport.type === 'http') {
      return {
        ...transport,
        url: substitute(transport.url),
        headers: Object.fromEntries(
          Object.entries(transport.headers).map(([k, v]) => [k, substitute(v)]),
        ),
      };
    }
    return {
      ...transport,
      command: substitute(transport.command),
      args: transport.args.map(substitute),
      env: Object.fromEntries(Object.entries(transport.env).map(([k, v]) => [k, substitute(v)])),
    };
  }

  // ─── Процесс плагина ──────────────────────────────────────────────────────

  private async startProcess(): Promise<void> {
    if (!this.manifest.main) return;

    const child = new PluginProcess({
      pluginId: this.id,
      dir: this.dir,
      dataDir: this.dataDir,
      settings: this.resolvedSettings(),
      onExit: (reason) => this.onCrash(reason),
    });
    this.process = child;
    this.installHandlers(child);
    await child.start();
  }

  /**
   * Процесс умер сам. Не перезапускаем: плагин, падающий на старте, будет
   * падать в цикле, а перезапуск с задержкой лишь размажет проблему по времени
   * и скроет её от пользователя. Показываем «упал» и ждём решения человека.
   */
  private onCrash(reason: string): void {
    this.record('error', `Процесс плагина ${reason}`);
    this.error = `Процесс плагина ${reason}`;
    for (const name of this.ownTools) this.deps.tools.unregister(name);
    this.ownTools.clear();
    for (const name of this.contributors) this.deps.context.removeContributor(name);
    this.contributors.clear();
    for (const id of this.providerIds) this.deps.providers.unregisterExternal(id);
    this.providerIds.clear();
    this.process = null;
    this.setStatus('failed');
  }

  private installHandlers(child: PluginProcess): void {
    child.handle(TO_CORE.registerTool, (params: RegisterToolParams) => {
      const definition = this.toDefinition(child, params);
      this.deps.tools.unregister(definition.name);
      this.deps.tools.register(definition);
      this.ownTools.add(definition.name);
      this.deps.onStatus(this);
      return null;
    });

    child.handle(TO_CORE.unregisterTool, (params: { name: string }) => {
      const name = this.toolName(params.name);
      this.deps.tools.unregister(name);
      this.ownTools.delete(name);
      this.deps.onStatus(this);
      return null;
    });

    child.handle(TO_CORE.registerContributor, (params: RegisterContributorParams) => {
      const name = `${this.id}:${params.name}`;
      this.deps.context.removeContributor(name);
      this.deps.context.addContributor({
        name,
        stability: params.stability,
        contribute: async (input) => {
          try {
            return await child.call<string | null>(
              TO_PLUGIN.contribute,
              { name: params.name, conversationId: input.conversationId, userText: input.userText },
              { timeoutMs: 10_000 },
            );
          } catch (error) {
            // Плагин не должен уметь сорвать запрос к модели. Не ответил —
            // считаем, что добавить ему нечего.
            this.record('warn', `Вклад в контекст не получен: ${(error as Error).message}`);
            return null;
          }
        },
      });
      this.contributors.add(name);
      return null;
    });

    child.handle(TO_CORE.unregisterContributor, (params: { name: string }) => {
      const name = `${this.id}:${params.name}`;
      this.deps.context.removeContributor(name);
      this.contributors.delete(name);
      return null;
    });

    child.handle(TO_CORE.registerProvider, (params: RegisterProviderParams) => {
      const id = `${this.id}:${params.id}`;
      this.deps.providers.registerExternal(
        {
          id,
          title: params.label,
          requiresKey: false,
          secretKey: settingKey(this.id, `provider.${params.id}.apiKey`),
          defaultModel: params.models[0]?.id ?? '',
          supportsPromptCache: params.supportsPromptCache,
        },
        this.toProvider(child, id, params),
      );
      this.providerIds.add(id);
      this.deps.onStatus(this);
      return null;
    });

    child.handle(TO_CORE.unregisterProvider, (params: { id: string }) => {
      const id = `${this.id}:${params.id}`;
      this.deps.providers.unregisterExternal(id);
      this.providerIds.delete(id);
      return null;
    });

    child.handle(TO_CORE.addSkill, (params: AddSkillParams) => {
      this.deps.skills.add({
        id: `${this.id}/${params.name}`,
        pluginId: this.id,
        name: params.name,
        description: params.description,
        body: params.body,
        tokens: Math.ceil(params.body.length / 4),
      });
      this.deps.onStatus(this);
      return null;
    });

    child.handle(TO_CORE.requestPermission, async (params: RequestPermissionParams) => {
      const ctx = this.calls.get(params.token);
      // Вызова уже нет — значит спрашивать не у кого и не за чем.
      if (!ctx) return false;
      const tool = this.deps.tools.get(this.currentToolOf(params.token));
      return ctx.requestPermission({
        toolName: tool?.name ?? this.id,
        tier: tool?.tier ?? 'sensitive',
        reason: params.reason,
        arguments: {},
      });
    });

    child.handle(TO_CORE.getSettings, () => this.resolvedSettings());

    child.handle(TO_CORE.setSettings, (params: { values: Record<string, unknown> }) => {
      const now = new Date().toISOString();
      this.deps.store.transact(() => {
        for (const [key, value] of Object.entries(params.values)) {
          this.deps.store.settings.set(settingKey(this.id, key), value, now);
        }
        this.deps.store.record({
          type: 'settings.changed',
          keys: Object.keys(params.values).map((key) => settingKey(this.id, key)),
        });
      });
      this.deps.onStatus(this);
      return null;
    });

    child.handle(TO_CORE.listFacts, (): Fact[] => this.deps.store.facts.list());

    child.handle(TO_CORE.upsertFact, (params: { key: string; value: string }) => {
      this.deps.store.upsertFact(params.key, params.value, 'inferred');
      return null;
    });

    child.handle(TO_CORE.writeBlob, async (params: WriteBlobParams) => {
      return this.deps.blobs.write({
        data: Buffer.from(params.base64, 'base64'),
        mime: params.mime,
        ...(params.name ? { name: params.name } : {}),
      });
    });

    child.peer.onEvent<LogParams>(TO_CORE.log, (params) => {
      this.record(params.level, params.message);
      if (params.level === 'error') this.log.warn({ msg: params.message }, 'плагин сообщил ошибку');
    });
  }

  // ─── Мосты ────────────────────────────────────────────────────────────────

  private toolName(raw: string): string {
    return raw.startsWith(`${this.id}_`) ? raw : `${this.id}_${raw}`;
  }

  /** По метке вызова понять, какой инструмент сейчас выполняется. */
  private currentToolOf(token: string): string {
    return this.tokenTools.get(token) ?? '';
  }

  private readonly tokenTools = new Map<string, string>();

  private toDefinition(child: PluginProcess, params: RegisterToolParams): ToolDefinition {
    const name = this.toolName(params.name);
    return {
      name,
      title: params.title,
      description: params.description,
      tier: params.tier,
      schema: z.record(z.unknown()),
      jsonSchema: params.parameters,
      ...(params.deferred ? { deferred: true } : {}),
      ...(params.previewLimit ? { previewLimit: params.previewLimit } : {}),
      source: `plugin:${this.id}`,
      execute: async (args, ctx) => {
        const token = randomUUID();
        this.calls.set(token, ctx);
        this.tokenTools.set(token, name);
        try {
          const request: ToolExecuteParams = {
            name: params.name,
            args: (args ?? {}) as Record<string, unknown>,
            conversationId: ctx.conversationId,
            runId: ctx.runId,
            token,
          };
          const result = await child.call<ToolExecuteResult>(TO_PLUGIN.toolExecute, request, {
            signal: ctx.signal,
          });
          return { text: result.text, ...(result.mime ? { mime: result.mime } : {}) };
        } finally {
          this.calls.delete(token);
          this.tokenTools.delete(token);
        }
      },
    };
  }

  /**
   * Провайдер плагина в терминах ядра. Поток приходит кусками через RPC и
   * отдаётся дальше как обычный асинхронный итератор — оркестратор не должен
   * знать, что модель живёт в другом процессе.
   */
  private toProvider(child: PluginProcess, id: string, params: RegisterProviderParams): Provider {
    return {
      id,
      supportsPromptCache: params.supportsPromptCache,
      chat(request: ChatRequest): AsyncIterable<ChatEvent> {
        const queue: ChatEvent[] = [];
        let notify: (() => void) | null = null;
        let finished = false;
        let failure: Error | null = null;

        const { signal, ...rest } = request;
        const call: ProviderChatParams = { providerId: params.id, request: rest };

        void child
          .call(TO_PLUGIN.providerChat, call, {
            ...(signal ? { signal } : {}),
            onChunk: (value) => {
              queue.push(value as ChatEvent);
              notify?.();
            },
          })
          .then(
            () => {
              finished = true;
              notify?.();
            },
            (error: Error) => {
              failure = error;
              finished = true;
              notify?.();
            },
          );

        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (queue.length > 0) yield queue.shift()!;
              if (failure) throw failure;
              if (finished) return;
              await new Promise<void>((resolve) => {
                notify = () => {
                  notify = null;
                  resolve();
                };
              });
            }
          },
        };
      },
      listModels: async () => params.models,
    };
  }

  // ─── Задачи по расписанию ─────────────────────────────────────────────────

  private scheduleJobs(): void {
    for (const job of this.manifest.jobs) {
      const run = async (): Promise<void> => {
        try {
          await this.process?.call(TO_PLUGIN.jobRun, { name: job.name }, { timeoutMs: 120_000 });
          this.jobState.set(job.name, { lastRunAt: new Date().toISOString() });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.jobState.set(job.name, {
            lastRunAt: new Date().toISOString(),
            lastError: message,
          });
          this.record('error', `Задача ${job.name}: ${message}`);
        }
        this.deps.onStatus(this);
      };

      const timer = setInterval(() => void run(), job.everySeconds * 1_000);
      // Расписание плагина не должно удерживать ядро от штатного выхода.
      timer.unref?.();
      this.timers.push(timer);
      if (job.immediate) void run();
    }
  }

  /**
   * Нажали кнопку на странице настроек.
   *
   * Отдельный таймаут короче задачного: человек ждёт у экрана, и полминуты —
   * предел, после которого он решает, что сломалось.
   */
  async runAction(name: string): Promise<{ ok: boolean; message: string }> {
    if (!this.manifest.actions.some((action) => action.name === name)) {
      return { ok: false, message: `Плагин не объявлял действия «${name}»` };
    }
    if (!this.process) {
      return { ok: false, message: 'Плагин не запущен' };
    }

    return (await this.process.call(
      TO_PLUGIN.actionRun,
      { name },
      { timeoutMs: 30_000 },
    )) as { ok: boolean; message: string };
  }

}
