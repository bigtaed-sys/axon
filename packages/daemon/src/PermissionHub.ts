import type { PermissionDecision, PermissionRequest } from '@axon/protocol';
import type { PermissionBroker } from '@axon/core';
import { logger } from '@axon/core';

/**
 * Ожидание ответа на запрос разрешения.
 *
 * Тонкость, из-за которой это отдельный класс: если ответить некому, ждать
 * пять минут бессмысленно и вредно — прогон висит, пользователь смотрит на
 * «выполняется». Поэтому сначала проверяем, есть ли вообще кто-то на связи с
 * правом отвечать, и только потом ждём.
 */
export class PermissionHub implements PermissionBroker {
  private readonly pending = new Map<
    string,
    { resolve: (decision: PermissionDecision) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly hasAudience: () => boolean) {}

  async request(request: PermissionRequest): Promise<PermissionDecision> {
    if (!this.hasAudience()) {
      logger.info({ tool: request.toolName }, 'спросить некого — отказываем');
      return 'deny_once';
    }

    const ttl = Math.max(1000, Date.parse(request.expiresAt) - Date.now());

    return await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        logger.info({ tool: request.toolName }, 'запрос разрешения протух');
        resolve('expired');
      }, ttl);

      this.pending.set(request.id, { resolve, timer });
    });
  }

  /** Ответ пришёл командой от устройства. */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const waiting = this.pending.get(requestId);
    if (!waiting) return false;

    clearTimeout(waiting.timer);
    this.pending.delete(requestId);
    waiting.resolve(decision);
    return true;
  }

  /** Есть ли незакрытые запросы — демон показывает это в /health. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Снять все ожидания при остановке демона. */
  shutdown(): void {
    for (const [, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.resolve('expired');
    }
    this.pending.clear();
  }
}
