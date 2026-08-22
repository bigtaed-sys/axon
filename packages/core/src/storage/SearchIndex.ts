import type { ContentPart, Message, Role } from '@axon/protocol';
import type { Db } from './db.js';

/** До какой позиции журнала индекс доведён. */
export const INDEXED_UP_TO_SETTING = 'search.indexedUpTo';

export interface SearchHit {
  conversationId: string;
  messageId: string;
  role: Role;
  createdAt: string;
  /** Кусок текста вокруг совпадения; найденные слова обёрнуты в «звёздочки». */
  snippet: string;
}

/**
 * Полнотекстовый поиск по переписке.
 *
 * Индекс — производная величина, и относиться к нему надо соответственно: он
 * не источник правды, его можно потерять и построить заново. Отсюда две вещи в
 * устройстве.
 *
 * Во-первых, наполняется он не триггером, а кодом при записи сообщения: текст
 * лежит в JSON-массиве частей, и вытащить его чисто на SQL нельзя, а
 * индексировать JSON целиком — значит искать по словам «text» и «type» наравне
 * с содержимым.
 *
 * Во-вторых, есть водяная метка `search.indexedUpTo`. `ord` сообщения — это
 * seq журнальной записи, то есть монотонный счётчик на всё ядро. Поэтому
 * «доиндексировать всё, что новее метки» разом решает и первое наполнение
 * после обновления, и починку после сбоя, и пропущенное — одной операцией
 * вместо трёх разных.
 */
export class SearchIndex {
  constructor(private readonly db: Db) {}

  /**
   * Догнать индекс до текущего состояния переписки. Дёшево, когда догонять
   * нечего: один запрос, который ничего не находит.
   */
  catchUp(batch = 500): number {
    let indexed = 0;

    for (;;) {
      const from = this.watermark();
      const rows = this.db
        .prepare(
          `SELECT id, conversation_id, ord, role, parts FROM messages
           WHERE ord > ? AND deleted = 0
           ORDER BY ord ASC LIMIT ?`,
        )
        .all(from, batch) as Array<{
        id: string;
        conversation_id: string;
        ord: number;
        role: string;
        parts: string;
      }>;

      if (rows.length === 0) return indexed;

      const insert = this.db.prepare(
        `INSERT INTO message_search (text, message_id, conversation_id) VALUES (?, ?, ?)`,
      );
      const drop = this.db.prepare(`DELETE FROM message_search WHERE message_id = ?`);

      this.db.runInTransaction(() => {
        for (const row of rows) {
          const text = plainText(JSON.parse(row.parts) as ContentPart[], row.role as Role);
          drop.run(row.id);
          if (text) insert.run(fold(text), row.id, row.conversation_id);
        }
        this.setWatermark(rows[rows.length - 1]!.ord);
      });

      indexed += rows.length;
      if (rows.length < batch) return indexed;
    }
  }

  /** Проиндексировать одно сообщение. Вызывается внутри транзакции Store. */
  add(message: Message, ord: number): void {
    const text = plainText(message.parts, message.role);
    this.db.prepare(`DELETE FROM message_search WHERE message_id = ?`).run(message.id);
    if (text) {
      this.db
        .prepare(`INSERT INTO message_search (text, message_id, conversation_id) VALUES (?, ?, ?)`)
        .run(fold(text), message.id, message.conversationId);
    }
    if (ord > this.watermark()) this.setWatermark(ord);
  }

  remove(messageId: string): void {
    this.db.prepare(`DELETE FROM message_search WHERE message_id = ?`).run(messageId);
  }

  removeConversation(conversationId: string): void {
    this.db.prepare(`DELETE FROM message_search WHERE conversation_id = ?`).run(conversationId);
  }

  /**
   * Найти сообщения. Запрос пользователя приводится к виду, который FTS5 не
   * примет за синтаксис: иначе кавычка или звёздочка в обычном тексте роняют
   * поиск ошибкой вместо того, чтобы ничего не найти.
   */
  search(query: string, limit = 40): SearchHit[] {
    const words = queryWords(query);
    if (words.length === 0) return [];

    const rows = this.db
      .prepare(
        `SELECT s.message_id, s.conversation_id, m.role, m.created_at, m.parts
         FROM message_search s
         JOIN messages m ON m.id = s.message_id AND m.deleted = 0
         WHERE message_search MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(words.map((word) => `"${word}"*`).join(' AND '), limit) as Array<{
      message_id: string;
      conversation_id: string;
      role: string;
      created_at: string;
      parts: string;
    }>;

    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role as Role,
      createdAt: row.created_at,
      // Кусок вырезаем из настоящего текста, а не из индексированного: в
      // индексе «ё» свёрнута в «е», и snippet() вернул бы «елка» там, где
      // человек написал «ёлка».
      snippet: excerpt(plainText(JSON.parse(row.parts) as ContentPart[], row.role as Role), words),
    }));
  }

  private watermark(): number {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(
      INDEXED_UP_TO_SETTING,
    ) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as number) : 0;
  }

  private setWatermark(ord: number): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(INDEXED_UP_TO_SETTING, JSON.stringify(ord), new Date().toISOString());
  }
}

/**
 * Текст сообщения для индекса.
 *
 * Служебные сообщения (`system`) не индексируются: системный промпт один на
 * все разговоры, и он находился бы по любому слову из себя, засоряя выдачу.
 * Вложения дают только имя файла — байты искать нечем.
 */
function plainText(parts: ContentPart[], role: Role): string {
  if (role === 'system') return '';

  return parts
    .map((part) => (part.type === 'text' ? part.text : (part.name ?? '')))
    .filter(Boolean)
    .join('\n')
    .slice(0, 100_000);
}

/**
 * Свернуть «ё» в «е».
 *
 * SQLite этого не делает: `remove_diacritics` знает про латиницу и не считает
 * кириллическую «ё» буквой с диакритикой. А по-русски пишут и так и так —
 * человек, набравший «елка», должен найти «ёлку». Замена односимвольная,
 * поэтому смещения в тексте не съезжают, и по ним можно резать оригинал.
 */
function fold(text: string): string {
  return text.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
}

/**
 * Слова запроса. Кавычки выбрасываются, потому что для FTS5 это синтаксис:
 * без этого одна кавычка в поисковой строке роняет запрос ошибкой разбора
 * вместо того, чтобы просто ничего не найти.
 */
function queryWords(raw: string): string[] {
  return fold(raw)
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/["*(){}:^-]/g, ''))
    .filter((word) => word.length > 0);
}

/** Сколько символов показывать вокруг найденного. */
const WINDOW = 90;

/**
 * Кусок текста вокруг первого совпадения, с обёрнутыми находками.
 *
 * Считается по свёрнутой копии, а режется по оригиналу: свёртка не меняет
 * длину, поэтому смещения совпадают, и в выдачу попадает то, что человек
 * действительно написал.
 */
function excerpt(text: string, words: string[]): string {
  if (!text) return '';
  const folded = fold(text.toLowerCase());

  const first = words
    .map((word) => folded.indexOf(word.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  // Совпадение может быть по началу слова в другой форме — тогда просто
  // показываем начало сообщения.
  const centre = first ?? 0;
  const from = Math.max(0, centre - WINDOW / 2);
  const to = Math.min(text.length, centre + WINDOW);

  let cut = text.slice(from, to);
  if (from > 0) cut = `…${cut}`;
  if (to < text.length) cut = `${cut}…`;

  return highlight(cut, words);
}

/** Обернуть найденные слова «ёлочками» — по ним клиент рисует подсветку. */
function highlight(text: string, words: string[]): string {
  const folded = fold(text.toLowerCase());
  const marks: Array<[number, number]> = [];

  for (const word of words) {
    const needle = fold(word.toLowerCase());
    let at = folded.indexOf(needle);
    while (at >= 0) {
      // До конца слова, а не только до конца введённого куска: искали «нас» —
      // подсветить надо «настройки» целиком.
      let end = at + needle.length;
      while (end < text.length && /[\p{L}\p{N}]/u.test(text[end]!)) end++;
      marks.push([at, end]);
      at = folded.indexOf(needle, end);
    }
  }

  if (marks.length === 0) return text;

  marks.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const mark of marks) {
    const last = merged.at(-1);
    if (last && mark[0] <= last[1]) last[1] = Math.max(last[1], mark[1]);
    else merged.push([...mark]);
  }

  let out = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    out += text.slice(cursor, start) + '«' + text.slice(start, end) + '»';
    cursor = end;
  }
  return out + text.slice(cursor);
}
