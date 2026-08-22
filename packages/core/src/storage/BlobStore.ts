import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { BlobReader } from '../agent/ContextBuilder.js';
import type { BlobWriter } from '../tools/types.js';

export interface BlobMeta {
  id: string;
  mime: string;
  bytes: number;
  name: string | null;
  sha256: string;
  createdAt: string;
}

interface BlobRow {
  id: string;
  mime: string;
  bytes: number;
  name: string | null;
  rel_path: string;
  sha256: string;
  created_at: string;
}

/**
 * Хранилище блобов: содержимое файлом на диске, метаданные в БД.
 *
 * Класть байты в SQLite было бы проще, но тогда база распухает на первом же
 * скриншоте, а бэкап перестаёт быть быстрым. На диске же файл можно отдать
 * потоком, с докачкой и кэшированием на стороне клиента.
 *
 * Дедупликация по sha256: одна и та же картинка, отправленная десять раз,
 * занимает место один раз. Для агента, который постоянно снимает скриншоты
 * рабочего стола, это не мелочь.
 */
export class BlobStore implements BlobWriter, BlobReader {
  constructor(
    private readonly db: Db,
    private readonly rootDir: string,
  ) {}

  async write(input: { data: Buffer | string; mime: string; name?: string }): Promise<{
    blobId: string;
    bytes: number;
  }> {
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data, 'utf8');
    const sha256 = crypto.createHash('sha256').update(data).digest('hex');

    const existing = this.db.prepare(`SELECT * FROM blobs WHERE sha256 = ?`).get(sha256) as
      | BlobRow
      | undefined;
    if (existing) return { blobId: existing.id, bytes: existing.bytes };

    // Раскладываем по подкаталогам из первых двух символов хэша: сто тысяч
    // файлов в одной папке кладут файловые менеджеры и замедляют обход.
    const relPath = path.join(sha256.slice(0, 2), sha256);
    const absPath = path.join(this.rootDir, relPath);
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
    await fs.promises.writeFile(absPath, data);

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO blobs (id, mime, bytes, name, rel_path, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.mime, data.length, input.name ?? null, relPath, sha256, new Date().toISOString());

    return { blobId: id, bytes: data.length };
  }

  async read(blobId: string): Promise<{ base64: string; mime: string } | null> {
    const row = this.row(blobId);
    if (!row) return null;
    const data = await fs.promises.readFile(path.join(this.rootDir, row.rel_path));
    return { base64: data.toString('base64'), mime: row.mime };
  }

  meta(blobId: string): BlobMeta | null {
    const row = this.row(blobId);
    if (!row) return null;
    return {
      id: row.id,
      mime: row.mime,
      bytes: row.bytes,
      name: row.name,
      sha256: row.sha256,
      createdAt: row.created_at,
    };
  }

  /** Абсолютный путь для отдачи потоком по HTTP. */
  pathOf(blobId: string): string | null {
    const row = this.row(blobId);
    return row ? path.join(this.rootDir, row.rel_path) : null;
  }

  private row(blobId: string): BlobRow | undefined {
    return this.db.prepare(`SELECT * FROM blobs WHERE id = ?`).get(blobId) as BlobRow | undefined;
  }
}
