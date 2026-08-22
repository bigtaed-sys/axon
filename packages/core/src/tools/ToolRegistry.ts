import { zodToJsonSchema } from 'zod-to-json-schema';
import type { RiskTier, Scope, ToolInfo } from '@axon/protocol';
import type { ProviderToolSchema } from '../providers/types.js';
import type { ToolDefinition } from './types.js';

/** Где хранится список выключенных инструментов. */
export const DISABLED_TOOLS_SETTING = 'tools.disabled';

/** Какой scope устройства открывает какой уровень риска. */
const TIER_SCOPE: Record<RiskTier, Scope> = {
  safe: 'tools.safe',
  sensitive: 'tools.sensitive',
  dangerous: 'tools.dangerous',
};

export interface SelectOptions {
  /** Права устройства, от имени которого идёт запрос. */
  scopes: readonly Scope[];
  /** Дополнительно разрешённые инструменты сверх прав устройства. */
  allow?: readonly string[];
}

/**
 * Реестр инструментов.
 *
 * Две вещи, которые он обязан гарантировать:
 *
 * 1. **Стабильный порядок.** Схемы инструментов рендерятся в самом начале
 *    запроса к модели, поэтому любая перестановка списка обнуляет кэш промпта
 *    целиком. Сортировка по имени — не косметика, а экономия денег.
 * 2. **Фильтрацию по правам.** Инструмент, недоступный устройству, не должен
 *    вообще попадать в контекст: модель не может вызвать то, чего не видит,
 *    и не тратит токены на чтение схемы, которую всё равно не применит.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly disabled: Set<string>;
  /** JSON Schema считается один раз: zodToJsonSchema заметно не бесплатен. */
  private readonly schemaCache = new Map<string, Record<string, unknown>>();

  /**
   * Выключенные инструменты приходят снаружи: реестр живёт в памяти, а
   * решение пользователя должно переживать перезапуск ядра.
   */
  constructor(disabled: Iterable<string> = []) {
    this.disabled = new Set(disabled);
  }

  /** Имена выключенных — их сохраняет вызывающий. */
  disabledNames(): string[] {
    return [...this.disabled].sort();
  }

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Инструмент ${tool.name} уже зарегистрирован`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: readonly ToolDefinition[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** Снять регистрацию — при выгрузке плагина. */
  unregister(name: string): void {
    this.tools.delete(name);
    this.schemaCache.delete(name);
  }

  get(name: string): ToolDefinition | null {
    return this.tools.get(name) ?? null;
  }

  /** Описание одного инструмента — для события о его изменении. */
  info(name: string): ToolInfo | null {
    const tool = this.get(name);
    if (!tool) return null;
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      tier: tool.tier,
      parameters: this.jsonSchema(tool),
      source: tool.source,
      enabled: this.isEnabled(tool.name),
    };
  }

  setEnabled(name: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(name);
    else this.disabled.add(name);
  }

  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabled.has(name);
  }

  /** Полный список для интерфейса — включая выключенные. */
  list(): ToolInfo[] {
    return this.sorted().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      tier: tool.tier,
      parameters: this.jsonSchema(tool),
      source: tool.source,
      enabled: this.isEnabled(tool.name),
    }));
  }

  /** Что реально уедет в модель для конкретного запроса. */
  select(options: SelectOptions): ProviderToolSchema[] {
    const allow = new Set(options.allow ?? []);
    const scopes = new Set(options.scopes);

    return this.sorted()
      .filter((tool) => this.isEnabled(tool.name))
      .filter((tool) => allow.has(tool.name) || scopes.has(TIER_SCOPE[tool.tier]))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: this.jsonSchema(tool),
        tier: tool.tier,
        ...(tool.deferred ? { deferred: true } : {}),
      }));
  }

  /** Доступен ли инструмент устройству с такими правами. */
  isAllowed(name: string, options: SelectOptions): boolean {
    const tool = this.get(name);
    if (!tool || !this.isEnabled(name)) return false;
    if (options.allow?.includes(name)) return true;
    return options.scopes.includes(TIER_SCOPE[tool.tier]);
  }

  private sorted(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private jsonSchema(tool: ToolDefinition): Record<string, unknown> {
    const cached = this.schemaCache.get(tool.name);
    if (cached) return cached;

    if (tool.jsonSchema) {
      this.schemaCache.set(tool.name, tool.jsonSchema);
      return tool.jsonSchema;
    }

    const schema = zodToJsonSchema(tool.schema, {
      target: 'jsonSchema7',
      $refStrategy: 'none',
    }) as Record<string, unknown>;
    // $schema модели не нужен и только занимает место в каждом запросе.
    delete schema['$schema'];

    this.schemaCache.set(tool.name, schema);
    return schema;
  }
}
