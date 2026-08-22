import type { z } from 'zod';
import type { RiskTier } from '@axon/protocol';
import type { Logger } from '../logger.js';

/**
 * Куда инструмент может положить большой вывод. Реализация живёт в ядре;
 * исполнитель обращается к ней только когда вывод не влез в preview.
 */
export interface BlobWriter {
  write(input: { data: Buffer | string; mime: string; name?: string }): Promise<{
    blobId: string;
    bytes: number;
  }>;
}

export interface PermissionAsk {
  toolName: string;
  tier: RiskTier;
  /** Зачем это агенту — показывается пользователю. */
  reason: string;
  arguments: Record<string, unknown>;
}

export interface ToolContext {
  conversationId: string;
  runId: string;
  signal: AbortSignal;
  logger: Logger;
  /**
   * Спросить у пользователя разрешение. Возвращает решение; если ответить
   * некому (фоновая рутина, телеграм-адаптер без прав) — false.
   */
  requestPermission(ask: PermissionAsk): Promise<boolean>;
  blobs?: BlobWriter;
}

/** Что инструмент возвращает исполнителю. Обрезкой занимается исполнитель. */
export interface ToolOutput {
  /** Текст для модели. Может быть сколь угодно большим. */
  text: string;
  /** MIME полного вывода, если он поедет в блоб. По умолчанию text/plain. */
  mime?: string;
}

/**
 * Определение инструмента.
 *
 * Схема аргументов задаётся один раз на zod: из неё выводится и типизация
 * `execute`, и JSON Schema для модели, и рантайм-валидация. В старом проекте
 * JSON Schema писалась руками отдельно от проверок — два источника правды,
 * которые расходятся при первой же правке.
 */
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  /** Человеческое имя для карточки вызова в интерфейсе. */
  title: string;
  /**
   * Описание для модели. Пишется предписывающе — «когда вызывать», а не
   * только «что делает»: на этом строится точность вызова.
   */
  description: string;
  tier: RiskTier;
  schema: S;
  /**
   * Готовая JSON Schema вместо выведенной из zod.
   *
   * Нужна там, где схему придумали не мы: MCP-сервер и плагин отдают её уже
   * готовой. Пытаться пересобрать такую схему через zod — значит переписывать
   * чужой контракт по своим представлениям и ломать всё, что не укладывается
   * в подмножество, которое умеет zod. `schema` в этом случае остаётся
   * пропускающей: строже сервера мы аргументы всё равно не проверим.
   */
  jsonSchema?: Record<string, unknown>;
  /**
   * Редкий инструмент: схему не грузить в контекст, пока модель сама не
   * спросит. Экономит токены на каждом запросе.
   */
  deferred?: boolean;
  /**
   * Свой потолок вывода в символах. Общего значения хватает для `ls` и
   * коротких ответов, но чтение файла с ним бесполезно: модель получит
   * первые пару абзацев и всё. Больше — только там, где это правда нужно.
   */
  previewLimit?: number;
  /** `builtin` или id плагина. */
  source: string;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutput>;
}

/**
 * Хелпер объявления инструмента: нужен только чтобы TypeScript вывел тип
 * аргументов `execute` из схемы, а не требовал его дублировать.
 */
export function defineTool<S extends z.ZodType>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition;
}
