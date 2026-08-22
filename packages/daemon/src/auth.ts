import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Device, DevicePlatform, Scope } from '@axon/protocol';
import type { Runtime } from '@axon/core';

/**
 * Токен устройства выдаётся один раз и больше не показывается. В базе лежит
 * только его sha256 — утёкший файл БД не даёт войти в ядро.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export interface PendingPairing {
  name: string;
  platform: DevicePlatform;
  scopes: Scope[];
  expiresAt: number;
}

/**
 * Пейринг устройств.
 *
 * Обычный путь: уже доверенное устройство просит код, новое устройство меняет
 * код на токен. Проблема курицы и яйца — первое устройство — решается так же,
 * как в Jupyter: при первом запуске ядро пишет одноразовый код в файл рядом с
 * данными. У кого есть доступ к машине, тот и заводит первое устройство; по
 * сети код не улетает.
 */
export class PairingService {
  private readonly pending = new Map<string, PendingPairing>();

  constructor(
    private readonly runtime: Runtime,
    private readonly bootstrapPath: string,
  ) {}

  /** Код первого устройства. Пишется только если устройств ещё нет. */
  ensureBootstrapCode(): string | null {
    if (this.runtime.store.devices.list().length > 0) {
      // Устройства есть — файл больше не нужен и только увеличивает риск.
      fs.rmSync(this.bootstrapPath, { force: true });
      return null;
    }

    const code = generateCode();
    fs.mkdirSync(path.dirname(this.bootstrapPath), { recursive: true });
    fs.writeFileSync(this.bootstrapPath, `${code}\n`, { mode: 0o600 });

    this.pending.set(code, {
      name: 'Первое устройство',
      platform: 'desktop',
      // Первому устройству — всё: с него настраивают остальные.
      scopes: [
        'chat.read',
        'chat.write',
        'tools.safe',
        'tools.sensitive',
        'tools.dangerous',
        'settings.write',
        'devices.manage',
      ],
      expiresAt: Number.POSITIVE_INFINITY,
    });

    return code;
  }

  begin(input: {
    name: string;
    platform: DevicePlatform;
    scopes: Scope[];
    ttlSeconds: number;
  }): { code: string; expiresInSeconds: number } {
    const code = generateCode();
    this.pending.set(code, {
      name: input.name,
      platform: input.platform,
      scopes: input.scopes,
      expiresAt: Date.now() + input.ttlSeconds * 1000,
    });
    return { code, expiresInSeconds: input.ttlSeconds };
  }

  /** Обменять код на токен. Код одноразовый. */
  complete(code: string, deviceName?: string): { device: Device; token: string } | null {
    this.sweep();
    const pending = this.pending.get(code);
    if (!pending) return null;
    this.pending.delete(code);

    const token = generateToken();
    const device = this.runtime.store.pairDevice({
      name: deviceName || pending.name,
      platform: pending.platform,
      scopes: pending.scopes,
      tokenHash: hashToken(token),
    });

    // Первое устройство завелось — код больше не действует.
    fs.rmSync(this.bootstrapPath, { force: true });

    return { device, token };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [code, pending] of this.pending) {
      if (pending.expiresAt < now) this.pending.delete(code);
    }
  }
}

/** Короткий код, который не стыдно продиктовать голосом. */
function generateCode(): string {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY34679';
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return code;
}

/** Найти устройство по предъявленному токену. */
export function authenticate(runtime: Runtime, token: string | null): Device | null {
  if (!token) return null;
  return runtime.store.devices.byTokenHash(hashToken(token));
}
