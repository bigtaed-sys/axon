/**
 * Миграции живут строками прямо в коде, а не .sql-файлами рядом.
 *
 * Это осознанный отход от старого проекта: там миграции читались из папки, и
 * при упаковке Electron их приходилось протаскивать через extraResources и
 * asarUnpack — классический источник «у меня работает, у юзера пустая БД».
 * Строка в бандле не может не доехать.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const INIT = `
-- ─── Журнал ────────────────────────────────────────────────────────────────
-- AUTOINCREMENT здесь обязателен, а не «на всякий случай»: без него SQLite
-- переиспользует номер удалённой последней строки, и курсоры клиентов начнут
-- молча пропускать события.
CREATE TABLE journal (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  at              TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  conversation_id TEXT,
  payload         TEXT    NOT NULL
);
CREATE INDEX journal_conversation_idx ON journal(conversation_id, seq);
CREATE INDEX journal_type_idx          ON journal(type, seq);

-- ─── Разговоры и сообщения ─────────────────────────────────────────────────
CREATE TABLE conversations (
  id           TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX conversations_recent_idx ON conversations(archived, updated_at DESC);

-- ord — позиция сообщения в разговоре, равная seq журнальной записи о его
-- создании. Старый проект сортировал по created_at, и два сообщения в одной
-- миллисекунде (а это норма для tool-результатов) могли встать в произвольном
-- порядке или потеряться при выборке «после сообщения X».
CREATE TABLE messages (
  id              TEXT    PRIMARY KEY,
  conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  role            TEXT    NOT NULL,
  parts           TEXT    NOT NULL,
  tool_calls      TEXT,
  tool_call_id    TEXT,
  usage           TEXT,
  created_at      TEXT    NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX messages_ord_idx ON messages(conversation_id, ord);

-- Сжатая история: всё до up_to_ord заменяется в контексте одним текстом.
CREATE TABLE summaries (
  id              TEXT    PRIMARY KEY,
  conversation_id TEXT    NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  up_to_ord       INTEGER NOT NULL,
  text            TEXT    NOT NULL,
  tokens          INTEGER,
  created_at      TEXT    NOT NULL
);
CREATE INDEX summaries_conversation_idx ON summaries(conversation_id, up_to_ord DESC);

-- ─── Блобы ─────────────────────────────────────────────────────────────────
-- Содержимое лежит файлом на диске, в БД только метаданные: иначе SQLite
-- распухает на скриншотах, а бэкап перестаёт быть быстрым.
CREATE TABLE blobs (
  id         TEXT    PRIMARY KEY,
  mime       TEXT    NOT NULL,
  bytes      INTEGER NOT NULL,
  name       TEXT,
  rel_path   TEXT    NOT NULL,
  sha256     TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);
CREATE INDEX blobs_sha_idx ON blobs(sha256);

-- ─── Память ────────────────────────────────────────────────────────────────
CREATE TABLE facts (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  value      TEXT NOT NULL,
  origin     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Устройства ────────────────────────────────────────────────────────────
-- Хранится только хэш токена. Утёкшая БД не даёт войти в ядро.
CREATE TABLE devices (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL,
  platform     TEXT    NOT NULL,
  scopes       TEXT    NOT NULL,
  token_hash   TEXT    NOT NULL UNIQUE,
  paired_at    TEXT    NOT NULL,
  last_seen_at TEXT,
  cursor       INTEGER NOT NULL DEFAULT 0,
  revoked      INTEGER NOT NULL DEFAULT 0
);

-- ─── Настройки и секреты ───────────────────────────────────────────────────
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Секреты шифруются AES-256-GCM ключом из отдельного файла. Это защищает от
-- утечки самой БД — бэкапа, синка папки, отправленного дампа. От того, у кого
-- есть вся папка данных целиком, это не защищает, и не должно: там же лежит ключ.
CREATE TABLE secrets (
  key        TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  iv         BLOB NOT NULL,
  tag        BLOB NOT NULL,
  hint       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ─── Разрешения ────────────────────────────────────────────────────────────
-- Постоянные решения «всегда разрешать / всегда запрещать».
CREATE TABLE permission_rules (
  id         TEXT PRIMARY KEY,
  tool_name  TEXT NOT NULL,
  decision   TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX permission_rules_tool_idx ON permission_rules(tool_name);

-- ─── Расход ────────────────────────────────────────────────────────────────
CREATE TABLE usage_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id              TEXT    NOT NULL,
  conversation_id     TEXT,
  provider            TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  input_tokens        INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL,
  cost_usd            REAL,
  at                  TEXT    NOT NULL
);
CREATE INDEX usage_at_idx  ON usage_log(at);
CREATE INDEX usage_run_idx ON usage_log(run_id);

-- ─── Идентичность ядра ─────────────────────────────────────────────────────
CREATE TABLE core_identity (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  core_id    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * Учёт установленных плагинов.
 *
 * Здесь только то, чего нет на диске: откуда плагин взялся и хочет ли
 * пользователь, чтобы он работал. Манифест намеренно не дублируется в базу —
 * иначе после обновления папки плагина база рассказывала бы про старую версию,
 * и разошлись бы они молча. Источник правды — папка.
 */
const PLUGINS = `
CREATE TABLE plugins (
  id           TEXT    PRIMARY KEY,
  origin_type  TEXT    NOT NULL,
  origin_ref   TEXT    NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  installed_at TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
);
`;

/**
 * Полнотекстовый поиск по переписке.
 *
 * Отдельная таблица, а не индекс поверх `messages`, потому что текст сообщения
 * лежит в JSON-массиве частей: вытащить его чисто средствами SQL нельзя, а
 * индексировать JSON целиком — значит искать по словам «text» и «type» вместе
 * с содержимым. Поэтому индекс наполняется кодом, а `search.indexedUpTo`
 * помнит, до какой позиции журнала он доведён: это делает и первичное
 * наполнение, и починку после сбоя одной и той же операцией.
 */
const SEARCH = `
CREATE VIRTUAL TABLE message_search USING fts5(
  text,
  message_id      UNINDEXED,
  conversation_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

/**
 * Рутины: что агент делает сам, без человека рядом.
 *
 * `next_run_at` хранится, а не держится таймером в памяти, потому что ядро на
 * личной машине выключают и усыпляют. Таймер этого не переживает, а записанное
 * время — переживает: ядро проснулось, увидело, что момент прошёл, и отработало.
 */
const ROUTINES = `
CREATE TABLE routines (
  id              TEXT    PRIMARY KEY,
  name            TEXT    NOT NULL,
  description     TEXT    NOT NULL DEFAULT '',
  -- Исходное описание словами: по нему рутину пересобирают, когда появились
  -- новые инструменты или изменился замысел.
  source          TEXT    NOT NULL DEFAULT '',
  -- Скомпилированные шаги. Хранятся как JSON: это дерево, а не таблица, и
  -- раскладывать его по строкам значило бы собирать обратно при каждом чтении.
  steps           TEXT    NOT NULL DEFAULT '[]',
  schedule        TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT,
  budget_tokens   INTEGER NOT NULL,
  allow_tools     TEXT    NOT NULL DEFAULT '[]',
  notify          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  next_run_at     TEXT,
  last_run_at     TEXT,
  last_status     TEXT,
  last_summary    TEXT
);
CREATE INDEX routines_due_idx ON routines(enabled, next_run_at);

-- След каждого прогона. Отлаживать фоновую задачу без пошагового следа —
-- гадание: видно только «не получилось», и негде посмотреть, на чём именно.
CREATE TABLE routine_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  routine_id   TEXT    NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  started_at   TEXT    NOT NULL,
  finished_at  TEXT,
  status       TEXT    NOT NULL,
  trigger      TEXT    NOT NULL,
  steps        TEXT    NOT NULL DEFAULT '[]',
  summary      TEXT    NOT NULL DEFAULT '',
  tokens       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX routine_runs_idx ON routine_runs(routine_id, id DESC);
`;

/**
 * Наблюдения: память об отношениях.
 *
 * Отдельная таблица от `facts`, а не колонка в ней, потому что различаются
 * не поля, а поведение. Факт живёт, пока его не отменят; наблюдение выцветает
 * само — иначе «занят переездом», записанное в марте, будет въезжать в промпт
 * и в декабре.
 *
 * Затухание не хранится, а считается при чтении из `weight` и `last_seen_at`.
 * Хранить затухший вес значило бы переписывать всю таблицу по таймеру: работа
 * на пустом месте, да ещё и незаметно расходящаяся с реальностью, если ядро
 * этот таймер проспало.
 */
const OBSERVATIONS = `
CREATE TABLE observations (
  id           TEXT    PRIMARY KEY,
  text         TEXT    NOT NULL,
  kind         TEXT    NOT NULL DEFAULT 'context',
  -- Нормализованный текст: по нему ищется дубль при подтверждении. Хранится
  -- колонкой, а не считается на лету, чтобы поиск шёл по индексу.
  norm         TEXT    NOT NULL,
  weight       REAL    NOT NULL DEFAULT 1,
  hits         INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  last_seen_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX observations_norm_idx ON observations(norm);
CREATE INDEX observations_weight_idx ON observations(weight DESC);
`;

export const migrations: readonly Migration[] = [
  { version: 1, name: 'init', sql: INIT },
  { version: 2, name: 'plugins', sql: PLUGINS },
  { version: 3, name: 'search', sql: SEARCH },
  { version: 4, name: 'routines', sql: ROUTINES },
  { version: 5, name: 'observations', sql: OBSERVATIONS },
];
