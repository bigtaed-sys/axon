import type { ProviderInfo } from '@axon/protocol';
import type { SecretStore } from '../storage/SecretStore.js';
import type { SettingsRepo } from '../storage/repos.js';
import { AnthropicProvider } from './AnthropicProvider.js';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider.js';
import { ProviderError, type Provider } from './types.js';

/**
 * Описание провайдера: всё, что нужно интерфейсу, чтобы нарисовать выбор,
 * и ядру — чтобы собрать клиента. Ключ хранится не здесь, а в SecretStore
 * под именем `secretKey`.
 */
export interface ProviderDescriptor {
  id: string;
  title: string;
  /** Нужен ли API-ключ. Локальные модели обходятся без него. */
  requiresKey: boolean;
  secretKey: string;
  defaultModel: string;
  defaultBaseUrl?: string;
  supportsPromptCache: boolean;
  /** Ссылка на страницу получения ключа — показывается в онбординге. */
  keyUrl?: string;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: 'anthropic',
    title: 'Anthropic',
    requiresKey: true,
    secretKey: 'provider.anthropic.apiKey',
    defaultModel: 'claude-opus-5',
    supportsPromptCache: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'deepseek',
    title: 'DeepSeek',
    requiresKey: true,
    secretKey: 'provider.deepseek.apiKey',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    supportsPromptCache: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'openai',
    title: 'OpenAI',
    requiresKey: true,
    secretKey: 'provider.openai.apiKey',
    defaultModel: 'gpt-4o',
    defaultBaseUrl: 'https://api.openai.com/v1',
    supportsPromptCache: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'openrouter',
    title: 'OpenRouter',
    requiresKey: true,
    secretKey: 'provider.openrouter.apiKey',
    defaultModel: 'anthropic/claude-opus-4-8',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    supportsPromptCache: false,
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'lmstudio',
    title: 'LM Studio (локально)',
    requiresKey: false,
    secretKey: 'provider.lmstudio.apiKey',
    defaultModel: 'local-model',
    defaultBaseUrl: 'http://localhost:1234/v1',
    supportsPromptCache: false,
  },
  {
    id: 'ollama',
    title: 'Ollama (локально)',
    requiresKey: false,
    secretKey: 'provider.ollama.apiKey',
    defaultModel: 'llama3.1',
    defaultBaseUrl: 'http://localhost:11434/v1',
    supportsPromptCache: false,
  },
];

/**
 * Кто распознаёт картинки.
 *
 * Отдельная модель, а не свойство провайдера: зрение — свойство модели, и у
 * одного провайдера одновременно бывают и обычные модели, и vision. Таблица
 * «провайдер умеет картинки» была бы и неверной, и протухающей — модели
 * выходят чаще, чем обновляется ядро.
 *
 * Пусто — распознавания нет, картинки уходят в основную модель как есть.
 */
export const VISION_PROVIDER_SETTING = 'vision.provider';
export const VISION_MODEL_SETTING = 'vision.model';

/**
 * Модель для дешёвой проверки повода написать первым. Проверка идёт раз в
 * несколько минут и почти всегда заканчивается словом «нет», поэтому за неё
 * разумно платить отдельной, самой дешёвой моделью.
 */
/**
 * Модель, превращающая переписку в векторы для поиска по смыслу.
 *
 * Отдельная от разговорной: эмбеддинги — другой класс моделей, у одного
 * провайдера они называются иначе и стоят иначе. Не назначена — семантического
 * поиска нет, полнотекстовый работает как работал.
 */
export const EMBEDDING_PROVIDER_SETTING = 'embedding.provider';
export const EMBEDDING_MODEL_SETTING = 'embedding.model';

export const IMPULSE_PROVIDER_SETTING = 'impulse.provider';
export const IMPULSE_MODEL_SETTING = 'impulse.model';

/**
 * Спросить у провайдера список моделей, не дав ему сорвать отрисовку настроек.
 * Провайдер плагина живёт в чужом процессе: он может не ответить.
 */
async function safeModels(provider: Provider): Promise<ProviderInfo['models']> {
  if (!provider.listModels) return [];
  try {
    const models = await provider.listModels();
    return models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.contextTokens ? { contextTokens: model.contextTokens } : {}),
    }));
  } catch {
    return [];
  }
}

/** Пустая или состоящая из пробелов настройка равносильна незаданной. */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface ProviderSelection {
  provider: Provider;
  model: string;
  descriptor: ProviderDescriptor;
}

/**
 * Реестр провайдеров.
 *
 * Клиенты кэшируются по (id + ключ + адрес): пересоздавать клиента на каждый
 * запрос — значит терять пул соединений, а на Anthropic ещё и мешать серверу
 * держать кэш промпта тёплым.
 */
export class ProviderRegistry {
  private readonly cache = new Map<string, { fingerprint: string; provider: Provider }>();
  /**
   * Провайдеры от плагинов. Отдельной картой, а не подмешиванием в PROVIDERS:
   * встроенный список — константа, и он не должен зависеть от того, какие
   * плагины успели подняться к моменту чтения.
   */
  private readonly external = new Map<
    string,
    { descriptor: ProviderDescriptor; provider: Provider }
  >();

  constructor(
    private readonly settings: SettingsRepo,
    private readonly secrets: SecretStore,
  ) {}

  list(): readonly ProviderDescriptor[] {
    return [...PROVIDERS, ...[...this.external.values()].map((e) => e.descriptor)];
  }

  /**
   * Описания для интерфейса: то же самое плюс готовность и происхождение.
   *
   * Собирается здесь, а не в демоне, потому что «настроен ли провайдер» знает
   * только реестр — у встроенных это наличие ключа, у пришедших от плагина
   * ключами распоряжается сам плагин.
   */
  async describe(): Promise<ProviderInfo[]> {
    const described: ProviderInfo[] = [];

    for (const descriptor of this.list()) {
      const external = this.external.get(descriptor.id);
      described.push({
        id: descriptor.id,
        title: descriptor.title,
        requiresKey: descriptor.requiresKey,
        secretKey: descriptor.secretKey,
        defaultModel: descriptor.defaultModel,
        ...(descriptor.defaultBaseUrl ? { defaultBaseUrl: descriptor.defaultBaseUrl } : {}),
        supportsPromptCache: descriptor.supportsPromptCache,
        ...(descriptor.keyUrl ? { keyUrl: descriptor.keyUrl } : {}),
        configured: this.isConfigured(descriptor.id),
        source: external ? `plugin:${descriptor.id.split(':')[0]}` : 'builtin',
        // Список моделей спрашиваем только у плагинов: у встроенных это
        // сетевой запрос, которому не место в отрисовке настроек.
        models: external ? await safeModels(external.provider) : [],
      });
    }

    return described;
  }

  descriptor(id: string): ProviderDescriptor | null {
    return (
      PROVIDERS.find((p) => p.id === id) ?? this.external.get(id)?.descriptor ?? null
    );
  }

  /** Добавить провайдера от плагина. Ключами и настройками владеет плагин. */
  registerExternal(descriptor: ProviderDescriptor, provider: Provider): void {
    this.external.set(descriptor.id, { descriptor, provider });
  }

  unregisterExternal(id: string): void {
    this.external.delete(id);
    this.cache.delete(id);
  }

  /** Готов ли провайдер к работе: есть ключ, если он требуется. */
  isConfigured(id: string): boolean {
    const descriptor = this.descriptor(id);
    if (!descriptor) return false;
    if (this.external.has(id)) return true;
    return !descriptor.requiresKey || this.secrets.has(descriptor.secretKey);
  }

  /** Текущий провайдер и модель по настройкам ядра. */
  current(): ProviderSelection {
    const id = nonEmpty(this.settings.get<string>('provider.active')) ?? 'anthropic';
    const model = nonEmpty(this.settings.get<string>(`provider.${id}.model`));
    return this.resolve(id, model);
  }

  /**
   * Модель, назначенная распознавать картинки. `null` — не назначена, и тогда
   * вложения уходят в основную модель как есть.
   */
  vision(): ProviderSelection | null {
    const id = nonEmpty(this.settings.get<string>(VISION_PROVIDER_SETTING));
    const model = nonEmpty(this.settings.get<string>(VISION_MODEL_SETTING));
    if (!id || !model) return null;

    try {
      return this.resolve(id, model);
    } catch {
      // Провайдер распознавания не настроен или исчез. Ронять из-за этого
      // весь прогон нельзя — картинка просто останется неописанной.
      return null;
    }
  }

  /** Модель для проверки повода. `null` — не назначена, сойдёт основная. */
  impulse(): ProviderSelection | null {
    const id = nonEmpty(this.settings.get<string>(IMPULSE_PROVIDER_SETTING));
    const model = nonEmpty(this.settings.get<string>(IMPULSE_MODEL_SETTING));
    if (!id || !model) return null;

    try {
      return this.resolve(id, model);
    } catch {
      return null;
    }
  }

  /** Модель для векторов. `null` — не назначена или не умеет эмбеддинги. */
  embedding(): ProviderSelection | null {
    const id = nonEmpty(this.settings.get<string>(EMBEDDING_PROVIDER_SETTING));
    const model = nonEmpty(this.settings.get<string>(EMBEDDING_MODEL_SETTING));
    if (!id || !model) return null;

    try {
      const selection = this.resolve(id, model);
      /**
       * Провайдер без эмбеддингов — то же самое, что ненастроенный.
       *
       * У Anthropic их нет вовсе. Молча делать вид, что поиск работает, хуже
       * чем честно его не иметь: человек назначит модель и будет ждать
       * результатов, которых не появится.
       */
      return selection.provider.embed ? selection : null;
    } catch {
      return null;
    }
  }

  resolve(id: string, model?: string): ProviderSelection {
    const descriptor = this.descriptor(id);
    if (!descriptor) {
      throw new ProviderError('model_not_found', `Неизвестный провайдер: ${id}`, { provider: id });
    }

    // У плагина уже есть готовый клиент: ни ключа, ни адреса ядро для него не
    // хранит — это его дело, и лезть в него мы не вправе.
    const external = this.external.get(id);
    if (external) {
      return {
        provider: external.provider,
        model: nonEmpty(model) ?? descriptor.defaultModel,
        descriptor,
      };
    }

    const apiKey = this.secrets.reveal(descriptor.secretKey) ?? '';
    if (descriptor.requiresKey && !apiKey) {
      throw new ProviderError('auth', `Не задан API-ключ для ${descriptor.title}`, {
        provider: id,
      });
    }

    const baseUrl =
      nonEmpty(this.settings.get<string>(`provider.${id}.baseUrl`)) ?? descriptor.defaultBaseUrl;
    const fingerprint = `${apiKey}|${baseUrl ?? ''}`;
    // Пустая строка — это «не задано», а не «модель без имени». Настройка,
    // очищенная в интерфейсе, приходит именно пустой строкой, и `??` её
    // пропускает: запрос уходил в API с пустым `model` и умирал молча.
    const resolvedModel = nonEmpty(model) ?? descriptor.defaultModel;

    const cached = this.cache.get(id);
    if (cached?.fingerprint === fingerprint) {
      return { provider: cached.provider, model: resolvedModel, descriptor };
    }

    const provider = this.build(descriptor, apiKey, baseUrl);
    this.cache.set(id, { fingerprint, provider });
    return { provider, model: resolvedModel, descriptor };
  }

  /** Сбросить кэшированных клиентов — после смены ключа или адреса. */
  invalidate(id?: string): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  private build(
    descriptor: ProviderDescriptor,
    apiKey: string,
    baseUrl: string | undefined,
  ): Provider {
    if (descriptor.id === 'anthropic') {
      return new AnthropicProvider({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    }
    return new OpenAICompatibleProvider({
      id: descriptor.id,
      baseUrl: baseUrl ?? '',
      ...(apiKey ? { apiKey } : {}),
      supportsPromptCache: descriptor.supportsPromptCache,
      ...(descriptor.id === 'openrouter'
        ? {
            extraHeaders: {
              'HTTP-Referer': 'https://axon.local',
              'X-Title': 'Axon',
            },
          }
        : {}),
    });
  }
}
