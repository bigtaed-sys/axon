import { z } from 'zod';
import { zExternalId, zId, zTimestamp } from './primitives.js';

// ─── Контент сообщений ──────────────────────────────────────────────────────

/**
 * Бинарь по проводу не ездит. Картинки, файлы, аудио кладутся в blob-хранилище
 * ядра и передаются ссылкой: иначе журнал раздувается на первом же скриншоте,
 * а синк по мобильному каналу становится неподъёмным.
 */
export const zContentPart = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    text: z.string(),
  }),
  z.object({
    type: z.literal('blob'),
    blobId: zId,
    mime: z.string(),
    bytes: z.number().int().nonnegative(),
    name: z.string().optional(),
  }),
]);
export type ContentPart = z.infer<typeof zContentPart>;

export const zRole = z.enum(['user', 'assistant', 'tool', 'system']);
export type Role = z.infer<typeof zRole>;

// ─── Учёт токенов ───────────────────────────────────────────────────────────

/**
 * Расход за один вызов модели.
 *
 * Чтение из кэша и запись в кэш разведены намеренно: у них разная цена (чтение
 * ~0.1 от обычного ввода, запись ~1.25) и, главное, разный диагностический смысл.
 * Если запись есть, а чтения нет — кэш промпта молча ломается каждый запрос, и
 * это самая дорогая из незаметных ошибок. Свернув их в одно поле, увидеть это
 * невозможно.
 */
export const zUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  /** Прочитано из кэша промпта. */
  cachedInputTokens: z.number().int().nonnegative().default(0),
  /** Записано в кэш промпта. */
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative(),
  /** Оценка стоимости по тарифу провайдера на момент вызова. */
  costUsd: z.number().nonnegative().optional(),
  provider: z.string(),
  model: z.string(),
});
export type Usage = z.infer<typeof zUsage>;

// ─── Инструменты ────────────────────────────────────────────────────────────

/**
 * Уровень риска инструмента. Определяет, нужно ли спрашивать разрешение и какому
 * устройству инструмент вообще доступен.
 *
 * safe      — читает или пишет только внутри ядра (память, заметки, поиск).
 * sensitive — ходит наружу или трогает чужие системы (HTTP, умный дом, отправка сообщений).
 * dangerous — необратимо действует на хост (shell, запись файлов, управление вводом).
 */
export const zRiskTier = z.enum(['safe', 'sensitive', 'dangerous']);
export type RiskTier = z.infer<typeof zRiskTier>;

export const zToolInfo = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  tier: zRiskTier,
  /** JSON Schema аргументов. Клиенту нужна для отрисовки карточки вызова. */
  parameters: z.record(z.unknown()),
  /** Кто предоставил инструмент: `builtin` или id плагина. */
  source: z.string(),
  enabled: z.boolean(),
});
export type ToolInfo = z.infer<typeof zToolInfo>;

// ─── Провайдеры моделей ─────────────────────────────────────────────────────

/**
 * Описание провайдера для интерфейса.
 *
 * Список приходит из ядра, а не зашит в клиенте. Иначе провайдер, который
 * принёс плагин, выбрать было бы негде: приложение рисовало бы свои шесть
 * строк и ничего не знало бы о седьмой.
 */
export const zProviderInfo = z.object({
  id: z.string(),
  title: z.string(),
  /** Нужен ли API-ключ. Локальные модели и провайдеры плагинов обходятся без него. */
  requiresKey: z.boolean(),
  /** Под каким именем ключ лежит в секретах ядра. */
  secretKey: z.string(),
  defaultModel: z.string(),
  defaultBaseUrl: z.string().optional(),
  supportsPromptCache: z.boolean(),
  /** Куда идти за ключом — показывается в онбординге. */
  keyUrl: z.string().optional(),
  /** Готов ли к работе: ключ задан либо не требуется. */
  configured: z.boolean(),
  /** `builtin` или `plugin:<id>`. */
  source: z.string(),
  /** Известные модели. У встроенных провайдеров пусто — там модель вводится руками. */
  models: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        contextTokens: z.number().int().positive().optional(),
      }),
    )
    .default([]),
});
export type ProviderInfo = z.infer<typeof zProviderInfo>;

export const zToolCall = z.object({
  /** id приходит от провайдера, поэтому не UUID. */
  id: zExternalId,
  name: z.string(),
  arguments: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof zToolCall>;

/**
 * Результат вызова. Полный вывод всегда уезжает в blob, а в журнал и в контекст
 * модели попадает только ограниченный `preview` — это главный источник утечки
 * токенов в агентах, и здесь он закрыт на уровне протокола, а не «не забудьте обрезать».
 */
export const zToolResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    preview: z.string(),
    truncated: z.boolean().default(false),
    /** Полный вывод, если он не поместился в preview. */
    fullBlobId: zId.optional(),
    durationMs: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    durationMs: z.number().int().nonnegative(),
  }),
]);
export type ToolResult = z.infer<typeof zToolResult>;

// ─── Разбор контекста ───────────────────────────────────────────────────────

/**
 * Одна составляющая промпта: сколько она стоит и попадает ли в кэш.
 *
 * Именно `cached` делает отчёт полезным, а не просто длинным: часть, которая
 * переиспользуется из кэша, стоит примерно десятую долю обычной, поэтому
 * большой стабильный префикс — это хорошо, а маленький изменчивый хвост в
 * начале — дорого.
 */
export const zContextPart = z.object({
  key: z.string(),
  label: z.string(),
  tokens: z.number().int().nonnegative(),
  cached: z.boolean(),
  detail: z.string().optional(),
});
export type ContextPart = z.infer<typeof zContextPart>;

export const zContextReport = z.object({
  parts: z.array(zContextPart),
  totalTokens: z.number().int().nonnegative(),
  cacheableTokens: z.number().int().nonnegative(),
  provider: z.string().optional(),
  model: z.string().optional(),
  supportsPromptCache: z.boolean(),
});
export type ContextReport = z.infer<typeof zContextReport>;

// ─── Сообщения и разговоры ──────────────────────────────────────────────────

export const zMessage = z.object({
  id: zId,
  conversationId: zId,
  role: zRole,
  parts: z.array(zContentPart),
  /** Заполняется у assistant-сообщения, которое запросило инструменты. */
  toolCalls: z.array(zToolCall).optional(),
  /** Заполняется у tool-сообщения — к какому вызову относится результат. */
  toolCallId: zExternalId.optional(),
  createdAt: zTimestamp,
  /** Расход на генерацию именно этого сообщения. */
  usage: zUsage.optional(),
});
export type Message = z.infer<typeof zMessage>;

export const zConversation = z.object({
  id: zId,
  title: z.string(),
  createdAt: zTimestamp,
  updatedAt: zTimestamp,
  archived: z.boolean().default(false),
  /** Сколько токенов суммарно съел разговор за всё время. Видно пользователю. */
  totalTokens: z.number().int().nonnegative().default(0),
});
export type Conversation = z.infer<typeof zConversation>;

// ─── Прогон агента ──────────────────────────────────────────────────────────

export const zRunState = z.enum(['running', 'done', 'failed', 'cancelled']);
export type RunState = z.infer<typeof zRunState>;

export const zStopReason = z.enum([
  /** Модель закончила ответ сама. */
  'end_turn',
  /** Упёрлись в потолок итераций «модель → инструмент → модель». */
  'max_iterations',
  /** Исчерпан бюджет токенов на прогон. */
  'budget_exhausted',
  /** Пользователь нажал стоп. */
  'cancelled',
  /** Разрешение на инструмент не выдано. */
  'permission_denied',
  /** Модель отказалась отвечать (сработали классификаторы безопасности). */
  'refusal',
  /** Провайдер или инструмент упали. */
  'error',
]);
export type StopReason = z.infer<typeof zStopReason>;

// ─── Разрешения ─────────────────────────────────────────────────────────────

export const zPermissionRequest = z.object({
  id: zId,
  runId: zId,
  toolName: z.string(),
  tier: zRiskTier,
  /** Почему агент считает, что это нужно — показывается пользователю. */
  reason: z.string(),
  arguments: z.record(z.unknown()),
  /** До какого момента запрос имеет смысл; после — считается протухшим. */
  expiresAt: zTimestamp,
});
export type PermissionRequest = z.infer<typeof zPermissionRequest>;

export const zPermissionDecision = z.enum([
  'allow_once',
  'allow_always',
  'deny_once',
  'deny_always',
  /** Никто не ответил до expiresAt. */
  'expired',
]);
export type PermissionDecision = z.infer<typeof zPermissionDecision>;

// ─── Устройства ─────────────────────────────────────────────────────────────

/**
 * Права выдаются устройству, а не пользователю. Телефон в метро и десктоп в
 * локалке — это разные уровни доверия, даже если за ними один человек.
 */
export const zScope = z.enum([
  'chat.read',
  'chat.write',
  'tools.safe',
  'tools.sensitive',
  'tools.dangerous',
  'settings.write',
  'devices.manage',
]);
export type Scope = z.infer<typeof zScope>;

export const zDevicePlatform = z.enum(['desktop', 'mobile', 'web', 'telegram', 'cli']);
export type DevicePlatform = z.infer<typeof zDevicePlatform>;

export const zDevice = z.object({
  id: zId,
  name: z.string(),
  platform: zDevicePlatform,
  scopes: z.array(zScope),
  pairedAt: zTimestamp,
  lastSeenAt: zTimestamp.optional(),
});
export type Device = z.infer<typeof zDevice>;

// ─── Память ─────────────────────────────────────────────────────────────────

export const zFact = z.object({
  id: zId,
  key: z.string(),
  value: z.string(),
  /** Откуда факт взялся: `user` — сказал явно, `inferred` — агент вывел сам. */
  origin: z.enum(['user', 'inferred']),
  createdAt: zTimestamp,
  updatedAt: zTimestamp,
});
export type Fact = z.infer<typeof zFact>;

/**
 * Наблюдение — память об отношениях, а не о мире.
 *
 * Факт отвечает на вопрос «что верно»: часовой пояс, имя жены, порт сервера.
 * Наблюдение отвечает на «как оно с этим человеком»: что его раздражает, о
 * чём он думает эти недели, чем кончился прошлый заход на ту же задачу.
 * Свалить это в одну таблицу заманчиво, но у них разная жизнь: факт верен,
 * пока его не отменили, а наблюдение выцветает само. «Занят переездом» через
 * полгода — не память, а мусор в промпте.
 *
 * Отсюда `weight` и `lastSeenAt`: вес растёт, когда наблюдение подтверждается,
 * и затухает со временем. Без затухания через месяц общения в системный блок
 * уезжает простыня на двести строк, и характер в ней тонет.
 */
export const zObservation = z.object({
  id: zId,
  text: z.string(),
  /**
   * О чём наблюдение. Нужен не для красоты: разные виды стареют с разной
   * скоростью — привычка живёт годами, а настроение недели две.
   */
  kind: z.enum(['habit', 'preference', 'context', 'mood', 'relationship']),
  /** Вес на момент записи. Наружу отдаётся как есть, затухание считает ядро. */
  weight: z.number(),
  /** Сколько раз подтверждалось. В отличие от веса, не убывает. */
  hits: z.number().int().nonnegative(),
  createdAt: zTimestamp,
  updatedAt: zTimestamp,
  /** Когда в последний раз подтвердилось. От него считается затухание. */
  lastSeenAt: zTimestamp,
});
export type Observation = z.infer<typeof zObservation>;

/** Как называются виды наблюдений по-человечески. */
export const OBSERVATION_KINDS: Readonly<Record<Observation['kind'], string>> = {
  habit: 'привычка',
  preference: 'предпочтение',
  context: 'что происходит',
  mood: 'настроение',
  relationship: 'об общении',
};
