import type { Device, DevicePlatform } from '@axon/protocol';

/**
 * Всё, что идёт мимо WebSocket: пейринг (токена ещё нет) и блобы (не нужно
 * забивать живой канал файлами и терять кэширование с докачкой).
 */

export interface PairResult {
  token: string;
  device: Device;
  core: { coreId: string; version: string };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Обменять код на токен устройства. Токен показывается ровно один раз. */
export async function pairDevice(input: {
  url: string;
  code: string;
  name?: string;
}): Promise<PairResult> {
  const response = await fetch(`${input.url}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Код диктуют голосом и вводят руками — регистр и пробелы не должны мешать.
      code: input.code.trim().toUpperCase(),
      ...(input.name ? { name: input.name } : {}),
    }),
  });

  if (!response.ok) {
    throw new HttpError(response.status, response.status === 403 ? 'Код неверен или истёк' : 'Не удалось подключиться');
  }
  return (await response.json()) as PairResult;
}

export interface CoreHealth {
  ok: boolean;
  coreId: string;
  version: string;
  mode: 'embedded' | 'standalone';
  devices: number;
  pendingPermissions: number;
}

/** Живо ли ядро по этому адресу. Токен не нужен — это проверка доступности. */
export async function checkHealth(url: string): Promise<CoreHealth> {
  const response = await fetch(`${url}/health`);
  if (!response.ok) throw new HttpError(response.status, 'Ядро не отвечает');
  return (await response.json()) as CoreHealth;
}

export class BlobClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async upload(input: {
    data: Blob | ArrayBuffer | string;
    mime: string;
    name?: string;
  }): Promise<{ blobId: string; bytes: number }> {
    const query = input.name ? `?name=${encodeURIComponent(input.name)}` : '';
    const response = await fetch(`${this.url}/v1/blobs${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': input.mime },
      body: input.data as BodyInit,
    });
    if (!response.ok) throw new HttpError(response.status, 'Не удалось загрузить файл');
    return (await response.json()) as { blobId: string; bytes: number };
  }

  /** Прямая ссылка — годится для `<img src>`, скачивания и предпросмотра. */
  urlFor(blobId: string): string {
    return `${this.url}/v1/blobs/${blobId}?token=${encodeURIComponent(this.token)}`;
  }

  async download(blobId: string): Promise<Blob> {
    const response = await fetch(`${this.url}/v1/blobs/${blobId}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new HttpError(response.status, 'Файл не найден');
    return await response.blob();
  }
}

export type { DevicePlatform };
