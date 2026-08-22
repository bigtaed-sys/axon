/**
 * @axon-assistant/plugin-sdk — то, что нужно, чтобы написать плагин Axon.
 *
 * Пакет почти целиком состоит из типов и не тянет ни одной зависимости. Это
 * не аскеза: `api` приезжает аргументом в `activate`, поэтому в рантайме
 * плагину импортировать из SDK нечего. Плагин без единой зависимости — папка,
 * которую можно склонировать и запустить, а не проект, который надо сначала
 * собрать.
 *
 * ```js
 * export async function activate(api) {
 *   await api.tools.register({
 *     name: 'ping',
 *     title: 'Пинг',
 *     description: 'Проверить, что плагин жив. Вызывай, если просят проверить связь.',
 *     tier: 'safe',
 *     parameters: { type: 'object', properties: {} },
 *     execute: async () => 'понг',
 *   });
 * }
 * ```
 */

/** Уровень риска. Определяет, спросят ли разрешение и кому инструмент доступен. */
export type RiskTier = 'safe' | 'sensitive' | 'dangerous';

export interface Fact {
  id: string;
  key: string;
  value: string;
  origin: 'user' | 'inferred';
  createdAt: string;
  updatedAt: string;
}

export interface PluginToolContext {
  conversationId: string;
  runId: string;
  /** Отменяется, когда пользователь останавливает прогон. */
  signal: AbortSignal;
  /**
   * Спросить разрешение посреди выполнения. Возвращает решение; если ответить
   * некому (фоновая задача, клиент без прав) — false.
   */
  requestPermission(reason: string): Promise<boolean>;
}

export interface PluginTool {
  /**
   * Короткое имя. Ядро добавит префикс с id плагина: `search` плагина `github`
   * модель увидит как `github_search`. Поэтому два плагина с одинаково
   * названными инструментами не затирают друг друга.
   */
  name: string;
  title: string;
  /** Для модели — «когда вызывать», а не только «что делает». */
  description: string;
  tier: RiskTier;
  /** JSON Schema аргументов. Обычный объект: zod здесь не нужен. */
  parameters: Record<string, unknown>;
  /**
   * Не грузить схему в контекст, пока модель сама не спросит. Для редких
   * инструментов — прямая экономия на каждом запросе.
   */
  deferred?: boolean;
  /** Свой потолок вывода в символах. По умолчанию 2000. */
  previewLimit?: number;
  execute(
    args: Record<string, unknown>,
    ctx: PluginToolContext,
  ): Promise<string | { text: string; mime?: string }>;
}

export interface PluginModelInfo {
  id: string;
  name?: string;
  contextTokens?: number;
  inputPerMTok?: number;
  outputPerMTok?: number;
}

export type PluginChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; call: { id: string; name: string; arguments: Record<string, unknown> } }
  | {
      type: 'usage';
      usage: {
        inputTokens: number;
        cachedInputTokens?: number;
        cacheWriteTokens?: number;
        outputTokens: number;
        costUsd?: number;
        provider: string;
        model: string;
      };
    }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'cancelled' };

export interface PluginProvider {
  id: string;
  label: string;
  supportsPromptCache: boolean;
  models: PluginModelInfo[];
  chat(request: unknown, signal: AbortSignal): AsyncIterable<PluginChatEvent>;
}

export interface PluginContributeInput {
  conversationId: string;
  /** Последнее сообщение пользователя — для поиска по релевантности. */
  userText: string;
}

/**
 * Куда попадёт вклад в промпт:
 *
 * - `stable` — в системный блок, то есть в кэшируемый префикс;
 * - `volatile` — в самый хвост, после всей истории.
 *
 * Ошибка не видна глазом, но дорога: изменчивый текст (время, курс, погода) в
 * стабильной части обнуляет кэш промпта на каждом ходу.
 */
export type PluginStability = 'stable' | 'volatile';

export interface PluginJournalEntry {
  seq: number;
  at: string;
  event: { type: string } & Record<string, unknown>;
}

export interface PluginApi {
  readonly id: string;
  /** Корень плагина. Только чтение: обновление перезаписывает папку. */
  readonly dir: string;
  /** Личная папка для данных плагина. Переживает обновление. */
  readonly dataDir: string;

  readonly log: {
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };

  readonly settings: {
    all(): Record<string, unknown>;
    get<T = unknown>(key: string): T | undefined;
    set(values: Record<string, unknown>): Promise<void>;
    onChange(listener: (values: Record<string, unknown>) => void): void;
  };

  readonly tools: {
    register(tool: PluginTool): Promise<void>;
    unregister(name: string): Promise<void>;
  };

  readonly context: {
    /** Добавить абзац в промпт. `null` из функции — в этот раз ничего не добавлять. */
    contribute(
      name: string,
      stability: PluginStability,
      contribute: (input: PluginContributeInput) => Promise<string | null> | string | null,
    ): Promise<void>;
    remove(name: string): Promise<void>;
  };

  readonly providers: {
    register(provider: PluginProvider): Promise<void>;
    unregister(id: string): Promise<void>;
  };

  readonly skills: {
    /** Добавить скилл на лету. Обычно они просто лежат файлами в папке из манифеста. */
    add(skill: { name: string; description: string; body: string }): Promise<void>;
  };

  readonly jobs: {
    /** Обработчик задачи из манифеста. Расписанием владеет ядро. */
    on(name: string, run: () => Promise<void> | void): void;
  };

  readonly journal: {
    /** Требует права `journal` в манифесте — иначе события просто не придут. */
    on(listener: (entry: PluginJournalEntry) => void): void;
  };

  readonly memory: {
    facts(): Promise<Fact[]>;
    remember(key: string, value: string): Promise<void>;
  };

  readonly blobs: {
    /** Положить большой вывод в хранилище ядра вместо того, чтобы гнать его в модель. */
    write(input: {
      data: Uint8Array | string;
      mime: string;
      name?: string;
    }): Promise<{ blobId: string; bytes: number }>;
  };
}

/** Это плагин экспортирует из файла, указанного в `main`. */
export interface PluginModule {
  activate(api: PluginApi): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

/**
 * Помощники для вывода типов. Ничего не делают в рантайме — существуют только
 * затем, чтобы редактор подсказывал поля, не заставляя писать аннотации.
 */
export function defineTool(tool: PluginTool): PluginTool {
  return tool;
}

export function definePlugin(module: PluginModule): PluginModule {
  return module;
}
