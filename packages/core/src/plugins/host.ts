import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Fact } from '@axon/protocol';
import type {
  PluginApi,
  PluginChatEvent,
  PluginContributeInput,
  PluginModule,
  PluginProvider,
  PluginStability,
  PluginTool,
} from './api.js';
import {
  HOST_READY,
  TO_CORE,
  TO_PLUGIN,
  type ActionRunParams,
  type ActivateParams,
  type ContributeParams,
  type JobRunParams,
  type ProviderChatParams,
  type ToolExecuteParams,
  type ToolExecuteResult,
} from './contract.js';
import { RpcError, RpcPeer, type RpcFrame } from './rpc.js';

/** Версия API плагинов, которую поддерживает этот хост. */
export const PLUGIN_API_VERSION = 1;

/**
 * Хост плагина — то, что запускается в отдельном процессе.
 *
 * Он ничего не знает ни про базу ядра, ни про его внутренности: только канал к
 * родителю. Это и есть смысл вынесения плагинов в процесс — здесь физически
 * нечего сломать, кроме себя.
 */
export function startPluginHost(): void {
  if (typeof process.send !== 'function') {
    throw new Error('Хост плагина запущен без канала к ядру — так он бесполезен');
  }
  const send = process.send.bind(process);
  const peer = new RpcPeer((frame) => send(frame));
  process.on('message', (frame) => peer.receive(frame as RpcFrame));

  const tools = new Map<string, PluginTool>();
  const contributors = new Map<
    string,
    (input: PluginContributeInput) => Promise<string | null> | string | null
  >();
  const providers = new Map<string, PluginProvider>();
  const jobs = new Map<string, () => Promise<void> | void>();
  /** Обработчики кнопок со страницы настроек. */
  const actions = new Map<string, () => Promise<string | void> | string | void>();
  const journalListeners: Array<(entry: never) => void> = [];
  const settingsListeners: Array<(values: Record<string, unknown>) => void> = [];

  let settings: Record<string, unknown> = {};
  let loaded: PluginModule | null = null;

  // ─── API, который увидит плагин ───────────────────────────────────────────

  function buildApi(params: ActivateParams): PluginApi {
    const log =
      (level: 'debug' | 'info' | 'warn' | 'error') =>
      (message: string, data?: Record<string, unknown>) =>
        peer.emit(TO_CORE.log, { level, message, ...(data ? { data } : {}) });

    return {
      id: params.pluginId,
      dir: params.dir,
      dataDir: params.dataDir,

      log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },

      settings: {
        all: () => ({ ...settings }),
        get: <T,>(key: string) => settings[key] as T | undefined,
        set: async (values) => {
          settings = { ...settings, ...values };
          await peer.call(TO_CORE.setSettings, { values });
        },
        onChange: (listener) => settingsListeners.push(listener),
      },

      tools: {
        register: async (tool) => {
          tools.set(tool.name, tool);
          await peer.call(TO_CORE.registerTool, {
            name: tool.name,
            title: tool.title,
            description: tool.description,
            tier: tool.tier,
            parameters: tool.parameters,
            ...(tool.deferred ? { deferred: true } : {}),
            ...(tool.previewLimit ? { previewLimit: tool.previewLimit } : {}),
          });
        },
        unregister: async (name) => {
          tools.delete(name);
          await peer.call(TO_CORE.unregisterTool, { name });
        },
      },

      context: {
        contribute: async (name: string, stability: PluginStability, contribute) => {
          contributors.set(name, contribute);
          await peer.call(TO_CORE.registerContributor, { name, stability });
        },
        remove: async (name) => {
          contributors.delete(name);
          await peer.call(TO_CORE.unregisterContributor, { name });
        },
      },

      providers: {
        register: async (provider) => {
          providers.set(provider.id, provider);
          await peer.call(TO_CORE.registerProvider, {
            id: provider.id,
            label: provider.label,
            supportsPromptCache: provider.supportsPromptCache,
            models: provider.models,
          });
        },
        unregister: async (id) => {
          providers.delete(id);
          await peer.call(TO_CORE.unregisterProvider, { id });
        },
      },

      skills: {
        add: async (skill) => {
          await peer.call(TO_CORE.addSkill, skill);
        },
      },

      jobs: {
        on: (name, run) => jobs.set(name, run),
      },

      actions: {
        on: (name, run) => actions.set(name, run),
      },

      journal: {
        on: (listener) => journalListeners.push(listener as (entry: never) => void),
      },

      memory: {
        facts: () => peer.call<Fact[]>(TO_CORE.listFacts),
        remember: async (key, value) => {
          await peer.call(TO_CORE.upsertFact, { key, value });
        },
      },

      blobs: {
        write: async ({ data, mime, name }) => {
          const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
          return peer.call(TO_CORE.writeBlob, {
            base64: buffer.toString('base64'),
            mime,
            ...(name ? { name } : {}),
          });
        },
      },

      model: {
        ask: (input) => peer.call(TO_CORE.ask, input) as Promise<string>,
      },

      notify: async (title, body) => {
        await peer.call(TO_CORE.notify, { title, ...(body ? { body } : {}) });
      },

      status: {
        set: async (note, failed) => {
          await peer.call(TO_CORE.setStatus, { note, ...(failed ? { failed } : {}) });
        },
        clear: async () => {
          await peer.call(TO_CORE.setStatus, {});
        },
      },

      history: {
        search: (query, limit) =>
          peer.call(TO_CORE.searchHistory, {
            query,
            ...(limit ? { limit } : {}),
          }) as Promise<
            Array<{ messageId: string; conversationId: string; role: string; snippet: string }>
          >,
      },
    };
  }

  // ─── Ядро → плагин ────────────────────────────────────────────────────────

  peer.handle(TO_PLUGIN.activate, async (params: ActivateParams) => {
    settings = params.settings ?? {};
    const module = await loadModule(params.dir);
    loaded = module;
    await module.activate(buildApi(params));
    return null;
  });

  peer.handle(TO_PLUGIN.deactivate, async () => {
    await loaded?.deactivate?.();
    return null;
  });

  peer.handle(TO_PLUGIN.toolExecute, async (params: ToolExecuteParams, ctx) => {
    const tool = tools.get(params.name);
    if (!tool) throw new RpcError(`Инструмент ${params.name} не зарегистрирован`, 'not_found');

    const output = await tool.execute(params.args, {
      conversationId: params.conversationId,
      runId: params.runId,
      signal: ctx.signal,
      requestPermission: (reason) =>
        peer.call<boolean>(TO_CORE.requestPermission, { token: params.token, reason }),
    });

    const result: ToolExecuteResult =
      typeof output === 'string' ? { text: output } : { text: output.text, ...(output.mime ? { mime: output.mime } : {}) };
    return result;
  });

  peer.handle(TO_PLUGIN.contribute, async (params: ContributeParams) => {
    const contribute = contributors.get(params.name);
    if (!contribute) return null;
    return (
      (await contribute({ conversationId: params.conversationId, userText: params.userText })) ??
      null
    );
  });

  peer.handle(TO_PLUGIN.providerChat, async (params: ProviderChatParams, ctx) => {
    const provider = providers.get(params.providerId);
    if (!provider) throw new RpcError(`Провайдер ${params.providerId} не найден`, 'not_found');

    // Поток отдаётся кусками по мере поступления, а не собирается целиком:
    // иначе пользователь увидел бы ответ только после его окончания.
    for await (const event of provider.chat(params.request, ctx.signal)) {
      ctx.push(event satisfies PluginChatEvent);
    }
    return null;
  });

  peer.handle(TO_PLUGIN.actionRun, async (params: ActionRunParams) => {
    const handler = actions.get(params.name);
    if (!handler) throw new Error(`Плагин не знает действия «${params.name}»`);

    /**
     * Отказ действия — не поломка плагина.
     *
     * «Не удалось подключиться» — законный ответ кнопки «проверить
     * подключение», и падать из-за него нельзя: человек нажал именно затем,
     * чтобы узнать результат.
     */
    try {
      const message = await handler();
      return { ok: true, message: message || 'Готово' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });

  peer.handle(TO_PLUGIN.jobRun, async (params: JobRunParams) => {
    const run = jobs.get(params.name);
    if (!run) throw new RpcError(`Задача ${params.name} не объявлена`, 'not_found');
    await run();
    return null;
  });

  peer.onEvent<{ values: Record<string, unknown> }>(TO_PLUGIN.settingsChanged, ({ values }) => {
    settings = { ...settings, ...values };
    for (const listener of settingsListeners) listener(settings);
  });

  peer.onEvent<{ entry: unknown }>(TO_PLUGIN.journalEvent, ({ entry }) => {
    for (const listener of journalListeners) listener(entry as never);
  });

  // Необработанное исключение внутри плагина не должно выглядеть как «ядро
  // молча зависло»: сообщаем родителю и выходим, чтобы он это увидел и показал.
  process.on('uncaughtException', (error) => {
    peer.emit(TO_CORE.log, { level: 'error', message: `Необработанная ошибка: ${error.message}` });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    peer.emit(TO_CORE.log, { level: 'error', message: `Необработанный отказ: ${String(reason)}` });
  });

  peer.emit(HOST_READY, { api: PLUGIN_API_VERSION });
}

/**
 * Загрузить модуль плагина. `import()` берёт и CommonJS, и ESM, поэтому автору
 * не нужно подстраиваться под наш формат — работает то, что он привык писать.
 */
async function loadModule(dir: string): Promise<PluginModule> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'axon.plugin.json'), 'utf8'),
  ) as { main?: string };
  if (!manifest.main) {
    throw new RpcError('У плагина нет точки входа — запускать нечего', 'no_main');
  }

  const entry = path.resolve(dir, manifest.main);
  const imported = (await import(pathToFileURL(entry).href)) as
    | PluginModule
    | { default: PluginModule };
  const module = 'activate' in imported ? imported : imported.default;

  if (!module || typeof module.activate !== 'function') {
    throw new RpcError(`${manifest.main} не экспортирует activate(api)`, 'bad_entry');
  }
  return module;
}
