import type { RiskTier } from '@axon/protocol';

/**
 * Список методов, которыми ядро и плагин разговаривают. Отдельным файлом,
 * потому что обе стороны компилируются в разные бандлы: один и тот же тип,
 * импортированный обеими, — единственное, что удерживает их согласованными.
 *
 * Направления читаются от лица ядра: `ToPlugin` — ядро зовёт плагин,
 * `ToCore` — плагин зовёт ядро.
 */

// ─── Ядро → плагин ──────────────────────────────────────────────────────────

export interface ActivateParams {
  pluginId: string;
  /** Корень плагина на диске: относительные пути внутри него — от этого места. */
  dir: string;
  /** Папка, куда плагину можно писать своё. Создаётся ядром. */
  dataDir: string;
  /** Значения настроек, включая секреты: процесс всё равно доверенный. */
  settings: Record<string, unknown>;
}

export interface ToolExecuteParams {
  name: string;
  args: Record<string, unknown>;
  conversationId: string;
  runId: string;
  /**
   * Метка конкретного вызова. Нужна, чтобы запрос разрешения, пришедший
   * изнутри выполнения, попал именно в тот прогон, который его ждёт: в одном
   * прогоне инструменты могут выполняться параллельно, и runId их не различает.
   */
  token: string;
}

export interface ToolExecuteResult {
  text: string;
  mime?: string;
}

export interface ContributeParams {
  name: string;
  conversationId: string;
  userText: string;
}

export interface ProviderChatParams {
  providerId: string;
  /** ChatRequest без AbortSignal: сигнал едет отдельным кадром `cancel`. */
  request: unknown;
}

export interface JobRunParams {
  name: string;
}

export const TO_PLUGIN = {
  activate: 'activate',
  deactivate: 'deactivate',
  toolExecute: 'tool.execute',
  contribute: 'context.contribute',
  providerChat: 'provider.chat',
  jobRun: 'job.run',
  /** События: ответа нет. */
  settingsChanged: 'settings.changed',
  journalEvent: 'journal.event',
} as const;

// ─── Плагин → ядро ──────────────────────────────────────────────────────────

export interface RegisterToolParams {
  name: string;
  title: string;
  description: string;
  tier: RiskTier;
  /** JSON Schema аргументов. Zod плагину не нужен — лишняя зависимость. */
  parameters: Record<string, unknown>;
  deferred?: boolean;
  previewLimit?: number;
}

export interface RegisterContributorParams {
  name: string;
  stability: 'stable' | 'volatile';
}

export interface RegisterProviderParams {
  id: string;
  label: string;
  supportsPromptCache: boolean;
  models: Array<{
    id: string;
    name?: string;
    contextTokens?: number;
    inputPerMTok?: number;
    outputPerMTok?: number;
  }>;
}

export interface AddSkillParams {
  name: string;
  description: string;
  body: string;
}

export interface RequestPermissionParams {
  /** Метка вызова из `ToolExecuteParams.token`. */
  token: string;
  reason: string;
}

export interface WriteBlobParams {
  base64: string;
  mime: string;
  name?: string;
}

export interface LogParams {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
}

export const TO_CORE = {
  registerTool: 'tool.register',
  unregisterTool: 'tool.unregister',
  registerContributor: 'context.register',
  unregisterContributor: 'context.unregister',
  registerProvider: 'provider.register',
  unregisterProvider: 'provider.unregister',
  addSkill: 'skill.add',
  requestPermission: 'permission.request',
  getSettings: 'settings.get',
  setSettings: 'settings.set',
  listFacts: 'fact.list',
  upsertFact: 'fact.upsert',
  writeBlob: 'blob.write',
  log: 'log',
} as const;

/**
 * Первый кадр, который плагин обязан прислать после старта. До него ядро не
 * знает, жив ли процесс вообще: `fork` возвращает объект и в том случае, когда
 * модуль падает на импорте.
 */
export const HOST_READY = 'host.ready';

export interface HostReadyParams {
  /** Версия API, на которую собран хост. */
  api: number;
}
