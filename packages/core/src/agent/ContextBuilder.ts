import type { ContentPart, DevicePlatform, Message } from '@axon/protocol';
import type { ProviderMessage, ProviderPart } from '../providers/types.js';
import type { Store } from '../storage/Store.js';
import { selectFacts } from '../memory/Facts.js';
import { selectForPrompt } from '../memory/Observations.js';
import { composePersona } from './Persona.js';
import { estimateTokens } from './tokens.js';

/**
 * Поставщик контекста — способ подсистемы добавить что-то в промпт, не будучи
 * известной сборщику.
 *
 * В старом проекте ContextBuilder знал про умный дом и базу знаний напрямую:
 * прямо в его теле лежал захардкоженный абзац со списком tool-имён для HA.
 * Фичи лезли в ядро, и каждая новая означала правку ядра. Здесь наоборот:
 * подсистема регистрирует вклад, ядро про неё ничего не знает.
 *
 * `stability` — не украшение, а место в промпте:
 *
 * - `stable` уходит в системный блок, то есть в кэшируемый префикс;
 * - `volatile` дописывается в самый конец, после всей истории.
 *
 * Перепутать их дорого: одна «текущая дата», положенная в стабильную часть,
 * убивает кэш промпта на каждом ходу, и никто этого не замечает.
 */
export interface ContextContributor {
  name: string;
  stability: 'stable' | 'volatile';
  contribute(input: ContributeInput): Promise<string | null> | string | null;
}

export interface ContributeInput {
  conversationId: string;
  /** Текст последнего сообщения пользователя — для поиска по релевантности. */
  userText: string;
  /**
   * Откуда задан вопрос.
   *
   * Это свойство прогона, а не разговора: один и тот же разговор ведут и с
   * десктопа, и с телефона попеременно. Поэтому всё, что от него зависит,
   * обязано быть изменчивым вкладом — положи его в системный блок, и кэш
   * промпта будет обнуляться при каждом переходе между окнами.
   */
  platform?: DevicePlatform;
}

/** Чем разрешать ссылки на блобы в байты. Без него картинки в модель не поедут. */
export interface BlobReader {
  read(blobId: string): Promise<{ base64: string; mime: string } | null>;
}

export interface ContextBuilderOptions {
  /** Сколько последних сообщений брать, если сводки ещё нет. */
  maxHistoryMessages?: number;
  blobs?: BlobReader;
}

export interface BuiltContext {
  messages: ProviderMessage[];
  /** Оценка размера промпта — для решений, не для отчётности. */
  estimatedTokens: number;
}

const DEFAULT_MAX_HISTORY = 40;

export class ContextBuilder {
  private readonly contributors: ContextContributor[] = [];

  constructor(
    private readonly store: Store,
    private readonly options: ContextBuilderOptions = {},
  ) {}

  addContributor(contributor: ContextContributor): void {
    this.contributors.push(contributor);
  }

  removeContributor(name: string): void {
    const index = this.contributors.findIndex((c) => c.name === name);
    if (index >= 0) this.contributors.splice(index, 1);
  }

  async build(input: {
    conversationId: string;
    userText: string;
    /**
     * Принимает ли модель картинки. `false` — вложения уедут описанием.
     * Умолчание разрешающее: старые вызовы вели себя именно так.
     */
    allowImages?: boolean;
    platform?: DevicePlatform;
  }): Promise<BuiltContext> {
    const messages: ProviderMessage[] = [];
    const allowImages = input.allowImages ?? true;

    const system = await this.buildSystem(input);
    if (system) messages.push({ role: 'system', parts: [{ type: 'text', text: system }] });

    for (const message of this.history(input.conversationId)) {
      messages.push(await this.toProviderMessage(message, allowImages));
    }

    await this.appendVolatile(messages, input);

    return { messages, estimatedTokens: estimate(messages) };
  }

  /**
   * Системный блок = стабильный префикс. Порядок внутри тоже стабильный:
   * промпт → факты → сводка → вклады подсистем. Перестановка секций между
   * ходами обнулила бы кэш ровно так же, как изменение их содержимого.
   */
  private async buildSystem(input: ContributeInput): Promise<string> {
    const parts: string[] = [];

    const persona = composePersona(this.store.settings.all());
    if (persona) parts.push(persona);

    /**
     * Факты отбираются, а не вываливаются целиком.
     *
     * Сказанное человеком идёт всегда; выведенное агентом — по совпадению слов
     * с вопросом. Подробности отбора и почему он такой грубый — в `selectFacts`.
     */
    const facts = selectFacts(this.store.facts.list(), input.userText);
    if (facts.length > 0) {
      parts.push(
        `Что известно о пользователе:\n${facts.map((f) => `- ${f.key}: ${f.value}`).join('\n')}`,
      );
    }

    /**
     * Наблюдения идут после фактов и отдельным блоком.
     *
     * Слить их в один список заманчиво — это ведь всё «память», — но модель
     * должна относиться к ним по-разному. Факт проверен: часовой пояс такой и
     * есть. Наблюдение — это догадка о человеке, и она может устареть или
     * оказаться неверной. Смешав их, получаешь агента, который спорит с
     * человеком о его собственном настроении, ссылаясь на прошлый вторник.
     */
    const observations = selectForPrompt(this.store.observations.list());
    if (observations.length > 0) {
      const lines = observations.map((o) => `- ${o.text}`).join('\n');
      parts.push(
        'Что ты заметил за время общения. Это твои наблюдения, а не проверенные ' +
          'факты: опирайся на них, но не спорь с человеком, ссылаясь на них.\n' +
          lines,
      );
    }

    const summary = this.store.summaries.latest(input.conversationId);
    if (summary) {
      parts.push(`Краткое содержание предыдущей части разговора:\n${summary.text}`);
    }

    for (const contributor of this.contributors) {
      if (contributor.stability !== 'stable') continue;
      const text = await contributor.contribute(input);
      if (text) parts.push(text);
    }

    return parts.join('\n\n');
  }

  /**
   * Изменчивые вклады по отдельности — для отчёта о том, из чего собран
   * контекст. Собирать их там заново значило бы дублировать перебор
   * поставщиков и однажды разойтись с тем, что уходит в модель.
   */
  async volatileParts(input: ContributeInput): Promise<Array<{ name: string; text: string }>> {
    const parts: Array<{ name: string; text: string }> = [];
    for (const contributor of this.contributors) {
      if (contributor.stability !== 'volatile') continue;
      const text = await contributor.contribute(input);
      if (text) parts.push({ name: contributor.name, text });
    }
    return parts;
  }

  /**
   * Изменчивые вклады дописываются последним блоком последнего сообщения
   * пользователя — то есть за точкой кэширования. Всё, что перед ними,
   * переиспользуется из кэша.
   */
  private async appendVolatile(
    messages: ProviderMessage[],
    input: ContributeInput,
  ): Promise<void> {
    const parts = await this.volatileParts(input);
    const blocks = parts.map((part) => part.text);
    if (blocks.length === 0) return;

    const target = messages.at(-1);
    const text = blocks.join('\n\n');
    if (target && target.role === 'user') {
      target.parts.push({ type: 'text', text });
    } else {
      messages.push({ role: 'user', parts: [{ type: 'text', text }] });
    }
  }

  /**
   * История после последней сводки. Если сводки нет — последние N сообщений:
   * порядок задаёт `ord`, а не время создания, поэтому результаты инструментов,
   * записанные в одну миллисекунду, не перемешиваются.
   */
  private history(conversationId: string): Message[] {
    const summary = this.store.summaries.latest(conversationId);
    if (summary) return this.store.messages.after(conversationId, summary.upToOrd);

    return this.store.messages.recent(
      conversationId,
      this.options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY,
    );
  }

  private async toProviderMessage(
    message: Message,
    allowImages: boolean,
  ): Promise<ProviderMessage> {
    const parts: ProviderPart[] = [];
    for (const part of message.parts) {
      parts.push(await this.toProviderPart(part, allowImages));
    }

    return {
      role: message.role,
      parts,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    };
  }

  private async toProviderPart(part: ContentPart, allowImages: boolean): Promise<ProviderPart> {
    if (part.type === 'text') return { type: 'text', text: part.text };

    /**
     * Картинку уже описала отдельная модель, и описание лежит в истории
     * текстом. Отправлять сюда ещё и байты значит заплатить дважды за одно и
     * то же — а модель, которая картинок не принимает, ответила бы на них
     * отказом всего запроса.
     */
    if (part.mime.startsWith('image/') && !allowImages) {
      return { type: 'text', text: `[изображение ${part.name ?? part.blobId}]` };
    }

    const blob = this.options.blobs ? await this.options.blobs.read(part.blobId) : null;
    if (blob && blob.mime.startsWith('image/')) {
      return { type: 'image', mime: blob.mime, base64: blob.base64 };
    }
    // Не картинка или блоб недоступен — отдаём модели описание вместо байтов.
    return { type: 'text', text: `[файл ${part.name ?? part.blobId}, ${part.mime}]` };
  }
}

function estimate(messages: ProviderMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      // Картинка в среднем около полутора тысяч токенов; точнее тут не нужно.
      total += part.type === 'text' ? estimateTokens(part.text) : 1_500;
    }
    for (const call of message.toolCalls ?? []) {
      total += estimateTokens(JSON.stringify(call.arguments)) + 10;
    }
  }
  return total;
}
