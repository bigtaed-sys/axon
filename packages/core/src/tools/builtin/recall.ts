import { z } from 'zod';
import type { Store } from '../../storage/Store.js';
import type { SearchHit } from '../../storage/SearchIndex.js';
import type { EmbeddingIndex } from '../../memory/EmbeddingIndex.js';
import { fuse } from '../../memory/vectors.js';
import { defineTool, type ToolDefinition } from '../types.js';

/**
 * Поиск по собственной переписке.
 *
 * До этого инструмента агент помнил ровно то, что успел записать фактом или
 * наблюдением, плюс окно текущего разговора. Всё остальное для него не
 * существовало: разговор трёхнедельной давности он не мог вспомнить физически,
 * стоя рядом с полнотекстовым индексом, где этот разговор лежит. Индекс
 * строился, догонялся при старте и использовался только поиском в приложении.
 *
 * Это и есть разница между «помню, что записал» и «помню, что было».
 */

/** Сколько попаданий показывать. Больше модели не нужно, а платить за них ей. */
const LIMIT = 8;

/** Сколько сообщений вокруг найденного отдавать при чтении куска разговора. */
const AROUND = 6;

export function createRecallTools(store: Store, embeddings?: EmbeddingIndex): ToolDefinition[] {
  const search = defineTool({
    name: 'search_history',
    title: 'Искать по переписке',
    description:
      'Найти, что говорили раньше, во всех прошлых разговорах. Вызывай, когда ' +
      'человек ссылается на сказанное — «мы это обсуждали», «как ты тогда ' +
      'предлагал», «чем кончилось с…» — и когда ответ зависит от того, о чём ' +
      'уже договорились. Ищет по словам, а не по смыслу: задавай слова, которые ' +
      'человек скорее всего произносил. Если назначена модель поиска, ищет ещё ' +
      'и по смыслу — тогда находится и то, что сказано другими словами. Лучше ' +
      'несколько коротких запросов подряд, чем один длинный.',
    tier: 'safe',
    source: 'builtin',
    schema: z.object({
      query: z
        .string()
        .min(2)
        .max(200)
        .describe('Слова для поиска. Одно-три ключевых слова работают лучше фразы'),
    }),
    async execute({ query }) {
      const hits = await find(store, embeddings, query);
      if (hits.length === 0) {
        return { text: `По запросу «${query}» в переписке ничего не нашлось` };
      }

      /**
       * Отдаём id разговора вместе с куском текста.
       *
       * Без него найденное повисает в воздухе: модель видит фразу, но не может
       * ни прочитать вокруг неё, ни сказать человеку, где это было.
       */
      const lines = hits.map((hit) => {
        const when = new Date(hit.createdAt).toLocaleDateString('ru-RU');
        const who = hit.role === 'user' ? 'человек' : 'ты';
        const title = store.conversations.get(hit.conversationId)?.title ?? 'разговор';
        return `[${when}, ${who}, «${title}» · ${hit.conversationId}]\n${hit.snippet}`;
      });

      return {
        text:
          `Нашлось ${hits.length}:\n\n${lines.join('\n\n')}\n\n` +
          'Чтобы прочитать вокруг найденного, вызови read_history с id разговора.',
      };
    },
  });

  const read = defineTool({
    name: 'read_history',
    title: 'Прочитать кусок разговора',
    description:
      'Показать несколько сообщений подряд из прошлого разговора. Вызывай после ' +
      'search_history, когда найденного отрывка мало, чтобы понять, о чём шла ' +
      'речь и чем закончилось.',
    tier: 'safe',
    source: 'builtin',
    // Нужен редко и только после поиска: схему в контекст заранее не грузим.
    deferred: true,
    schema: z.object({
      conversationId: z.string().min(1).describe('Id разговора из результатов search_history'),
      around: z
        .string()
        .optional()
        .describe('Id сообщения, вокруг которого читать. Пусто — конец разговора'),
    }),
    async execute({ conversationId, around }) {
      const conversation = store.conversations.get(conversationId);
      if (!conversation) return { text: 'Такого разговора нет' };

      const messages = around
        ? neighbours(store, conversationId, around)
        : store.messages.recent(conversationId, AROUND * 2);

      if (messages.length === 0) return { text: 'В этом разговоре ничего нет' };

      const lines = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => {
          const who = message.role === 'user' ? 'Человек' : 'Ты';
          const text = message.parts
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
          return text ? `${who}: ${text}` : '';
        })
        .filter(Boolean);

      return { text: `«${conversation.title}»\n\n${lines.join('\n\n')}` };
    },
  });

  const list = defineTool({
    name: 'list_conversations',
    title: 'Список разговоров',
    description:
      'Показать, какие разговоры были и о чём. Вызывай, когда человек ' +
      'спрашивает про прошлое общо — «чем мы занимались на той неделе», «какие ' +
      'у нас были темы» — то есть когда искать нечего по словам, а нужно ' +
      'сориентироваться. Для поиска конкретной фразы есть search_history.',
    tier: 'safe',
    source: 'builtin',
    deferred: true,
    schema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(40)
        .default(15)
        .describe('Сколько последних разговоров показать'),
    }),
    async execute({ limit }) {
      const conversations = store.conversations.list(limit, true);
      if (conversations.length === 0) return { text: 'Разговоров ещё не было' };

      const lines = conversations.map((conversation) => {
        const when = new Date(conversation.updatedAt).toLocaleDateString('ru-RU');
        /**
         * Сводка есть не у всех: она появляется, когда разговор перерос окно
         * контекста. У коротких её нет и не будет — там название и есть весь
         * след, и это честно.
         */
        const summary = store.summaries.latest(conversation.id)?.text;
        const tail = summary ? `\n  ${summary.slice(0, 300)}` : '';
        const archived = conversation.archived ? ', в архиве' : '';

        return `[${when}${archived}] «${conversation.title}» · ${conversation.id}${tail}`;
      });

      return { text: lines.join('\n\n') };
    },
  });

  return [search, read, list];
}

/**
 * Гибридный поиск: слова и смысл.
 *
 * Полнотекстовый идеален там, где важно точное совпадение — имя, код ошибки,
 * название файла. Семантический находит сказанное другими словами. Порознь
 * каждый регулярно промахивается, поэтому спрашиваем оба и сводим по рангам:
 * то, что оба поставили высоко, почти наверняка и есть нужное.
 *
 * Оценки при этом не смешиваются — они несравнимы. Вес BM25 и косинусная
 * близость живут в разных единицах, и любая попытка привести их друг к другу
 * была бы подгонкой коэффициентов под пару удачных примеров.
 */
async function find(
  store: Store,
  embeddings: EmbeddingIndex | undefined,
  query: string,
): Promise<SearchHit[]> {
  const byWords = store.search.search(query, LIMIT * 2);

  // Семантики нет — работаем как раньше. Это законное состояние: модель
  // назначают по желанию, и без неё поиск не хуже, чем был вчера.
  if (!embeddings?.enabled) return byWords.slice(0, LIMIT);

  const byMeaning = await embeddings.search(query, LIMIT * 2);
  if (byMeaning.length === 0) return byWords.slice(0, LIMIT);

  const order = fuse(
    [byWords.map((hit) => hit.messageId), byMeaning.map((hit) => hit.messageId)],
    LIMIT,
  );

  const known = new Map(byWords.map((hit) => [hit.messageId, hit]));

  return order
    .map((id) => known.get(id) ?? hitOf(store, id))
    .filter((hit): hit is SearchHit => hit !== null);
}

/**
 * Собрать попадание для того, что нашлось только по смыслу.
 *
 * У полнотекстового есть готовый отрывок с подсветкой, у семантического —
 * только идентификатор: он сравнивал векторы, а не текст, и подсвечивать ему
 * нечего. Берём начало сообщения — этого хватает, чтобы понять, о чём речь.
 */
function hitOf(store: Store, messageId: string): SearchHit | null {
  const message = store.messages.get(messageId);
  if (!message) return null;

  const text = message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .trim();

  return {
    messageId: message.id,
    conversationId: message.conversationId,
    role: message.role,
    createdAt: message.createdAt,
    snippet: text.length > 300 ? `${text.slice(0, 300)}…` : text,
  };
}

/**
 * Сообщения вокруг найденного.
 *
 * Нужны именно соседи, а не хвост разговора: попадание могло случиться в его
 * середине, и хвост показал бы совсем другое место.
 */
function neighbours(store: Store, conversationId: string, messageId: string) {
  const ord = store.messages.ordOf(messageId);
  if (ord === null) return store.messages.recent(conversationId, AROUND * 2);

  const before = store.messages.page(conversationId, messageId, AROUND);
  const after = store.messages.after(conversationId, ord - 1).slice(0, AROUND + 1);

  return [...before, ...after];
}
