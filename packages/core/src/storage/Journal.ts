import type { JournalEntry, JournalEvent, Seq } from '@axon/protocol';
import type { Db } from './db.js';

export type JournalListener = (entry: JournalEntry) => void;

interface JournalRow {
  seq: number;
  at: string;
  payload: string;
}

/**
 * Журнал — единственная точка, через которую состояние меняется.
 *
 * Правило, на котором держится синхронизация: запись в журнал и обновление
 * производных таблиц происходят в одной транзакции. Если их разнести, клиент
 * рано или поздно получит событие о том, чего в БД ещё нет, — и разойдётся с
 * ядром навсегда, потому что курсор уже сдвинут.
 *
 * Поэтому `append` не открывает транзакцию сам: его вызывают **внутри** уже
 * открытой (см. Store.transact).
 */
export class Journal {
  private readonly listeners = new Set<JournalListener>();

  constructor(private readonly db: Db) {}

  /** Дописать событие. Вызывать только внутри транзакции Store. */
  append(event: JournalEvent, at: string = new Date().toISOString()): JournalEntry {
    const conversationId = extractConversationId(event);
    const info = this.db
      .prepare(`INSERT INTO journal (at, type, conversation_id, payload) VALUES (?, ?, ?, ?)`)
      .run(at, event.type, conversationId, JSON.stringify(event));

    return { seq: Number(info.lastInsertRowid), at, event };
  }

  /** Текущая вершина журнала. 0 — журнал пуст. */
  head(): Seq {
    const row = this.db.prepare(`SELECT MAX(seq) AS head FROM journal`).get() as {
      head: number | null;
    };
    return row.head ?? 0;
  }

  /** Записи строго после `since`, по возрастанию seq. */
  read(since: Seq, limit: number): JournalEntry[] {
    const rows = this.db
      .prepare(`SELECT seq, at, payload FROM journal WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(since, limit) as JournalRow[];

    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.payload) as JournalEvent,
    }));
  }

  /** Записи по конкретному разговору — для отладки и точечной досылки. */
  readForConversation(conversationId: string, since: Seq, limit: number): JournalEntry[] {
    const rows = this.db
      .prepare(
        `SELECT seq, at, payload FROM journal
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(conversationId, since, limit) as JournalRow[];

    return rows.map((r) => ({
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.payload) as JournalEvent,
    }));
  }

  /**
   * Подписка на новые записи. Слушателей зовёт Store — после коммита, а не из
   * тела транзакции: подписчик не должен увидеть событие, которое ещё может
   * откатиться.
   */
  subscribe(listener: JournalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @internal Вызывается Store после успешного коммита. */
  emit(entries: readonly JournalEntry[]): void {
    for (const entry of entries) {
      for (const listener of this.listeners) {
        listener(entry);
      }
    }
  }
}

/**
 * Достаёт id разговора из события — денормализация ради индекса. Не у всех
 * событий он есть: настройки, устройства и память к разговорам не привязаны.
 */
function extractConversationId(event: JournalEvent): string | null {
  switch (event.type) {
    case 'conversation.created':
      return event.conversation.id;
    case 'conversation.renamed':
    case 'conversation.archived':
    case 'conversation.deleted':
      return event.id;
    case 'message.created':
    case 'message.amended':
      return event.message.conversationId;
    case 'message.deleted':
      return event.conversationId;
    case 'run.started':
    case 'run.finished':
    case 'run.failed':
    case 'tool_call.started':
    case 'tool_call.finished':
      return event.conversationId;
    case 'permission.requested':
      return null;
    default:
      return null;
  }
}
