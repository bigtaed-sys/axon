import type { Message } from '@axon/protocol';
import { logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { Store } from '../storage/Store.js';
import { pack, similarity, unpack } from './vectors.js';

/**
 * Семантический поиск: векторы переписки и поиск по смыслу.
 *
 * Полнотекстовый находит слово, семантический — мысль. «Переезд» не найдётся
 * по запросу «сменил квартиру», сколько ни улучшай стемминг: там просто нет
 * общих слов. Векторы это чинят, но взамен теряют то, что полнотекстовый делает
 * идеально, — точное совпадение имени, кода ошибки, названия файла.
 *
 * Поэтому здесь только половина поиска. Вторая — в `SearchIndex`, а сводит их
 * `fuse` по рангам.
 *
 * ## Три решения, на которых всё держится
 *
 * **Работает только по желанию.** Нет назначенной модели — нет векторов, и
 * поиск остаётся полнотекстовым. Эмбеддинги стоят денег или требуют локальной
 * модели, и включать это за человека нельзя.
 *
 * **Считается фоном и порциями.** Переписка за месяцы — это тысячи запросов к
 * провайдеру; делать их разом при старте значит подвесить ядро и получить счёт.
 * Индекс догоняет по чуть-чуть и запоминает, где остановился.
 *
 * **Модель хранится рядом с вектором.** Векторы разных моделей несравнимы, и
 * при смене модели старые просто перестают учитываться — вместо того чтобы
 * молча портить выдачу.
 */

/** Докуда досчитано. Хранится настройкой, как и водяная метка поиска. */
export const EMBEDDED_UP_TO_SETTING = 'search.embeddedUpTo';

/** Какой моделью считали в прошлый раз. Сменилась — считаем заново. */
export const EMBEDDED_MODEL_SETTING = 'search.embeddedModel';

/** Сколько сообщений отдавать провайдеру за раз. */
const BATCH = 32;

/** Сколько текста от сообщения брать. Длинный хвост размывает смысл вектора. */
const MAX_CHARS = 2_000;

/** Пауза между порциями: догон не должен мешать разговору. */
const BREATH_MS = 200;

/** Ниже этой близости совпадение случайно — их отбрасываем. */
const MIN_SIMILARITY = 0.25;

export interface EmbeddingDeps {
  store: Store;
  providers: ProviderRegistry;
}

export interface SemanticHit {
  messageId: string;
  conversationId: string;
  score: number;
}

export class EmbeddingIndex {
  private working = false;
  private stopped = false;

  constructor(private readonly deps: EmbeddingDeps) {}

  /** Назначена ли модель. От этого зависит, есть ли семантика вообще. */
  get enabled(): boolean {
    return this.deps.providers.embedding() !== null;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Досчитать векторы для новых сообщений.
   *
   * Возвращает, сколько посчитано. Вызывается при старте и после каждого
   * ответа агента — то есть догон идёт сам собой, без отдельного расписания.
   */
  async catchUp(): Promise<number> {
    const selection = this.deps.providers.embedding();
    if (!selection || this.working || this.stopped) return 0;

    this.working = true;
    let done = 0;

    try {
      const model = `${selection.provider.id}:${selection.model}`;
      this.resetIfModelChanged(model);

      for (;;) {
        if (this.stopped) break;

        const batch = this.pending(model, BATCH);
        if (batch.length === 0) break;

        const texts = batch.map((message) => textOf(message).slice(0, MAX_CHARS));
        const vectors = await selection.provider.embed!({ model: selection.model, texts });

        this.deps.store.transact(() => {
          batch.forEach((message, index) => {
            const vector = vectors[index];
            if (!vector) return;
            this.deps.store.embeddings.put(message.id, model, vector);
          });
        });

        done += batch.length;
        // Водяная метка двигается по последнему обработанному: упавший на
        // середине догон продолжится оттуда же, а не с начала переписки.
        this.mark(batch[batch.length - 1]!.id);

        await sleep(BREATH_MS);
      }
    } catch (error) {
      /**
       * Догон — вспомогательная работа, и ронять из-за неё ничего нельзя.
       *
       * Кончились деньги, отвалилась сеть, локальная модель не поднялась —
       * поиск остаётся полнотекстовым, а не ломается целиком.
       */
      logger.warn({ err: (error as Error).message }, 'векторы досчитать не удалось');
    } finally {
      this.working = false;
    }

    if (done > 0) logger.info({ done }, 'векторы досчитаны');
    return done;
  }

  /**
   * Найти по смыслу.
   *
   * Перебором всех векторов, без приближённого индекса. Для личной переписки
   * это правильный выбор: тысячи векторов по несколько сотен чисел — это
   * миллионы умножений, то есть единицы миллисекунд, а любой ANN-индекс здесь
   * добавил бы структуру, которую надо строить, хранить и перестраивать, ради
   * выигрыша, которого не заметить.
   */
  async search(query: string, limit: number): Promise<SemanticHit[]> {
    const selection = this.deps.providers.embedding();
    if (!selection || !query.trim()) return [];

    const model = `${selection.provider.id}:${selection.model}`;

    let asked: number[] | undefined;
    try {
      [asked] = await selection.provider.embed!({ model: selection.model, texts: [query] });
    } catch (error) {
      logger.warn({ err: (error as Error).message }, 'вектор запроса не посчитался');
      return [];
    }
    if (!asked) return [];

    const target = Float32Array.from(asked);
    const hits: SemanticHit[] = [];

    for (const row of this.deps.store.embeddings.all(model)) {
      const score = similarity(target, unpack(row.vector));
      if (score >= MIN_SIMILARITY) {
        hits.push({ messageId: row.messageId, conversationId: row.conversationId, score });
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ─── Внутреннее ───────────────────────────────────────────────────────────

  /**
   * Сменилась модель — начинаем счёт сначала.
   *
   * Водяная метка помнит, до какого места дошли, но не тем ли инструментом.
   * Без этой проверки смена модели оставляла бы индекс в тихом полураспаде:
   * старые векторы новой моделью не ищутся, а новых не считается, потому что
   * метка стоит в конце переписки. Поиск при этом не ломается и не жалуется —
   * он просто перестаёт находить, и понять почему неоткуда.
   */
  private resetIfModelChanged(model: string): void {
    const previous = this.deps.store.settings.get<string>(EMBEDDED_MODEL_SETTING);
    if (previous === model) return;

    const now = new Date().toISOString();
    this.deps.store.settings.set(EMBEDDED_UP_TO_SETTING, 0, now);
    this.deps.store.settings.set(EMBEDDED_MODEL_SETTING, model, now);

    if (previous) logger.info({ previous, model }, 'модель поиска сменилась — считаем заново');
  }

  /** Сообщения, для которых вектора этой модели ещё нет. */
  private pending(model: string, limit: number): Message[] {
    const from = this.deps.store.settings.get<number>(EMBEDDED_UP_TO_SETTING) ?? 0;
    return this.deps.store.embeddings.pending(model, from, limit);
  }

  private mark(messageId: string): void {
    const ord = this.deps.store.messages.ordOf(messageId);
    if (ord === null) return;
    this.deps.store.settings.set(EMBEDDED_UP_TO_SETTING, ord, new Date().toISOString());
  }
}

/** Что от сообщения имеет смысл превращать в вектор. */
function textOf(message: Message): string {
  return message.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
