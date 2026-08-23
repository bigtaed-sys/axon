import type {
  ContentPart,
  Conversation,
  Device,
  DevicePlatform,
  Fact,
  Message,
  Observation,
  PluginOrigin,
  Role,
  Routine,
  RoutineRun,
  Scope,
  ToolCall,
  Usage,
} from '@axon/protocol';
import type { Db } from './db.js';

/**
 * Репозитории — чистый доступ к данным, без записи в журнал.
 *
 * Журналирование намеренно вынесено в Store: если каждый репозиторий будет
 * дописывать события сам, инвариант «журнал и состояние меняются одной
 * транзакцией» размажется по десятку файлов и рано или поздно где-нибудь
 * порвётся.
 */

// ─── Разговоры ──────────────────────────────────────────────────────────────

interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
  total_tokens: number;
}

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archived: r.archived === 1,
  totalTokens: r.total_tokens,
});

export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  insert(conversation: Conversation): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, archived, total_tokens)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt,
        conversation.archived ? 1 : 0,
        conversation.totalTokens,
      );
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
      | ConversationRow
      | undefined;
    return row ? toConversation(row) : null;
  }

  list(limit: number, includeArchived = false): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE (? = 1 OR archived = 0)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(includeArchived ? 1 : 0, limit) as ConversationRow[];
    return rows.map(toConversation);
  }

  rename(id: string, title: string, at: string): void {
    this.db
      .prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title, at, id);
  }

  setArchived(id: string, archived: boolean, at: string): void {
    this.db
      .prepare(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?`)
      .run(archived ? 1 : 0, at, id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
  }

  /** Сдвинуть время последней активности и накопленный расход. */
  touch(id: string, at: string, addTokens = 0): void {
    this.db
      .prepare(
        `UPDATE conversations SET updated_at = ?, total_tokens = total_tokens + ? WHERE id = ?`,
      )
      .run(at, addTokens, id);
  }
}

// ─── Сообщения ──────────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  conversation_id: string;
  ord: number;
  role: string;
  parts: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  usage: string | null;
  created_at: string;
  deleted: number;
}

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role as Role,
  parts: JSON.parse(r.parts) as ContentPart[],
  ...(r.tool_calls ? { toolCalls: JSON.parse(r.tool_calls) as ToolCall[] } : {}),
  ...(r.tool_call_id ? { toolCallId: r.tool_call_id } : {}),
  ...(r.usage ? { usage: JSON.parse(r.usage) as Usage } : {}),
  createdAt: r.created_at,
});

export class MessagesRepo {
  constructor(private readonly db: Db) {}

  /** `ord` задаёт Store — это seq журнальной записи о создании сообщения. */
  insert(message: Message, ord: number): void {
    this.db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, ord, role, parts, tool_calls, tool_call_id, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.conversationId,
        ord,
        message.role,
        JSON.stringify(message.parts),
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId ?? null,
        message.usage ? JSON.stringify(message.usage) : null,
        message.createdAt,
      );
  }

  /** Замена содержимого без сдвига позиции: правка текста, подстановка usage. */
  update(message: Message): void {
    this.db
      .prepare(
        `UPDATE messages SET parts = ?, tool_calls = ?, tool_call_id = ?, usage = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(message.parts),
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.toolCallId ?? null,
        message.usage ? JSON.stringify(message.usage) : null,
        message.id,
      );
  }

  get(id: string): Message | null {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ? AND deleted = 0`).get(id) as
      | MessageRow
      | undefined;
    return row ? toMessage(row) : null;
  }

  /** Последние `limit` сообщений разговора, в хронологическом порядке. */
  recent(conversationId: string, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE conversation_id = ? AND deleted = 0
           ORDER BY ord DESC LIMIT ?
         ) ORDER BY ord ASC`,
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  /**
   * Последнее сообщение с такой ролью во всех разговорах сразу.
   *
   * Нужно, чтобы понять, давно ли человек вообще появлялся. Спрашивать это по
   * конкретному разговору неправильно: он мог за это время писать в другой, и
   * агент решил бы, что человек пропал, разговаривая с ним прямо сейчас.
   */
  lastByRole(role: Role): Message | null {
    const row = this.db
      .prepare(
        `SELECT * FROM messages WHERE role = ? AND deleted = 0 ORDER BY ord DESC LIMIT 1`,
      )
      .get(role) as MessageRow | undefined;
    return row ? toMessage(row) : null;
  }

  /** Всё, что новее позиции `ord` — основа для сборки контекста поверх сводки. */
  after(conversationId: string, ord: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND ord > ? AND deleted = 0
         ORDER BY ord ASC`,
      )
      .all(conversationId, ord) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Страница вверх по истории: сообщения строго старше `beforeId`. */
  page(conversationId: string, beforeId: string | null, limit: number): Message[] {
    const pivot = beforeId
      ? (this.db.prepare(`SELECT ord FROM messages WHERE id = ?`).get(beforeId) as
          | { ord: number }
          | undefined)
      : undefined;
    const before = pivot?.ord ?? Number.MAX_SAFE_INTEGER;

    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
           WHERE conversation_id = ? AND ord < ? AND deleted = 0
           ORDER BY ord DESC LIMIT ?
         ) ORDER BY ord ASC`,
      )
      .all(conversationId, before, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  count(conversationId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND deleted = 0`)
      .get(conversationId) as { n: number };
    return row.n;
  }

  /** Мягкое удаление: сообщение исчезает из выборок, но позиции не съезжают. */
  softDelete(id: string): void {
    this.db.prepare(`UPDATE messages SET deleted = 1 WHERE id = ?`).run(id);
  }

  ordOf(id: string): number | null {
    const row = this.db.prepare(`SELECT ord FROM messages WHERE id = ?`).get(id) as
      | { ord: number }
      | undefined;
    return row?.ord ?? null;
  }
}

// ─── Сводки ─────────────────────────────────────────────────────────────────

export interface Summary {
  id: string;
  conversationId: string;
  upToOrd: number;
  text: string;
  tokens: number | null;
  createdAt: string;
}

interface SummaryRow {
  id: string;
  conversation_id: string;
  up_to_ord: number;
  text: string;
  tokens: number | null;
  created_at: string;
}

export class SummariesRepo {
  constructor(private readonly db: Db) {}

  insert(summary: Summary): void {
    this.db
      .prepare(
        `INSERT INTO summaries (id, conversation_id, up_to_ord, text, tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.id,
        summary.conversationId,
        summary.upToOrd,
        summary.text,
        summary.tokens,
        summary.createdAt,
      );
  }

  latest(conversationId: string): Summary | null {
    const row = this.db
      .prepare(
        `SELECT * FROM summaries WHERE conversation_id = ? ORDER BY up_to_ord DESC LIMIT 1`,
      )
      .get(conversationId) as SummaryRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      upToOrd: row.up_to_ord,
      text: row.text,
      tokens: row.tokens,
      createdAt: row.created_at,
    };
  }
}

// ─── Память ─────────────────────────────────────────────────────────────────

interface FactRow {
  id: string;
  key: string;
  value: string;
  origin: string;
  created_at: string;
  updated_at: string;
}

const toFact = (r: FactRow): Fact => ({
  id: r.id,
  key: r.key,
  value: r.value,
  origin: r.origin as Fact['origin'],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class FactsRepo {
  constructor(private readonly db: Db) {}

  upsert(fact: Fact): Fact {
    this.db
      .prepare(
        `INSERT INTO facts (id, key, value, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value      = excluded.value,
           origin     = excluded.origin,
           updated_at = excluded.updated_at`,
      )
      .run(fact.id, fact.key, fact.value, fact.origin, fact.createdAt, fact.updatedAt);
    // При конфликте id остаётся прежним, поэтому перечитываем.
    return this.byKey(fact.key) ?? fact;
  }

  byKey(key: string): Fact | null {
    const row = this.db.prepare(`SELECT * FROM facts WHERE key = ?`).get(key) as
      | FactRow
      | undefined;
    return row ? toFact(row) : null;
  }

  list(): Fact[] {
    const rows = this.db.prepare(`SELECT * FROM facts ORDER BY key ASC`).all() as FactRow[];
    return rows.map(toFact);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM facts WHERE id = ?`).run(id);
  }
}

// ─── Векторы ────────────────────────────────────────────────────────────────

export interface EmbeddingRow {
  messageId: string;
  conversationId: string;
  vector: Uint8Array;
}

/**
 * Векторы сообщений.
 *
 * Хранилище нарочно тупое: положить, достать всё по модели, найти
 * необсчитанное. Вся математика — в `memory/vectors.ts`, вся политика — в
 * `EmbeddingIndex`. Репозиторий про смысл векторов не знает.
 */
export class EmbeddingsRepo {
  constructor(private readonly db: Db) {}

  put(messageId: string, model: string, vector: readonly number[]): void {
    this.db
      .prepare(
        `INSERT INTO embeddings (message_id, model, dim, vector, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(message_id) DO UPDATE SET
           model      = excluded.model,
           dim        = excluded.dim,
           vector     = excluded.vector,
           created_at = excluded.created_at`,
      )
      .run(messageId, model, vector.length, packVector(vector), new Date().toISOString());
  }

  /**
   * Сообщения, которые ещё не обсчитаны этой моделью.
   *
   * Берём только текстовые реплики человека и агента: результаты инструментов
   * — это выводы команд и куски файлов, искать по их смыслу бессмысленно, а
   * платить за их векторы пришлось бы наравне со всем остальным.
   */
  pending(model: string, fromOrd: number, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m
         LEFT JOIN embeddings e ON e.message_id = m.id AND e.model = ?
         WHERE m.deleted = 0
           AND m.ord > ?
           AND m.role IN ('user', 'assistant')
           AND e.message_id IS NULL
         ORDER BY m.ord ASC
         LIMIT ?`,
      )
      .all(model, fromOrd, limit) as MessageRow[];
    return rows.map(toMessage);
  }

  /** Все векторы одной модели вместе с разговором, которому они принадлежат. */
  all(model: string): EmbeddingRow[] {
    const rows = this.db
      .prepare(
        `SELECT e.message_id, e.vector, m.conversation_id
         FROM embeddings e
         JOIN messages m ON m.id = e.message_id AND m.deleted = 0
         WHERE e.model = ?`,
      )
      .all(model) as Array<{ message_id: string; vector: Uint8Array; conversation_id: string }>;

    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      vector: row.vector,
    }));
  }

  /** Сколько посчитано — для отчёта человеку. */
  count(model: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM embeddings WHERE model = ?`)
      .get(model) as { n: number };
    return row.n;
  }

  /** Выбросить всё: сменили модель или человек передумал. */
  clear(): void {
    this.db.prepare(`DELETE FROM embeddings`).run();
  }
}

/** Вектор в байты. Копия того, что делает `memory/vectors.ts`, но без импорта
 *  оттуда: репозитории не должны зависеть от слоя политики. */
function packVector(vector: readonly number[]): Buffer {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

// ─── Наблюдения ─────────────────────────────────────────────────────────────

interface ObservationRow {
  id: string;
  text: string;
  kind: string;
  norm: string;
  weight: number;
  hits: number;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

function toObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    text: row.text,
    kind: row.kind as Observation['kind'],
    weight: row.weight,
    hits: row.hits,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Ключ, по которому наблюдение считается тем же самым.
 *
 * Агент, заметив одно и то же дважды, почти никогда не повторит формулировку
 * дословно: «не любит длинных объяснений» и «Не любит длинных объяснений!» —
 * одно наблюдение. Без свёртки к общему виду таблица заполняется вариациями
 * одной мысли, и каждая приходит в промпт отдельной строкой.
 *
 * Свёртка нарочно грубая: регистр, пунктуация, ё и лишние пробелы. Ловить
 * синонимы здесь нечем — за это отвечает сам агент, которому наблюдения
 * показываются целиком.
 */
export function normalizeObservation(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ObservationsRepo {
  constructor(private readonly db: Db) {}

  upsert(observation: Observation & { norm: string }): Observation {
    this.db
      .prepare(
        `INSERT INTO observations (id, text, kind, norm, weight, hits, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(norm) DO UPDATE SET
           text         = excluded.text,
           kind         = excluded.kind,
           weight       = excluded.weight,
           hits         = excluded.hits,
           updated_at   = excluded.updated_at,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(
        observation.id,
        observation.text,
        observation.kind,
        observation.norm,
        observation.weight,
        observation.hits,
        observation.createdAt,
        observation.updatedAt,
        observation.lastSeenAt,
      );
    return this.byNorm(observation.norm) ?? observation;
  }

  byNorm(norm: string): Observation | null {
    const row = this.db.prepare(`SELECT * FROM observations WHERE norm = ?`).get(norm) as
      | ObservationRow
      | undefined;
    return row ? toObservation(row) : null;
  }

  byId(id: string): Observation | null {
    const row = this.db.prepare(`SELECT * FROM observations WHERE id = ?`).get(id) as
      | ObservationRow
      | undefined;
    return row ? toObservation(row) : null;
  }

  /**
   * Все наблюдения разом.
   *
   * Их сотни, а не миллионы: вытеснение держит таблицу маленькой намеренно.
   * Поэтому отбор и затухание считаются в JS, где видно правило, а не в SQL,
   * где то же самое пришлось бы выражать арифметикой по строке даты.
   */
  list(): Observation[] {
    const rows = this.db
      .prepare(`SELECT * FROM observations ORDER BY weight DESC, last_seen_at DESC`)
      .all() as ObservationRow[];
    return rows.map(toObservation);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM observations WHERE id = ?`).run(id);
  }
}

// ─── Устройства ─────────────────────────────────────────────────────────────

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  scopes: string;
  token_hash: string;
  paired_at: string;
  last_seen_at: string | null;
  cursor: number;
  revoked: number;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  platform: r.platform as DevicePlatform,
  scopes: JSON.parse(r.scopes) as Scope[],
  pairedAt: r.paired_at,
  ...(r.last_seen_at ? { lastSeenAt: r.last_seen_at } : {}),
});

export class DevicesRepo {
  constructor(private readonly db: Db) {}

  insert(device: Device, tokenHash: string): void {
    this.db
      .prepare(
        `INSERT INTO devices (id, name, platform, scopes, token_hash, paired_at, cursor, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
      )
      .run(
        device.id,
        device.name,
        device.platform,
        JSON.stringify(device.scopes),
        tokenHash,
        device.pairedAt,
      );
  }

  /** Поиск по хэшу токена — сам токен ядро не хранит и сравнить не может. */
  byTokenHash(tokenHash: string): Device | null {
    const row = this.db
      .prepare(`SELECT * FROM devices WHERE token_hash = ? AND revoked = 0`)
      .get(tokenHash) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  get(id: string): Device | null {
    const row = this.db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as
      | DeviceRow
      | undefined;
    return row ? toDevice(row) : null;
  }

  list(): Device[] {
    const rows = this.db
      .prepare(`SELECT * FROM devices WHERE revoked = 0 ORDER BY paired_at ASC`)
      .all() as DeviceRow[];
    return rows.map(toDevice);
  }

  revoke(id: string): void {
    this.db.prepare(`UPDATE devices SET revoked = 1 WHERE id = ?`).run(id);
  }

  seen(id: string, at: string): void {
    this.db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(at, id);
  }

  /** Позиция устройства в журнале: с неё продолжаем досылку после реконнекта. */
  setCursor(id: string, cursor: number): void {
    this.db.prepare(`UPDATE devices SET cursor = ? WHERE id = ?`).run(cursor, id);
  }

  cursor(id: string): number {
    const row = this.db.prepare(`SELECT cursor FROM devices WHERE id = ?`).get(id) as
      | { cursor: number }
      | undefined;
    return row?.cursor ?? 0;
  }
}

// ─── Правила разрешений ─────────────────────────────────────────────────────

export type PermissionRule = 'allow' | 'deny';

/**
 * Постоянные решения «всегда разрешать / всегда запрещать» по инструменту.
 * Аргументы намеренно не учитываются: правило вида «разрешить shell только с
 * этой командой» создаёт ложное чувство безопасности — команду всё равно можно
 * переписать так, чтобы она прошла проверку и сделала другое.
 */
export class PermissionRulesRepo {
  constructor(private readonly db: Db) {}

  get(toolName: string): PermissionRule | null {
    const row = this.db
      .prepare(`SELECT decision FROM permission_rules WHERE tool_name = ?`)
      .get(toolName) as { decision: string } | undefined;
    return (row?.decision as PermissionRule) ?? null;
  }

  set(id: string, toolName: string, decision: PermissionRule, at: string): void {
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, tool_name, decision, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(tool_name) DO UPDATE SET decision = excluded.decision`,
      )
      .run(id, toolName, decision, at);
  }

  clear(toolName: string): void {
    this.db.prepare(`DELETE FROM permission_rules WHERE tool_name = ?`).run(toolName);
  }

  list(): Array<{ toolName: string; decision: PermissionRule }> {
    const rows = this.db
      .prepare(`SELECT tool_name, decision FROM permission_rules ORDER BY tool_name`)
      .all() as Array<{ tool_name: string; decision: string }>;
    return rows.map((r) => ({ toolName: r.tool_name, decision: r.decision as PermissionRule }));
  }
}

// ─── Настройки ──────────────────────────────────────────────────────────────

// ─── Плагины ────────────────────────────────────────────────────────────────

export interface PluginRow {
  id: string;
  originType: PluginOrigin['type'];
  originRef: string;
  enabled: boolean;
  installedAt: string;
  updatedAt: string;
}

export class PluginsRepo {
  constructor(private readonly db: Db) {}

  list(): PluginRow[] {
    const rows = this.db.prepare(`SELECT * FROM plugins ORDER BY id ASC`).all() as RawPluginRow[];
    return rows.map(toPluginRow);
  }

  get(id: string): PluginRow | null {
    const row = this.db.prepare(`SELECT * FROM plugins WHERE id = ?`).get(id) as
      | RawPluginRow
      | undefined;
    return row ? toPluginRow(row) : null;
  }

  upsert(row: PluginRow): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, origin_type, origin_ref, enabled, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           origin_type = excluded.origin_type,
           origin_ref  = excluded.origin_ref,
           enabled     = excluded.enabled,
           updated_at  = excluded.updated_at`,
      )
      .run(
        row.id,
        row.originType,
        row.originRef,
        row.enabled ? 1 : 0,
        row.installedAt,
        row.updatedAt,
      );
  }

  setEnabled(id: string, enabled: boolean, at: string): void {
    this.db
      .prepare(`UPDATE plugins SET enabled = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, at, id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
  }
}

interface RawPluginRow {
  id: string;
  origin_type: string;
  origin_ref: string;
  enabled: number;
  installed_at: string;
  updated_at: string;
}

function toPluginRow(row: RawPluginRow): PluginRow {
  return {
    id: row.id,
    originType: row.origin_type as PluginOrigin['type'],
    originRef: row.origin_ref,
    enabled: row.enabled === 1,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

// ─── Рутины ─────────────────────────────────────────────────────────────────

export class RoutinesRepo {
  constructor(private readonly db: Db) {}

  list(): Routine[] {
    const rows = this.db
      .prepare(`SELECT * FROM routines ORDER BY created_at ASC`)
      .all() as RoutineRow[];
    return rows.map(toRoutine);
  }

  get(id: string): Routine | null {
    const row = this.db.prepare(`SELECT * FROM routines WHERE id = ?`).get(id) as
      | RoutineRow
      | undefined;
    return row ? toRoutine(row) : null;
  }

  /** Что пора запускать. Пропущенное за время сна ядра попадает сюда же. */
  due(now: string): Routine[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM routines
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(now) as RoutineRow[];
    return rows.map(toRoutine);
  }

  upsert(routine: Routine): void {
    this.db
      .prepare(
        `INSERT INTO routines
           (id, name, description, source, steps, schedule, enabled, conversation_id,
            budget_tokens, allow_tools, notify, created_at, updated_at, next_run_at,
            last_run_at, last_status, last_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name            = excluded.name,
           description     = excluded.description,
           source          = excluded.source,
           steps           = excluded.steps,
           schedule        = excluded.schedule,
           enabled         = excluded.enabled,
           conversation_id = excluded.conversation_id,
           budget_tokens   = excluded.budget_tokens,
           allow_tools     = excluded.allow_tools,
           notify          = excluded.notify,
           updated_at      = excluded.updated_at,
           next_run_at     = excluded.next_run_at,
           last_run_at     = excluded.last_run_at,
           last_status     = excluded.last_status,
           last_summary    = excluded.last_summary`,
      )
      .run(
        routine.id,
        routine.name,
        routine.description,
        routine.source,
        JSON.stringify(routine.steps),
        JSON.stringify(routine.schedule),
        routine.enabled ? 1 : 0,
        routine.conversationId ?? null,
        routine.budgetTokens,
        JSON.stringify(routine.allowTools),
        routine.notify ? 1 : 0,
        routine.createdAt,
        routine.updatedAt,
        routine.nextRunAt ?? null,
        routine.lastRunAt ?? null,
        routine.lastStatus ?? null,
        routine.lastSummary ?? null,
      );
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM routines WHERE id = ?`).run(id);
  }

  // ─── Прогоны ────────────────────────────────────────────────────────────

  /** Завести запись о прогоне до его начала — чтобы след остался и при падении. */
  startRun(input: { routineId: string; startedAt: string; trigger: string }): number {
    const info = this.db
      .prepare(
        `INSERT INTO routine_runs (routine_id, started_at, status, trigger)
         VALUES (?, ?, 'running', ?)`,
      )
      .run(input.routineId, input.startedAt, input.trigger);
    return Number(info.lastInsertRowid);
  }

  finishRun(run: RoutineRun): void {
    this.db
      .prepare(
        `UPDATE routine_runs
         SET finished_at = ?, status = ?, steps = ?, summary = ?, tokens = ?
         WHERE id = ?`,
      )
      .run(
        run.finishedAt ?? new Date().toISOString(),
        run.status,
        JSON.stringify(run.steps),
        run.summary,
        run.tokens,
        run.id,
      );
  }

  runs(routineId: string, limit: number): RoutineRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?`)
      .all(routineId, limit) as RoutineRunRow[];

    return rows.map((row) => ({
      id: row.id,
      routineId: row.routine_id,
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      status: row.status as RoutineRun['status'],
      trigger: row.trigger as RoutineRun['trigger'],
      steps: JSON.parse(row.steps) as RoutineRun['steps'],
      summary: row.summary,
      tokens: row.tokens,
    }));
  }

  /** Убрать старые прогоны: след нужен свежий, а не за всё время. */
  trimRuns(routineId: string, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM routine_runs
         WHERE routine_id = ?
           AND id NOT IN (SELECT id FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(routineId, routineId, keep);
  }
}

interface RoutineRunRow {
  id: number;
  routine_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  trigger: string;
  steps: string;
  summary: string;
  tokens: number;
}

interface RoutineRow {
  id: string;
  name: string;
  description: string;
  source: string;
  steps: string;
  schedule: string;
  enabled: number;
  conversation_id: string | null;
  budget_tokens: number;
  allow_tools: string;
  notify: number;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_summary: string | null;
}

function toRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    steps: JSON.parse(row.steps) as Routine['steps'],
    schedule: JSON.parse(row.schedule) as Routine['schedule'],
    enabled: row.enabled === 1,
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    budgetTokens: row.budget_tokens,
    allowTools: JSON.parse(row.allow_tools) as string[],
    notify: row.notify === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.next_run_at ? { nextRunAt: row.next_run_at } : {}),
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    ...(row.last_status ? { lastStatus: row.last_status as Routine['lastStatus'] } : {}),
    ...(row.last_summary ? { lastSummary: row.last_summary } : {}),
  };
}

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown, at: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), at);
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as Array<{
      key: string;
      value: string;
    }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = JSON.parse(row.value);
    return out;
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }
}

// ─── Расход ─────────────────────────────────────────────────────────────────

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  runs: number;
}

export interface UsageByModel extends Omit<UsageTotals, 'runs'> {
  provider: string;
  model: string;
}

export class UsageRepo {
  constructor(private readonly db: Db) {}

  record(entry: {
    runId: string;
    conversationId: string | null;
    usage: Usage;
    at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO usage_log
           (run_id, conversation_id, provider, model,
            input_tokens, cached_input_tokens, output_tokens, cost_usd, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.runId,
        entry.conversationId,
        entry.usage.provider,
        entry.usage.model,
        entry.usage.inputTokens,
        entry.usage.cachedInputTokens,
        entry.usage.outputTokens,
        entry.usage.costUsd ?? null,
        entry.at,
      );
  }

  totals(since: string): UsageTotals {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(input_tokens), 0)        AS input_tokens,
           COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
           COALESCE(SUM(output_tokens), 0)       AS output_tokens,
           COALESCE(SUM(cost_usd), 0)            AS cost_usd,
           COUNT(DISTINCT run_id)                AS runs
         FROM usage_log WHERE at >= ?`,
      )
      .get(since) as {
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      runs: number;
    };

    return {
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      runs: row.runs,
    };
  }

  byModel(since: string): UsageByModel[] {
    const rows = this.db
      .prepare(
        `SELECT provider, model,
           COALESCE(SUM(input_tokens), 0)        AS input_tokens,
           COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
           COALESCE(SUM(output_tokens), 0)       AS output_tokens,
           COALESCE(SUM(cost_usd), 0)            AS cost_usd
         FROM usage_log WHERE at >= ?
         GROUP BY provider, model
         ORDER BY output_tokens DESC`,
      )
      .all(since) as Array<{
      provider: string;
      model: string;
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>;

    return rows.map((r) => ({
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
    }));
  }
}
