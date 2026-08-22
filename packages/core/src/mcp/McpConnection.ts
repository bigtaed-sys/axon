import { z } from 'zod';
import type { McpServerInfo, McpTransport, RiskTier } from '@axon/protocol';
import type { ToolRegistry } from '../tools/ToolRegistry.js';
import type { ToolDefinition } from '../tools/types.js';
import { McpClient } from './McpClient.js';

export interface McpConnectionOptions {
  /** Плагин, которому принадлежит сервер. Из него берётся префикс инструментов. */
  pluginId: string;
  /** Имя сервера внутри плагина: у одного плагина их может быть несколько. */
  name: string;
  transport: McpTransport;
  tools: ToolRegistry;
  onLog(level: string, text: string): void;
  /** Позвать, когда список инструментов изменился — чтобы разослать статус. */
  onChanged(): void;
}

/**
 * Один MCP-сервер, подключённый к ядру.
 *
 * Отвечает за перевод из мира MCP в мир Axon: инструменты сервера получают
 * префикс, уровень риска и попадают в общий реестр наравне со встроенными. Для
 * модели и для пользователя разницы нет — и это правильно: «инструмент из MCP»
 * не тот факт, о котором человек должен думать, выбирая, что разрешить.
 */
export class McpConnection {
  private client: McpClient | null = null;
  private registered: string[] = [];
  private status: McpServerInfo['status'] = 'disabled';
  private error: string | undefined;

  constructor(private readonly options: McpConnectionOptions) {}

  info(): McpServerInfo {
    return {
      name: this.options.name,
      status: this.status,
      toolCount: this.registered.length,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  get toolNames(): readonly string[] {
    return this.registered;
  }

  async start(): Promise<void> {
    this.status = 'starting';
    this.error = undefined;
    this.options.onChanged();

    const client = new McpClient(this.options.name, this.options.transport, this.options.onLog);
    this.client = client;

    try {
      await client.connect();
      const specs = await client.listTools();

      for (const spec of specs) {
        const definition = this.toDefinition(client, spec);
        // Сервер вправе отдать два инструмента с одним именем после
        // переподключения — перерегистрация не должна ронять весь плагин.
        this.options.tools.unregister(definition.name);
        this.options.tools.register(definition);
        this.registered.push(definition.name);
      }

      this.status = 'ready';
    } catch (error) {
      this.status = 'failed';
      this.error = error instanceof Error ? error.message : String(error);
      await client.close().catch(() => {});
      this.client = null;
    }
    this.options.onChanged();
  }

  async stop(): Promise<void> {
    for (const name of this.registered) this.options.tools.unregister(name);
    this.registered = [];
    // Причину падения не стираем: остановка упавшего сервера — это уборка, а
    // не забвение. Иначе в интерфейсе осталось бы «выключен» без объяснения,
    // почему он выключился сам.
    if (this.status !== 'failed') this.status = 'disabled';
    await this.client?.close();
    this.client = null;
    this.options.onChanged();
  }

  /**
   * Инструмент MCP в терминах ядра.
   *
   * Схема аргументов приходит уже готовой JSON Schema, а вся остальная система
   * говорит на zod. Оборачиваем в `z.any()` с ручной подстановкой схемы: чужую
   * схему всё равно нельзя проверять строже, чем это делает сам сервер, —
   * попытка «улучшить» её ломает половину серверов на первом же `oneOf`.
   */
  private toDefinition(client: McpClient, spec: McpToolLike): ToolDefinition {
    return {
      name: this.toolName(spec.name),
      title: spec.annotations?.title ?? spec.name,
      description: spec.description || `Инструмент ${spec.name} сервера ${this.options.name}`,
      tier: tierOf(spec),
      schema: z.record(z.unknown()),
      jsonSchema: spec.inputSchema ?? { type: 'object', properties: {} },
      // Схемы MCP-серверов длинные, а серверов может быть несколько: грузить их
      // все в каждый запрос — самый быстрый способ съесть контекст впустую.
      deferred: true,
      source: `plugin:${this.options.pluginId}`,
      execute: async (args, ctx) => {
        const result = await client.callTool(
          spec.name,
          (args ?? {}) as Record<string, unknown>,
          ctx.signal,
        );
        if (result.isError) throw new Error(result.text || 'MCP-сервер вернул ошибку');
        return { text: result.text };
      },
    };
  }

  /**
   * Имя, под которым инструмент увидит модель.
   *
   * Когда имя сервера совпадает с id плагина — а в каталоге это обычный случай —
   * второй префикс не добавляем: `github_github_search` читается хуже и стоит
   * лишних токенов в каждом запросе.
   */
  private toolName(raw: string): string {
    const prefix =
      this.options.name === this.options.pluginId
        ? this.options.pluginId
        : `${this.options.pluginId}_${this.options.name}`;
    return sanitize(`${prefix}_${raw}`);
  }
}

interface McpToolLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}

/**
 * Уровень риска по подсказкам сервера.
 *
 * Умолчание — `sensitive`, а не `safe`: MCP-сервер по определению ходит в
 * чужую систему. Сервер, не заполнивший аннотации, не должен получать доступ
 * без спроса только потому, что поленился их заполнить.
 */
function tierOf(spec: McpToolLike): RiskTier {
  if (spec.annotations?.destructiveHint) return 'dangerous';
  if (spec.annotations?.readOnlyHint && !spec.annotations.openWorldHint) return 'safe';
  return 'sensitive';
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}
