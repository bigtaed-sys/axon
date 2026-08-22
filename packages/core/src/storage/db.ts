import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { migrations } from './migrations.js';
import { DatabaseSync, type SqliteDatabase } from './sqlite.js';

/**
 * Хранилище на встроенном в Node SQLite.
 *
 * Раньше здесь был better-sqlite3 — нативный модуль, и он тянул за собой две
 * тяжёлые проблемы. При установке через npm он либо скачивает готовый бинарник
 * под ровно твою платформу и версию Node, либо начинает компилироваться — и на
 * машине без компилятора установка падает. А внутри Electron у него другой ABI,
 * из-за чего его приходилось пересобирать отдельно.
 *
 * `node:sqlite` снимает и то и другое: ставить нечего, собирать нечего.
 * Плата — модуль помечен экспериментальным, поэтому вся работа с ним спрятана
 * за узким фасадом ниже: если API поменяется, чинить придётся один файл.
 */

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface Statement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T = unknown>(...params: SqlValue[]): T | undefined;
  all<T = unknown>(...params: SqlValue[]): T[];
}

export interface Db {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  /** Выполнить атомарно. Вложенные вызовы разворачиваются в savepoint'ы. */
  runInTransaction<T>(fn: () => T): T;
  getUserVersion(): number;
  setUserVersion(version: number): void;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Путь к файлу БД. `:memory:` — для тестов. */
  databasePath: string;
}

/**
 * Открывает БД и доводит её до актуальной схемы.
 *
 * Синглтона на уровне модуля здесь нет намеренно — в старом проекте база
 * висела в module scope, из-за чего её нельзя было поднять дважды в одном
 * процессе. Демону это нужно (тесты, несколько профилей), поэтому владение
 * соединением отдаётся вызывающему.
 */
export function openDatabase({ databasePath }: OpenDatabaseOptions): Db {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new SqliteDb(new DatabaseSync(databasePath));

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  // Ждём вместо мгновенного SQLITE_BUSY: к одной БД ходят и демон, и CLI.
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
}

class SqliteDb implements Db {
  private depth = 0;

  constructor(private readonly db: SqliteDatabase) {}

  prepare(sql: string): Statement {
    const statement = this.db.prepare(sql);
    return {
      run: (...params) => {
        const result = statement.run(...params);
        return {
          changes: Number(result.changes),
          lastInsertRowid: Number(result.lastInsertRowid),
        };
      },
      get: <T>(...params: SqlValue[]) => statement.get(...params) as T | undefined,
      all: <T>(...params: SqlValue[]) => statement.all(...params) as T[],
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * Транзакции руками: у встроенного модуля нет обёртки вроде
   * `better-sqlite3.transaction`. Вложенность разворачивается в savepoint'ы —
   * без них внутренний откат обрушил бы всю внешнюю транзакцию.
   */
  runInTransaction<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const name = `sp_${this.depth}`;

    this.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
    this.depth++;

    try {
      const result = fn();
      this.db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
      return result;
    } catch (e) {
      this.db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
      if (nested) this.db.exec(`RELEASE ${name}`);
      throw e;
    } finally {
      this.depth--;
    }
  }

  getUserVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as
      | { user_version?: number }
      | undefined;
    return Number(row?.user_version ?? 0);
  }

  setUserVersion(version: number): void {
    // PRAGMA не принимает параметры — число подставляем сами, и оно приходит
    // только из наших миграций, а не снаружи.
    this.db.exec(`PRAGMA user_version = ${Math.trunc(version)}`);
  }

  close(): void {
    this.db.close();
  }
}

function migrate(db: Db): void {
  const current = db.getUserVersion();
  const pending = migrations.filter((m) => m.version > current);
  if (pending.length === 0) return;

  for (const migration of pending) {
    logger.info({ version: migration.version, name: migration.name }, 'применяю миграцию');
    // Схема и отметка о версии меняются одной транзакцией: оборванная миграция
    // не оставляет БД в состоянии «половина таблиц есть, версия старая».
    db.runInTransaction(() => {
      db.exec(migration.sql);
      db.setUserVersion(migration.version);
    });
  }
}
