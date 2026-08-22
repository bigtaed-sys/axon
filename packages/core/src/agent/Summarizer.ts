import { randomUUID } from 'node:crypto';
import type { Message } from '@axon/protocol';
import { logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { Store } from '../storage/Store.js';
import { estimateTokens } from './tokens.js';

const PROMPT =
  'Сожми переписку в конспект для продолжения разговора. Сохрани: решения и ' +
  'договорённости, факты о пользователе и его окружении, незакрытые вопросы, ' +
  'результаты выполненной работы. Выброси: приветствия, рассуждения вслух, ' +
  'повторы, промежуточные шаги, которые больше ни на что не влияют. Пиши ' +
  'плотно, тезисами, от третьего лица. Без вступления и без заключения.';

export interface SummarizerOptions {
  /** Порог в токенах, после которого история сворачивается. */
  thresholdTokens?: number;
  /** Сколько последних сообщений всегда оставлять несвёрнутыми. */
  keepRecent?: number;
  /** Чем сворачивать. Дешёвая модель тут не хуже дорогой. */
  provider?: string;
  model?: string;
}

const DEFAULT_THRESHOLD = 12_000;
const DEFAULT_KEEP_RECENT = 8;

/**
 * Сворачивание старой истории.
 *
 * Работает в фоне и молча: сводка не должна задерживать ответ пользователю.
 * Если сжатие не удалось — разговор просто продолжается с полной историей,
 * это дороже, но не сломано.
 *
 * Важная тонкость: свёрнутый кусок меняет системный блок, а значит обнуляет
 * кэш промпта на следующем ходу. Поэтому порог высокий и сворачиваем редко —
 * частая экономия на истории обошлась бы дороже самой истории.
 */
export class Summarizer {
  constructor(
    private readonly store: Store,
    private readonly providers: ProviderRegistry,
    private readonly options: SummarizerOptions = {},
  ) {}

  /** Свернуть, если пора. Ошибки поглощает сама. */
  async maybeSummarize(conversationId: string): Promise<void> {
    try {
      await this.run(conversationId);
    } catch (e) {
      logger.warn({ err: (e as Error).message, conversationId }, 'сводка не собралась');
    }
  }

  private async run(conversationId: string): Promise<void> {
    const keepRecent = this.options.keepRecent ?? DEFAULT_KEEP_RECENT;
    const threshold = this.options.thresholdTokens ?? DEFAULT_THRESHOLD;

    const previous = this.store.summaries.latest(conversationId);
    const pending = previous
      ? this.store.messages.after(conversationId, previous.upToOrd)
      : this.store.messages.recent(conversationId, 1_000);

    // Хвост не трогаем: свежие сообщения нужны модели дословно.
    const candidates = pending.slice(0, Math.max(0, pending.length - keepRecent));
    if (candidates.length === 0) return;

    const size = candidates.reduce((sum, m) => sum + estimateTokens(textOf(m)), 0);
    if (size < threshold) return;

    const { provider, model } = this.providers.resolve(
      this.options.provider ?? this.providers.current().descriptor.id,
      this.options.model,
    );

    const transcript = candidates.map((m) => `${m.role}: ${textOf(m)}`).join('\n\n');
    const previousText = previous ? `Предыдущий конспект:\n${previous.text}\n\n` : '';

    let summary = '';
    for await (const event of provider.chat({
      model,
      maxTokens: 2_000,
      effort: 'low',
      thinking: 'off',
      messages: [
        { role: 'system', parts: [{ type: 'text', text: PROMPT }] },
        { role: 'user', parts: [{ type: 'text', text: previousText + transcript }] },
      ],
    })) {
      if (event.type === 'text') summary += event.delta;
    }

    if (!summary.trim()) return;

    const upToOrd = this.store.messages.ordOf(candidates.at(-1)!.id);
    if (upToOrd === null) return;

    this.store.transact(() => {
      this.store.summaries.insert({
        id: randomUUID(),
        conversationId,
        upToOrd,
        text: summary.trim(),
        tokens: estimateTokens(summary),
        createdAt: new Date().toISOString(),
      });
    });

    logger.info(
      { conversationId, messages: candidates.length, before: size, after: estimateTokens(summary) },
      'история свёрнута',
    );
  }
}

function textOf(message: Message): string {
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}
