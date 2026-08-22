import type { RiskTier, ToolResult } from '@axon/protocol';
import type { ToolRegistry, SelectOptions } from './ToolRegistry.js';
import type { ToolContext, ToolDefinition } from './types.js';

/**
 * Сколько символов вывода инструмента попадает в контекст модели.
 *
 * Это главный вентиль расхода токенов во всём агенте. Один `ls` в большой
 * папке или один HTTP-ответ на 200 КБ — и разговор дорожает навсегда, потому
 * что этот текст остаётся в истории и переотправляется каждый ход.
 */
export const PREVIEW_LIMIT = 2_000;

/** Потолок времени на один вызов, если инструмент не задал свой. */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface PermissionDecider {
  /**
   * Решение по инструменту до его запуска. `ask` означает «спросить
   * пользователя» — исполнитель сам дёрнет `ctx.requestPermission`.
   */
  decide(input: {
    tool: ToolDefinition;
    args: Record<string, unknown>;
  }): Promise<'allow' | 'deny' | 'ask'>;
}

/**
 * Политика по умолчанию: safe пропускаем молча, всё остальное спрашиваем.
 * Постоянные решения («всегда разрешать») подменяют её реализацией поверх
 * таблицы permission_rules.
 */
export const defaultPermissions: PermissionDecider = {
  async decide({ tool }) {
    return tool.tier === 'safe' ? 'allow' : 'ask';
  },
};

export interface ExecuteInput {
  name: string;
  args: unknown;
  ctx: ToolContext;
  /** Права устройства — те же, что использовались при выдаче схем модели. */
  access: SelectOptions;
  timeoutMs?: number;
}

export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionDecider = defaultPermissions,
  ) {}

  async execute(input: ExecuteInput): Promise<ToolResult> {
    const started = Date.now();
    const fail = (error: string): ToolResult => ({
      ok: false,
      error,
      durationMs: Date.now() - started,
    });

    const tool = this.registry.get(input.name);
    if (!tool) return fail(`Инструмент ${input.name} не найден`);

    // Проверяем права повторно, а не доверяем тому, что модель видела схему:
    // вызов мог прийти из истории, собранной при других правах.
    if (!this.registry.isAllowed(input.name, input.access)) {
      return fail(`Инструмент ${input.name} недоступен этому устройству`);
    }

    const parsed = tool.schema.safeParse(input.args);
    if (!parsed.success) {
      // Текст ошибки уходит модели как результат — она обычно исправляет
      // аргументы со второй попытки, если сказать ей, что именно не так.
      return fail(`Неверные аргументы: ${formatIssues(parsed.error)}`);
    }
    const args = parsed.data as Record<string, unknown>;

    const decision = await this.permissions.decide({ tool, args });
    if (decision === 'deny') return fail(`Запрещено политикой: ${input.name}`);
    if (decision === 'ask') {
      const granted = await input.ctx.requestPermission({
        toolName: tool.name,
        tier: tool.tier,
        reason: describe(tool, args),
        arguments: args,
      });
      if (!granted) return fail(`Пользователь отклонил вызов ${input.name}`);
    }

    try {
      const output = await withTimeout(
        () => tool.execute(args, input.ctx),
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        input.ctx.signal,
      );
      return await this.toResult(
        output.text,
        output.mime ?? 'text/plain',
        tool.previewLimit ?? PREVIEW_LIMIT,
        input.ctx,
        started,
      );
    } catch (e) {
      const error = e as Error;
      if (error.name === 'AbortError') return fail('Вызов отменён');
      input.ctx.logger.warn({ tool: input.name, err: error.message }, 'инструмент упал');
      return fail(error.message || 'Неизвестная ошибка инструмента');
    }
  }

  /**
   * Полный вывод уезжает в блоб, в контекст модели идёт только preview со
   * ссылкой. Модель при необходимости прочитает остальное отдельным вызовом —
   * это дешевле, чем тащить всё в историю навсегда.
   */
  private async toResult(
    text: string,
    mime: string,
    limit: number,
    ctx: ToolContext,
    started: number,
  ): Promise<ToolResult> {
    const durationMs = Date.now() - started;
    if (text.length <= limit) {
      return { ok: true, preview: text, truncated: false, durationMs };
    }

    const preview = text.slice(0, limit) + `\n… обрезано, всего ${text.length} символов`;

    if (!ctx.blobs) {
      return { ok: true, preview, truncated: true, durationMs };
    }

    try {
      const { blobId } = await ctx.blobs.write({ data: text, mime });
      return { ok: true, preview, truncated: true, fullBlobId: blobId, durationMs };
    } catch (e) {
      ctx.logger.warn({ err: (e as Error).message }, 'не удалось сохранить полный вывод');
      return { ok: true, preview, truncated: true, durationMs };
    }
  }
}

// ─── Вспомогательное ────────────────────────────────────────────────────────

function describe(tool: ToolDefinition, args: Record<string, unknown>): string {
  const summary = JSON.stringify(args);
  const short = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
  return `${tool.title} (${riskWord(tool.tier)}): ${short}`;
}

function riskWord(tier: RiskTier): string {
  switch (tier) {
    case 'safe':
      return 'безопасно';
    case 'sensitive':
      return 'затрагивает внешние системы';
    case 'dangerous':
      return 'необратимо меняет систему';
  }
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(корень)'} — ${issue.message}`)
    .join('; ');
}

/**
 * Таймаут поверх отмены. Инструмент без потолка времени способен подвесить
 * весь прогон: модель ждёт результата, пользователь ждёт модель.
 */
async function withTimeout<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      const error = new Error('Вызов отменён');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) return abort();

    const timer = setTimeout(() => {
      reject(new Error(`Превышен лимит времени (${timeoutMs} мс)`));
    }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });

    void run()
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      });
  });
}
