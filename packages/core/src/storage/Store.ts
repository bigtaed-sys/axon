import { randomUUID } from 'node:crypto';
import type {
  ContentPart,
  Conversation,
  Device,
  DevicePlatform,
  Fact,
  JournalEntry,
  JournalEvent,
  Message,
  Observation,
  Role,
  Scope,
  Seq,
  ToolCall,
  Usage,
} from '@axon/protocol';
import type { Db } from './db.js';
import { Journal } from './Journal.js';
import { SearchIndex } from './SearchIndex.js';
import { SecretStore } from './SecretStore.js';
import { evictionCandidates, reinforcedWeight } from '../memory/Observations.js';
import {
  ConversationsRepo,
  DevicesRepo,
  FactsRepo,
  EmbeddingsRepo,
  MessagesRepo,
  normalizeObservation,
  ObservationsRepo,
  PermissionRulesRepo,
  PluginsRepo,
  RoutinesRepo,
  SettingsRepo,
  SummariesRepo,
  UsageRepo,
} from './repos.js';

export interface StoreOptions {
  db: Db;
  secretKeyPath: string;
}

/**
 * Store — единственный способ изменить состояние ядра.
 *
 * Он держит один инвариант, ради которого всё и построено: запись в журнал и
 * изменение производных таблиц происходят в одной транзакции, а подписчики
 * узнают о событии только после коммита. Нарушь это — и клиент однажды получит
 * событие о сообщении, которого в БД нет, сдвинет курсор и разойдётся с ядром
 * навсегда.
 */
export class Store {
  readonly journal: Journal;
  readonly conversations: ConversationsRepo;
  readonly messages: MessagesRepo;
  readonly summaries: SummariesRepo;
  readonly facts: FactsRepo;
  readonly observations: ObservationsRepo;
  readonly embeddings: EmbeddingsRepo;
  readonly devices: DevicesRepo;
  readonly settings: SettingsRepo;
  readonly usage: UsageRepo;
  readonly permissionRules: PermissionRulesRepo;
  readonly plugins: PluginsRepo;
  readonly routines: RoutinesRepo;
  readonly search: SearchIndex;
  readonly secrets: SecretStore;

  private readonly db: Db;
  /** Записи текущей транзакции — рассылаются только после успешного коммита. */
  private pending: JournalEntry[] = [];
  private depth = 0;

  constructor({ db, secretKeyPath }: StoreOptions) {
    this.db = db;
    this.journal = new Journal(db);
    this.conversations = new ConversationsRepo(db);
    this.messages = new MessagesRepo(db);
    this.summaries = new SummariesRepo(db);
    this.facts = new FactsRepo(db);
    this.observations = new ObservationsRepo(db);
    this.embeddings = new EmbeddingsRepo(db);
    this.devices = new DevicesRepo(db);
    this.settings = new SettingsRepo(db);
    this.usage = new UsageRepo(db);
    this.permissionRules = new PermissionRulesRepo(db);
    this.plugins = new PluginsRepo(db);
    this.routines = new RoutinesRepo(db);
    this.search = new SearchIndex(db);
    this.secrets = new SecretStore(db, secretKeyPath);
  }

  // ─── Транзакции ───────────────────────────────────────────────────────────

  /**
   * Выполнить изменения атомарно и разослать накопленные события после
   * коммита. Вложенные вызовы разрешены: better-sqlite3 разворачивает их в
   * savepoint'ы, а рассылка происходит один раз — на выходе из внешней.
   *
   * Через этот метод идут все доменные операции, поэтому «записал, но никому
   * не сказал» здесь невозможно по построению.
   */
  transact<T>(fn: () => T): T {
    if (this.depth > 0) return fn();

    this.depth++;
    let committed: JournalEntry[] = [];
    try {
      const result = this.db.runInTransaction(fn);
      // Присваивание только на успешном пути: при откате рассылать нечего.
      committed = this.pending;
      return result;
    } finally {
      this.pending = [];
      this.depth--;
      if (committed.length > 0) {
        this.journal.emit(committed);
      }
    }
  }

  /** Записать событие в журнал. Только внутри `transact`. */
  record(event: JournalEvent, at: string = new Date().toISOString()): JournalEntry {
    if (this.depth === 0) {
      throw new Error('Store.record вызван вне транзакции — используй Store.transact');
    }
    const entry = this.journal.append(event, at);
    this.pending.push(entry);
    return entry;
  }

  // ─── Разговоры ────────────────────────────────────────────────────────────

  createConversation(title = 'Новый разговор'): Conversation {
    return this.transact(() => {
      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: randomUUID(),
        title,
        createdAt: now,
        updatedAt: now,
        archived: false,
        totalTokens: 0,
      };
      this.conversations.insert(conversation);
      this.record({ type: 'conversation.created', conversation }, now);
      return conversation;
    });
  }

  renameConversation(id: string, title: string): void {
    this.transact(() => {
      const now = new Date().toISOString();
      this.conversations.rename(id, title, now);
      this.record({ type: 'conversation.renamed', id, title }, now);
    });
  }

  archiveConversation(id: string, archived: boolean): void {
    this.transact(() => {
      const now = new Date().toISOString();
      this.conversations.setArchived(id, archived, now);
      this.record({ type: 'conversation.archived', id, archived }, now);
    });
  }

  deleteConversation(id: string): void {
    this.transact(() => {
      this.conversations.delete(id);
      this.search.removeConversation(id);
      this.record({ type: 'conversation.deleted', id });
    });
  }

  // ─── Сообщения ────────────────────────────────────────────────────────────

  appendMessage(input: {
    conversationId: string;
    role: Role;
    parts: ContentPart[];
    toolCalls?: ToolCall[];
    toolCallId?: string;
    usage?: Usage;
  }): Message {
    return this.transact(() => {
      const now = new Date().toISOString();
      const message: Message = {
        id: randomUUID(),
        conversationId: input.conversationId,
        role: input.role,
        parts: input.parts,
        ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
        ...(input.usage ? { usage: input.usage } : {}),
        createdAt: now,
      };

      // Позиция сообщения = seq события о его создании. Один монотонный
      // источник порядка вместо времени, которое у tool-результатов
      // совпадает до миллисекунды.
      const entry = this.record({ type: 'message.created', message }, now);
      this.messages.insert(message, entry.seq);
      // Индекс поиска обновляется в той же транзакции: иначе он расходится с
      // перепиской ровно в тот момент, когда что-то падает между записями.
      this.search.add(message, entry.seq);
      this.conversations.touch(
        input.conversationId,
        now,
        input.usage ? input.usage.inputTokens + input.usage.outputTokens : 0,
      );
      return message;
    });
  }

  amendMessage(message: Message): void {
    this.transact(() => {
      this.messages.update(message);
      // Позицию не двигаем — правка не сдвигает сообщение в истории, поэтому
      // и водяная метка индекса остаётся прежней.
      this.search.add(message, 0);
      this.record({ type: 'message.amended', message });
    });
  }

  /**
   * Убрать сообщение и всё, что было после него.
   *
   * Нужно для правки и перезапроса: изменённый вопрос делает недействительным
   * не только ответ на него, но и всю ветку, выросшую дальше. Оставить её
   * значило бы показать человеку разговор, которого не было, — с ответами на
   * вопрос, который он только что переписал.
   *
   * Удаление мягкое, как и обычное: строки остаются в базе, из истории и
   * поиска исчезают.
   */
  truncateFrom(conversationId: string, messageId: string): number {
    const ord = this.messages.ordOf(messageId);
    if (ord === null) return 0;

    return this.transact(() => {
      // Само сообщение и всё новее: `after` отдаёт строго новее, поэтому
      // отсчитываем от предыдущей позиции.
      const doomed = this.messages.after(conversationId, ord - 1);

      for (const message of doomed) {
        this.messages.softDelete(message.id);
        this.search.remove(message.id);
        this.record({ type: 'message.deleted', id: message.id, conversationId });
      }
      return doomed.length;
    });
  }

  deleteMessage(id: string, conversationId: string): void {
    this.transact(() => {
      this.messages.softDelete(id);
      this.search.remove(id);
      this.record({ type: 'message.deleted', id, conversationId });
    });
  }

  // ─── Память ───────────────────────────────────────────────────────────────

  upsertFact(key: string, value: string, origin: Fact['origin'] = 'user'): Fact {
    return this.transact(() => {
      const now = new Date().toISOString();
      const existing = this.facts.byKey(key);
      const fact = this.facts.upsert({
        id: existing?.id ?? randomUUID(),
        key,
        value,
        origin,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      this.record({ type: 'fact.upserted', fact }, now);
      return fact;
    });
  }

  forgetFact(id: string): void {
    this.transact(() => {
      this.facts.delete(id);
      this.record({ type: 'fact.forgotten', id });
    });
  }

  /**
   * Записать наблюдение — или подтвердить уже записанное.
   *
   * Одна операция на оба случая намеренно: агент, заметив что-то во второй
   * раз, не знает и не должен знать, помнил ли он это раньше. Разведи их на
   * `create` и `reinforce`, и решать пришлось бы модели — то есть иногда
   * неверно, с дублем в памяти в качестве расплаты.
   */
  notice(text: string, kind: Observation['kind'] = 'context'): Observation {
    return this.transact(() => {
      const now = new Date().toISOString();
      const norm = normalizeObservation(text);
      const existing = this.observations.byNorm(norm);

      const observation = this.observations.upsert({
        id: existing?.id ?? randomUUID(),
        text,
        kind: existing?.kind ?? kind,
        norm,
        weight: existing ? reinforcedWeight(existing) : 1,
        hits: (existing?.hits ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastSeenAt: now,
      });

      this.record({ type: 'observation.noticed', observation }, now);
      this.evictObservations();
      return observation;
    });
  }

  forgetObservation(id: string): void {
    this.transact(() => {
      this.observations.delete(id);
      this.record({ type: 'observation.forgotten', id });
    });
  }

  /**
   * Держать память в берегах.
   *
   * Вызывается при записи, а не по таймеру: единственный момент, когда память
   * может переполниться, — это когда в неё что-то добавили. Таймер тут был бы
   * фоновой задачей, которая почти всегда просыпается зря.
   */
  private evictObservations(): void {
    for (const stale of evictionCandidates(this.observations.list())) {
      this.observations.delete(stale.id);
      this.record({ type: 'observation.forgotten', id: stale.id });
    }
  }

  // ─── Устройства ───────────────────────────────────────────────────────────

  pairDevice(input: {
    name: string;
    platform: DevicePlatform;
    scopes: Scope[];
    tokenHash: string;
  }): Device {
    return this.transact(() => {
      const now = new Date().toISOString();
      const device: Device = {
        id: randomUUID(),
        name: input.name,
        platform: input.platform,
        scopes: input.scopes,
        pairedAt: now,
      };
      this.devices.insert(device, input.tokenHash);
      this.record({ type: 'device.paired', device }, now);
      return device;
    });
  }

  revokeDevice(id: string): void {
    this.transact(() => {
      this.devices.revoke(id);
      this.record({ type: 'device.revoked', id });
    });
  }

  // ─── Настройки ────────────────────────────────────────────────────────────

  /**
   * Значения обычных настроек и секретов пишутся вместе, но в журнал уходят
   * только имена ключей: журнал синкается на все устройства, а среди настроек
   * лежат API-ключи.
   */
  updateSettings(input: {
    values?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }): void {
    this.transact(() => {
      const now = new Date().toISOString();
      const keys: string[] = [];

      for (const [key, value] of Object.entries(input.values ?? {})) {
        this.settings.set(key, value, now);
        keys.push(key);
      }
      for (const [key, value] of Object.entries(input.secrets ?? {})) {
        if (value === null) this.secrets.delete(key);
        else this.secrets.set(key, value);
        keys.push(key);
      }

      if (keys.length > 0) {
        this.record({ type: 'settings.changed', keys }, now);
      }
    });
  }

  // ─── Синхронизация ────────────────────────────────────────────────────────

  head(): Seq {
    return this.journal.head();
  }

  pull(since: Seq, limit: number): { entries: JournalEntry[]; cursor: Seq; hasMore: boolean } {
    const entries = this.journal.read(since, limit);
    const cursor = entries.length > 0 ? entries[entries.length - 1]!.seq : since;
    return { entries, cursor, hasMore: entries.length === limit };
  }

  /** Постоянный id этой установки ядра — создаётся при первом обращении. */
  coreId(): string {
    const row = this.db.prepare(`SELECT core_id FROM core_identity WHERE singleton = 1`).get() as
      | { core_id: string }
      | undefined;
    if (row) return row.core_id;

    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO core_identity (singleton, core_id, created_at) VALUES (1, ?, ?)`)
      .run(id, new Date().toISOString());
    return id;
  }
}
