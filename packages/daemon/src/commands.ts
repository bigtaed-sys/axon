import {
  commandScopes,
  commands,
  type CommandName,
  type CommandReq,
  type CommandRes,
  type Device,
} from '@axon/protocol';
import { buildContextReport, DISABLED_TOOLS_SETTING, type Runtime } from '@axon/core';
import type { PairingService } from './auth.js';
import type { PermissionHub } from './PermissionHub.js';

export interface CommandContext {
  runtime: Runtime;
  device: Device;
  pairing: PairingService;
  permissions: PermissionHub;
}

export class CommandError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'bad_request' | 'unknown_command',
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

type Handler<K extends CommandName> = (
  req: CommandReq<K>,
  ctx: CommandContext,
) => Promise<CommandRes<K>> | CommandRes<K>;

type Handlers = { [K in CommandName]: Handler<K> };

const ok = { ok: true } as const;

/**
 * Обработчики команд.
 *
 * Тип `Handlers` требует запись на каждое имя из реестра протокола: добавил
 * команду в контракт — демон перестал компилироваться, пока её не обработали.
 * Это то, ради чего реестр вообще существует.
 */
const handlers: Handlers = {
  // ─── Синхронизация ──
  'sync.pull': (req, { runtime }) => runtime.store.pull(req.since, req.limit),

  'sync.snapshot': (req, { runtime }) => ({
    conversations: runtime.store.conversations.list(req.conversationLimit),
    facts: runtime.store.facts.list(),
    observations: runtime.store.observations.list(),
    devices: runtime.store.devices.list(),
    tools: runtime.tools.list(),
    plugins: runtime.plugins.list(),
    routines: runtime.scheduler.list(),
    cursor: runtime.store.head(),
  }),

  // ─── Разговоры ──
  'conversation.create': (req, { runtime }) => ({
    conversation: req.title
      ? runtime.store.createConversation(req.title)
      : runtime.store.createConversation(),
  }),

  'conversation.rename': (req, { runtime }) => {
    requireConversation(runtime, req.id);
    runtime.store.renameConversation(req.id, req.title);
    return ok;
  },

  'conversation.archive': (req, { runtime }) => {
    requireConversation(runtime, req.id);
    runtime.store.archiveConversation(req.id, req.archived);
    return ok;
  },

  'conversation.delete': (req, { runtime }) => {
    requireConversation(runtime, req.id);
    runtime.store.deleteConversation(req.id);
    return ok;
  },

  // ─── Сообщения ──
  'message.history': (req, { runtime }) => {
    requireConversation(runtime, req.conversationId);
    const messages = runtime.store.messages.page(
      req.conversationId,
      req.before ?? null,
      req.limit,
    );
    return { messages, hasMore: messages.length === req.limit };
  },

  'message.search': (req, { runtime }) => {
    const titles = new Map(runtime.store.conversations.list(500).map((c) => [c.id, c.title]));
    return {
      hits: runtime.store.search
        .search(req.query, req.limit)
        // Разговор мог уйти в архив или быть удалён между индексом и выдачей —
        // показывать находку, которую некуда открыть, незачем.
        .filter((hit) => titles.has(hit.conversationId))
        .map((hit) => ({
          conversationId: hit.conversationId,
          conversationTitle: titles.get(hit.conversationId)!,
          messageId: hit.messageId,
          role: hit.role,
          createdAt: hit.createdAt,
          snippet: hit.snippet,
        })),
    };
  },

  'context.report': async (req, { runtime, device }) => {
    requireConversation(runtime, req.conversationId);
    return buildContextReport(
      {
        store: runtime.store,
        context: runtime.context,
        tools: runtime.tools,
        skills: runtime.skills,
        providers: runtime.providers,
      },
      // Права того устройства, которое спрашивает: у телефона с урезанными
      // правами и контекст будет другой, и врать ему про чужой незачем.
      { conversationId: req.conversationId, access: { scopes: device.scopes } },
    );
  },

  'message.send': (req, { runtime, device }) => {
    requireConversation(runtime, req.conversationId);
    const { runId, message } = runtime.orchestrator.startRun({
      conversationId: req.conversationId,
      parts: req.parts,
      scopes: device.scopes,
      ...(req.allowTools ? { allowTools: req.allowTools } : {}),
      ...(req.budgetTokens === undefined ? {} : { budgetTokens: req.budgetTokens }),
    });
    return { runId, message };
  },

  'run.cancel': (req, { runtime }) => {
    if (!runtime.orchestrator.cancel(req.runId)) {
      throw new CommandError('not_found', `Прогон ${req.runId} не выполняется`);
    }
    return ok;
  },

  // ─── Разрешения ──
  'permission.resolve': (req, { permissions }) => {
    if (!permissions.resolve(req.requestId, req.decision)) {
      throw new CommandError('not_found', 'Запрос разрешения не найден или уже закрыт');
    }
    return ok;
  },

  // ─── Инструменты ──
  'tool.list': (_req, { runtime }) => ({ tools: runtime.tools.list() }),

  'tool.setEnabled': (req, { runtime }) => {
    if (!runtime.tools.get(req.name)) {
      throw new CommandError('not_found', `Инструмент ${req.name} не найден`);
    }

    runtime.tools.setEnabled(req.name, req.enabled);
    const tool = runtime.tools.info(req.name)!;

    runtime.store.transact(() => {
      // Список переживает перезапуск ядра: реестр живёт только в памяти.
      runtime.store.settings.set(
        DISABLED_TOOLS_SETTING,
        runtime.tools.disabledNames(),
        new Date().toISOString(),
      );
      // Событие обязательно: без него клиент не узнает о смене и покажет
      // старое состояние — переключатель будет выглядеть нерабочим.
      runtime.store.record({ type: 'tool.changed', tool });
    });

    return ok;
  },

  // ─── Провайдеры ──
  'provider.list': async (_req, { runtime }) => ({
    providers: await runtime.providers.describe(),
  }),

  // ─── Рутины ──
  'routine.list': (_req, { runtime }) => ({ routines: runtime.scheduler.list() }),

  'routine.compile': async (req, { runtime }) => {
    try {
      return await runtime.scheduler.compile(req.source, req.allowTools);
    } catch (error) {
      // Сборка проваливается по понятным причинам — модель не разобрала
      // задачу, инструмента нет, аргументы не те. Это ответ человеку.
      throw new CommandError('bad_request', (error as Error).message);
    }
  },

  'routine.runs': (req, { runtime }) => ({
    runs: runtime.scheduler.runs(req.routineId, req.limit),
  }),

  'routine.create': (req, { runtime }) => ({ routine: runtime.scheduler.create(req) }),

  'routine.update': (req, { runtime }) => {
    // Незаполненные поля отбрасываем, а не передаём как undefined: иначе
    // «не меняли имя» затёрло бы имя пустотой.
    const patch = Object.fromEntries(
      Object.entries(req).filter(([key, value]) => key !== 'id' && value !== undefined),
    );
    try {
      return { routine: runtime.scheduler.update(req.id, patch) };
    } catch (error) {
      throw new CommandError('not_found', (error as Error).message);
    }
  },

  'routine.delete': (req, { runtime }) => {
    try {
      runtime.scheduler.remove(req.id);
    } catch (error) {
      throw new CommandError('not_found', (error as Error).message);
    }
    return ok;
  },

  'routine.runNow': async (req, { runtime }) => {
    try {
      const { routine } = await runtime.scheduler.runNow(req.id);
      return { routine };
    } catch (error) {
      throw new CommandError('not_found', (error as Error).message);
    }
  },

  // ─── Плагины ──
  'plugin.list': (_req, { runtime }) => ({ plugins: runtime.plugins.list() }),
  'plugin.catalog': (_req, { runtime }) => ({ entries: [...runtime.plugins.catalog()] }),

  'plugin.install': async (req, { runtime }) => {
    try {
      return { plugin: await runtime.plugins.install(req.source) };
    } catch (error) {
      // Установка проваливается по бытовым причинам — нет git, занят id,
      // не заполнен токен. Это ответ пользователю, а не сбой ядра.
      throw new CommandError('bad_request', (error as Error).message);
    }
  },

  'plugin.remove': async (req, { runtime }) => {
    await withPlugin(() => runtime.plugins.remove(req.id));
    return ok;
  },

  'plugin.setEnabled': async (req, { runtime }) => {
    await withPlugin(() => runtime.plugins.setEnabled(req.id, req.enabled));
    return ok;
  },

  'plugin.reload': async (req, { runtime }) => {
    await withPlugin(() => runtime.plugins.reload(req.id));
    return ok;
  },

  'plugin.update': async (req, { runtime }) => {
    try {
      return { plugin: await runtime.plugins.update(req.id) };
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new CommandError(code === 'not_found' ? 'not_found' : 'bad_request', (error as Error).message);
    }
  },

  'plugin.configure': async (req, { runtime }) => {
    await withPlugin(() => runtime.plugins.configure(req.id, req.values, req.secrets));
    return ok;
  },

  'plugin.logs': (req, { runtime }) => {
    try {
      return { lines: runtime.plugins.logs(req.id, req.limit) };
    } catch (error) {
      throw new CommandError('not_found', (error as Error).message);
    }
  },

  'skill.setEnabled': (req, { runtime }) => {
    try {
      runtime.plugins.setSkillEnabled(req.id, req.enabled);
    } catch (error) {
      throw new CommandError('not_found', (error as Error).message);
    }
    return ok;
  },

  // ─── Настройки ──
  // Значения секретов сюда не попадают по построению: они лежат в отдельной
  // таблице, и `settings.all()` их просто не видит.
  'settings.get': (req, { runtime }) => {
    const all = runtime.store.settings.all();
    const values = req.keys
      ? Object.fromEntries(req.keys.filter((k) => k in all).map((k) => [k, all[k]]))
      : all;
    return { values, secrets: runtime.store.secrets.status(req.keys) };
  },

  'settings.set': (req, { runtime }) => {
    runtime.store.updateSettings({
      ...(req.values ? { values: req.values } : {}),
      ...(req.secrets ? { secrets: req.secrets } : {}),
    });
    // Ключ или адрес могли поменяться — старый клиент провайдера больше не годен.
    runtime.providers.invalidate();
    return ok;
  },

  // ─── Устройства ──
  'device.list': (_req, { runtime }) => ({ devices: runtime.store.devices.list() }),

  'device.revoke': (req, { runtime, device }) => {
    if (req.id === device.id) {
      throw new CommandError('bad_request', 'Нельзя отозвать устройство, с которого пришёл запрос');
    }
    if (!runtime.store.devices.get(req.id)) {
      throw new CommandError('not_found', 'Устройство не найдено');
    }
    runtime.store.revokeDevice(req.id);
    return ok;
  },

  'device.pairBegin': (req, { pairing, device }) => {
    // Нельзя выдать новому устройству больше прав, чем есть у выдающего:
    // иначе любой телефон повышает себя до полного доступа за два шага.
    const excess = req.scopes.filter((scope) => !device.scopes.includes(scope));
    if (excess.length > 0) {
      throw new CommandError('forbidden', `Нельзя выдать права, которых нет у вас: ${excess.join(', ')}`);
    }
    return pairing.begin({
      name: req.name,
      platform: req.platform,
      scopes: req.scopes,
      ttlSeconds: req.ttlSeconds,
    });
  },

  // ─── Память ──
  'fact.upsert': (req, { runtime }) => ({
    fact: runtime.store.upsertFact(req.key, req.value, 'user'),
  }),

  'fact.forget': (req, { runtime }) => {
    runtime.store.forgetFact(req.id);
    return ok;
  },

  'observation.forget': (req, { runtime }) => {
    runtime.store.forgetObservation(req.id);
    return ok;
  },

  // ─── Расход ──
  'usage.summary': (req, { runtime }) => {
    const since = req.since ?? startOfToday();
    const totals = runtime.store.usage.totals(since);
    return {
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
      runs: totals.runs,
      byModel: runtime.store.usage.byModel(since),
    };
  },
};

/**
 * Разобрать и выполнить команду. Проверка прав и схемы — до вызова
 * обработчика: обработчик получает уже валидные данные от того, кому можно.
 */
export async function dispatch(
  name: string,
  payload: unknown,
  ctx: CommandContext,
): Promise<unknown> {
  if (!Object.hasOwn(commands, name)) {
    throw new CommandError('unknown_command', `Неизвестная команда: ${name}`);
  }
  const command = name as CommandName;

  const required = commandScopes[command];
  const missing = required.filter((scope) => !ctx.device.scopes.includes(scope));
  if (missing.length > 0) {
    throw new CommandError('forbidden', `Недостаточно прав: нужно ${missing.join(', ')}`);
  }

  const parsed = commands[command].req.safeParse(payload);
  if (!parsed.success) {
    throw new CommandError('bad_request', parsed.error.issues.map((i) => i.message).join('; '));
  }

  const handler = handlers[command] as Handler<CommandName>;
  return await handler(parsed.data as CommandReq<CommandName>, ctx);
}

/**
 * Операции над плагином различают «нет такого» и «не получилось». Без этого
 * клиент видел бы одинаковую ошибку и на опечатку в id, и на упавший git.
 */
async function withPlugin(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new CommandError(code === 'not_found' ? 'not_found' : 'bad_request', (error as Error).message);
  }
}

function requireConversation(runtime: Runtime, id: string): void {
  if (!runtime.store.conversations.get(id)) {
    throw new CommandError('not_found', `Разговор ${id} не найден`);
  }
}

function startOfToday(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}
