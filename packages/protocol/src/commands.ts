import { z } from 'zod';
import { zCursor, zId, zSeq, zTimestamp } from './primitives.js';
import {
  zContentPart,
  zContextReport,
  zConversation,
  zDevice,
  zDevicePlatform,
  zFact,
  zMessage,
  zObservation,
  zPermissionDecision,
  zProviderInfo,
  zScope,
  zToolInfo,
} from './domain.js';
import { zCatalogEntry, zPluginId, zPluginInfo, zPluginSource } from './plugins.js';
import {
  zRoutine,
  zRoutineCompileReq,
  zRoutineCompileRes,
  zRoutineCreateReq,
  zRoutineRunsReq,
  zRoutineRunsRes,
  zRoutineUpdateReq,
} from './routines.js';
import { zJournalEntry } from './events.js';
import { zSettingsGetReq, zSettingsGetRes, zSettingsSetReq } from './settings.js';

// ─── Синхронизация ──────────────────────────────────────────────────────────

export const zSyncPullReq = z.object({
  /** Последний seq, который клиент уже применил. 0 — холодный старт. */
  since: zCursor,
  limit: z.number().int().positive().max(1000).default(200),
});

export const zSyncPullRes = z.object({
  entries: z.array(zJournalEntry),
  /** Курсор после применения выданной пачки. */
  cursor: zSeq,
  /** Есть ли ещё — тянуть до false, потом слушать `evt`. */
  hasMore: z.boolean(),
});

/**
 * Холодный старт без проигрывания всей истории с нуля: ядро отдаёт свёрнутое
 * состояние и курсор, с которого дальше идёт обычный догон.
 */
export const zSyncSnapshotReq = z.object({
  /** Сколько последних разговоров положить в снапшот. */
  conversationLimit: z.number().int().positive().max(200).default(50),
});

export const zSyncSnapshotRes = z.object({
  conversations: z.array(zConversation),
  facts: z.array(zFact),
  observations: z.array(zObservation),
  devices: z.array(zDevice),
  tools: z.array(zToolInfo),
  /** Вместе с рабочим состоянием: журнал его не хранит, а знать его нужно сразу. */
  plugins: z.array(zPluginInfo),
  routines: z.array(zRoutine),
  cursor: zSeq,
});

// ─── Разговоры и сообщения ──────────────────────────────────────────────────

export const zConversationCreateReq = z.object({
  title: z.string().max(200).optional(),
});
export const zConversationCreateRes = z.object({ conversation: zConversation });

export const zConversationRenameReq = z.object({ id: zId, title: z.string().max(200) });
export const zConversationArchiveReq = z.object({ id: zId, archived: z.boolean() });
export const zConversationDeleteReq = z.object({ id: zId });
export const zOkRes = z.object({ ok: z.literal(true) });

/**
 * Постраничная выдача истории. Отдельно от журнала: журнал догоняет изменения,
 * а это — прокрутка вверх по конкретному разговору.
 */
export const zMessageHistoryReq = z.object({
  conversationId: zId,
  /** Грузить сообщения старше этого id. Пусто — с конца. */
  before: zId.optional(),
  limit: z.number().int().positive().max(200).default(50),
});
export const zMessageHistoryRes = z.object({
  messages: z.array(zMessage),
  hasMore: z.boolean(),
});

/**
 * Поиск по переписке. Отдельно от списка разговоров: там фильтр по названию,
 * а здесь — по тому, что внутри.
 */
export const zSearchReq = z.object({
  query: z.string().min(1).max(200),
  limit: z.number().int().positive().max(100).default(40),
});
export const zSearchRes = z.object({
  hits: z.array(
    z.object({
      conversationId: zId,
      conversationTitle: z.string(),
      messageId: zId,
      role: z.string(),
      createdAt: zTimestamp,
      /** Найденные слова обёрнуты в «ёлочки» — клиент подсвечивает по ним. */
      snippet: z.string(),
    }),
  ),
});

export const zMessageSendReq = z.object({
  conversationId: zId,
  parts: z.array(zContentPart).min(1),
  /** Потолок расхода на этот прогон. Пусто — берётся из настроек ядра. */
  budgetTokens: z.number().int().positive().optional(),
  /** Разрешённые инструменты сверх дефолтных прав устройства. */
  allowTools: z.array(z.string()).optional(),
});
export const zMessageSendRes = z.object({
  runId: zId,
  /** Сообщение пользователя, уже записанное в журнал. */
  message: zMessage,
});

export const zRunCancelReq = z.object({ runId: zId });

// ─── Разрешения ─────────────────────────────────────────────────────────────

export const zPermissionResolveReq = z.object({
  requestId: zId,
  decision: zPermissionDecision.exclude(['expired']),
});

// ─── Инструменты ────────────────────────────────────────────────────────────

export const zToolListRes = z.object({ tools: z.array(zToolInfo) });
export const zToolSetEnabledReq = z.object({ name: z.string(), enabled: z.boolean() });

// ─── Рутины ─────────────────────────────────────────────────────────────────

export const zRoutineListRes = z.object({ routines: z.array(zRoutine) });
export const zRoutineRes = z.object({ routine: zRoutine });

// ─── Провайдеры ─────────────────────────────────────────────────────────────

export const zProviderListRes = z.object({ providers: z.array(zProviderInfo) });

// ─── Плагины ────────────────────────────────────────────────────────────────

export const zPluginListRes = z.object({ plugins: z.array(zPluginInfo) });
export const zPluginCatalogRes = z.object({ entries: z.array(zCatalogEntry) });

export const zPluginInstallReq = z.object({ source: zPluginSource });
export const zPluginInstallRes = z.object({ plugin: zPluginInfo });

export const zPluginIdReq = z.object({ id: zPluginId });
export const zPluginSetEnabledReq = z.object({ id: zPluginId, enabled: z.boolean() });

/**
 * Настройки плагина приходят одним вызовом: обычные значения и секреты
 * разделены, потому что хранятся по-разному и по-разному отдаются обратно.
 * `null` в секрете означает «удалить», а не «записать пустую строку».
 */
export const zPluginConfigureReq = z.object({
  id: zPluginId,
  values: z.record(z.unknown()).default({}),
  secrets: z.record(z.string().nullable()).default({}),
});

export const zSkillSetEnabledReq = z.object({ id: z.string(), enabled: z.boolean() });

/**
 * Последние строки, что плагин написал в свой stderr. Без этого единственный
 * способ понять, почему плагин упал, — лезть в логи ядра на чужой машине.
 */
export const zPluginLogsReq = z.object({
  id: zPluginId,
  limit: z.number().int().positive().max(500).default(200),
});
export const zPluginLogsRes = z.object({
  lines: z.array(z.object({ at: z.string(), level: z.string(), text: z.string() })),
});

// ─── Устройства ─────────────────────────────────────────────────────────────

export const zDeviceListRes = z.object({ devices: z.array(zDevice) });
export const zDeviceRevokeReq = z.object({ id: zId });

/**
 * Первый шаг пейринга: уже доверенное устройство просит у ядра короткий код.
 * Второй шаг (`pair.complete`) новое устройство делает по REST — у него ещё нет
 * токена, а значит и WS-сессии.
 */
export const zPairBeginReq = z.object({
  name: z.string().max(100),
  platform: zDevicePlatform,
  scopes: z.array(zScope),
  ttlSeconds: z.number().int().positive().max(3600).default(300),
});
export const zPairBeginRes = z.object({
  code: z.string(),
  expiresInSeconds: z.number().int().positive(),
});

// ─── Память и расход ────────────────────────────────────────────────────────

export const zFactUpsertReq = z.object({ key: z.string().max(200), value: z.string().max(4000) });
export const zFactUpsertRes = z.object({ fact: zFact });
export const zFactForgetReq = z.object({ id: zId });

/**
 * Наблюдения человек только удаляет. Заводить их руками незачем: ценность
 * наблюдения именно в том, что агент заметил это сам — вписанное вручную
 * ничем не отличается от факта, для которого уже есть `fact.upsert`.
 */
export const zObservationForgetReq = z.object({ id: zId });

/**
 * Вход в телеграм под своим аккаунтом — тремя шагами.
 *
 * Одной командой не выйдет: между шагами телеграм присылает код, а человек его
 * набирает. Держать соединение открытым и ждать ввода посреди ядра значит
 * повесить команду до таймаута.
 *
 * Значения шагов наружу не возвращаются никогда: ни код, ни пароль, ни готовая
 * сессия. Сессия — полный доступ к аккаунту, она уходит прямо в секреты.
 */
export const zTelegramLoginReq = z.object({
  step: z.enum(['phone', 'code', 'password', 'cancel']),
  value: z.string().max(200).default(''),
});
export const zTelegramLoginRes = z.object({
  state: z.enum(['code_sent', 'password_needed', 'done', 'cancelled']),
  /** Куда пришёл код — в телеграм или сообщением. Только для подсказки. */
  hint: z.string().optional(),
  /** Как зовут вошедший аккаунт. Появляется на последнем шаге. */
  name: z.string().optional(),
});

export const zTelegramStatusRes = z.object({
  /** Поднят ли бот: у него есть токен и он на связи. */
  bot: z.boolean(),
  /** Работает ли юзербот и под каким именем. */
  user: z.boolean(),
  userName: z.string().optional(),
});

export const zUsageSummaryReq = z.object({
  /** Начало окна, ISO-8601. Пусто — с начала суток по времени ядра. */
  since: z.string().datetime().optional(),
});
export const zUsageSummaryRes = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
  /** Разбивка по моделям — видно, куда именно утекает бюджет. */
  byModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      inputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    }),
  ),
});

// ─── Реестр команд ──────────────────────────────────────────────────────────

/**
 * Единая таблица «имя → схема запроса и ответа». Из неё выводятся типы и для
 * ядра, и для клиента, поэтому рассинхрон невозможен: добавил команду здесь —
 * обе стороны перестают компилироваться, пока её не обработают.
 */
export const commands = {
  'sync.pull': { req: zSyncPullReq, res: zSyncPullRes },
  'sync.snapshot': { req: zSyncSnapshotReq, res: zSyncSnapshotRes },

  'conversation.create': { req: zConversationCreateReq, res: zConversationCreateRes },
  'conversation.rename': { req: zConversationRenameReq, res: zOkRes },
  'conversation.archive': { req: zConversationArchiveReq, res: zOkRes },
  'conversation.delete': { req: zConversationDeleteReq, res: zOkRes },

  'message.history': { req: zMessageHistoryReq, res: zMessageHistoryRes },
  'message.search': { req: zSearchReq, res: zSearchRes },
  'context.report': { req: z.object({ conversationId: zId }), res: zContextReport },
  'message.send': { req: zMessageSendReq, res: zMessageSendRes },
  'run.cancel': { req: zRunCancelReq, res: zOkRes },

  'permission.resolve': { req: zPermissionResolveReq, res: zOkRes },

  'tool.list': { req: z.object({}), res: zToolListRes },
  'tool.setEnabled': { req: zToolSetEnabledReq, res: zOkRes },

  'provider.list': { req: z.object({}), res: zProviderListRes },

  'routine.list': { req: z.object({}), res: zRoutineListRes },
  'routine.compile': { req: zRoutineCompileReq, res: zRoutineCompileRes },
  'routine.create': { req: zRoutineCreateReq, res: zRoutineRes },
  'routine.update': { req: zRoutineUpdateReq, res: zRoutineRes },
  'routine.delete': { req: z.object({ id: zId }), res: zOkRes },
  'routine.runNow': { req: z.object({ id: zId }), res: zRoutineRes },
  'routine.runs': { req: zRoutineRunsReq, res: zRoutineRunsRes },

  'plugin.list': { req: z.object({}), res: zPluginListRes },
  'plugin.catalog': { req: z.object({}), res: zPluginCatalogRes },
  'plugin.install': { req: zPluginInstallReq, res: zPluginInstallRes },
  'plugin.remove': { req: zPluginIdReq, res: zOkRes },
  'plugin.setEnabled': { req: zPluginSetEnabledReq, res: zOkRes },
  'plugin.reload': { req: zPluginIdReq, res: zOkRes },
  'plugin.update': { req: zPluginIdReq, res: zPluginInstallRes },
  'plugin.configure': { req: zPluginConfigureReq, res: zOkRes },
  'plugin.logs': { req: zPluginLogsReq, res: zPluginLogsRes },

  'skill.setEnabled': { req: zSkillSetEnabledReq, res: zOkRes },

  'settings.get': { req: zSettingsGetReq, res: zSettingsGetRes },
  'settings.set': { req: zSettingsSetReq, res: zOkRes },

  'device.list': { req: z.object({}), res: zDeviceListRes },
  'device.revoke': { req: zDeviceRevokeReq, res: zOkRes },
  'device.pairBegin': { req: zPairBeginReq, res: zPairBeginRes },

  'fact.upsert': { req: zFactUpsertReq, res: zFactUpsertRes },
  'fact.forget': { req: zFactForgetReq, res: zOkRes },
  'observation.forget': { req: zObservationForgetReq, res: zOkRes },

  'telegram.login': { req: zTelegramLoginReq, res: zTelegramLoginRes },
  'telegram.logout': { req: z.object({}), res: zOkRes },
  'telegram.status': { req: z.object({}), res: zTelegramStatusRes },

  'usage.summary': { req: zUsageSummaryReq, res: zUsageSummaryRes },
} as const satisfies Record<string, { req: z.ZodTypeAny; res: z.ZodTypeAny }>;

export type CommandName = keyof typeof commands;

/** Тип запроса конкретной команды: `CommandReq<'message.send'>`. */
export type CommandReq<K extends CommandName> = z.infer<(typeof commands)[K]['req']>;
/** Тип ответа конкретной команды: `CommandRes<'message.send'>`. */
export type CommandRes<K extends CommandName> = z.infer<(typeof commands)[K]['res']>;

/** Входной тип до применения `.default()` — то, что клиент реально кладёт в кадр. */
export type CommandInput<K extends CommandName> = z.input<(typeof commands)[K]['req']>;

export const commandNames = Object.keys(commands) as CommandName[];

export function isCommandName(value: string): value is CommandName {
  return Object.hasOwn(commands, value);
}

/** Какой scope нужен, чтобы вызвать команду. Проверяется в демоне до исполнения. */
export const commandScopes: Record<CommandName, ReadonlyArray<z.infer<typeof zScope>>> = {
  'sync.pull': ['chat.read'],
  'sync.snapshot': ['chat.read'],
  'conversation.create': ['chat.write'],
  'conversation.rename': ['chat.write'],
  'conversation.archive': ['chat.write'],
  'conversation.delete': ['chat.write'],
  'message.history': ['chat.read'],
  'message.search': ['chat.read'],
  'context.report': ['chat.read'],
  'message.send': ['chat.write'],
  'run.cancel': ['chat.write'],
  'permission.resolve': ['chat.write'],
  'tool.list': ['chat.read'],
  'tool.setEnabled': ['settings.write'],
  'provider.list': ['chat.read'],
  'routine.list': ['chat.read'],
  'routine.runs': ['chat.read'],
  // Компиляция обращается к модели за счёт пользователя — право то же, что и
  // у обычной переписки.
  'routine.compile': ['chat.write'],
  // Рутина работает без человека рядом, поэтому заводить её — то же по
  // последствиям, что и менять настройки ядра.
  'routine.create': ['settings.write'],
  'routine.update': ['settings.write'],
  'routine.delete': ['settings.write'],
  'routine.runNow': ['chat.write'],
  'plugin.list': ['chat.read'],
  'plugin.catalog': ['chat.read'],
  // Установка плагина — это запуск чужого кода на машине ядра. Право на неё
  // не должно доставаться заодно с правом менять настройки, поэтому нужны оба.
  'plugin.install': ['settings.write', 'devices.manage'],
  'plugin.remove': ['settings.write'],
  'plugin.setEnabled': ['settings.write'],
  'plugin.reload': ['settings.write'],
  // Обновление тянет новый код из репозитория — то же по последствиям, что и
  // установка, поэтому и права те же.
  'plugin.update': ['settings.write', 'devices.manage'],
  'plugin.configure': ['settings.write'],
  'plugin.logs': ['settings.write'],
  'skill.setEnabled': ['settings.write'],
  'settings.get': ['chat.read'],
  'settings.set': ['settings.write'],
  'device.list': ['devices.manage'],
  'device.revoke': ['devices.manage'],
  'device.pairBegin': ['devices.manage'],
  'fact.upsert': ['chat.write'],
  'fact.forget': ['chat.write'],
  'observation.forget': ['chat.write'],
  'telegram.login': ['settings.write'],
  'telegram.logout': ['settings.write'],
  'telegram.status': ['settings.write'],

  'usage.summary': ['chat.read'],
};
