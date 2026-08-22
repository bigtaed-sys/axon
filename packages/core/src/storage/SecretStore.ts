import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SecretStatus } from '@axon/protocol';
import type { Db } from './db.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** SQLite отдаёт BLOB как Uint8Array — узлы crypto его понимают напрямую. */
interface SecretRow {
  key: string;
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  hint: string;
  updated_at: string;
}

/**
 * Хранилище секретов: API-ключи провайдеров, токены интеграций.
 *
 * Честно про модель угроз. Шифрование защищает от утечки **файла БД** —
 * бэкапа, папки в облачном синке, дампа, приложенного к баг-репорту. От того,
 * у кого есть вся папка данных, оно не защищает: ключ лежит там же, рядом.
 * Так и задумано — иначе ядро не смогло бы стартовать без человека у клавиатуры.
 *
 * Наружу по протоколу значение не отдаётся никогда, даже владельцу: украденный
 * токен устройства не должен превращаться в кражу API-ключей. Посмотреть
 * значение целиком можно только локальной CLI на машине с ядром.
 */
export class SecretStore {
  private key: Buffer | null = null;

  constructor(
    private readonly db: Db,
    private readonly keyPath: string,
  ) {}

  set(key: string, value: string): SecretStatus {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, this.masterKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const hint = value.length > 4 ? value.slice(-4) : '';
    const updatedAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO secrets (key, ciphertext, iv, tag, hint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           ciphertext = excluded.ciphertext,
           iv         = excluded.iv,
           tag        = excluded.tag,
           hint       = excluded.hint,
           updated_at = excluded.updated_at`,
      )
      .run(key, ciphertext, iv, tag, hint, updatedAt);

    return { key, set: true, hint, updatedAt };
  }

  /**
   * Расшифрованное значение. Использовать только внутри ядра (вызов провайдера)
   * и в локальной CLI. По протоколу наружу не отдавать.
   */
  reveal(key: string): string | null {
    const row = this.db.prepare(`SELECT * FROM secrets WHERE key = ?`).get(key) as
      | SecretRow
      | undefined;
    if (!row) return null;

    const decipher = crypto.createDecipheriv(ALGORITHM, this.masterKey(), row.iv);
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM secrets WHERE key = ?`).run(key);
  }

  has(key: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS ok FROM secrets WHERE key = ?`).get(key);
    return row !== undefined;
  }

  /** Что можно показать клиенту: факт наличия и хвост значения. */
  status(keys?: readonly string[]): SecretStatus[] {
    const rows = this.db
      .prepare(`SELECT key, hint, updated_at FROM secrets ORDER BY key ASC`)
      .all() as Array<Pick<SecretRow, 'key' | 'hint' | 'updated_at'>>;

    const stored = new Map(rows.map((r) => [r.key, r]));
    const wanted = keys ?? rows.map((r) => r.key);

    return wanted.map((key) => {
      const row = stored.get(key);
      if (!row) return { key, set: false };
      return {
        key,
        set: true,
        ...(row.hint ? { hint: row.hint } : {}),
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Мастер-ключ из файла, при первом обращении создаётся. Права 0600 —
   * на Windows это ничего не значит, там защита держится на ACL профиля
   * пользователя, и это стоит помнить, обещая что-либо про безопасность.
   */
  private masterKey(): Buffer {
    if (this.key) return this.key;

    const fromEnv = process.env['AXON_SECRET_KEY'];
    if (fromEnv) {
      const key = Buffer.from(fromEnv, 'base64');
      if (key.length !== KEY_BYTES) {
        throw new Error(`AXON_SECRET_KEY должен быть ${KEY_BYTES} байт в base64`);
      }
      this.key = key;
      return key;
    }

    if (fs.existsSync(this.keyPath)) {
      const key = fs.readFileSync(this.keyPath);
      if (key.length !== KEY_BYTES) {
        throw new Error(`Файл ключа повреждён: ${this.keyPath}`);
      }
      this.key = key;
      return key;
    }

    const key = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    this.key = key;
    return key;
  }
}
