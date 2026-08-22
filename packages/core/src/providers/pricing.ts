import type { Usage } from '@axon/protocol';

/**
 * Тарифы в USD за миллион токенов. Таблица заведомо устаревает — она нужна
 * только чтобы показать пользователю порядок величины в реальном времени,
 * а не для выставления счетов.
 *
 * `cacheReadRatio` и `cacheWriteRatio` — множители к цене входа. Они и есть
 * весь смысл кэша промпта: чтение примерно вдесятеро дешевле обычного ввода,
 * запись примерно на четверть дороже.
 */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadRatio: number;
  cacheWriteRatio: number;
}

const ANTHROPIC_DEFAULT: Pick<ModelRate, 'cacheReadRatio' | 'cacheWriteRatio'> = {
  cacheReadRatio: 0.1,
  cacheWriteRatio: 1.25,
};

export const RATES: Readonly<Record<string, Record<string, ModelRate>>> = {
  anthropic: {
    'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, ...ANTHROPIC_DEFAULT },
    'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, ...ANTHROPIC_DEFAULT },
    'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, ...ANTHROPIC_DEFAULT },
    'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, ...ANTHROPIC_DEFAULT },
  },
  deepseek: {
    // У DeepSeek кэш работает иначе: попадание тарифицируется отдельной ставкой,
    // а не множителем, но в пересчёте это примерно тот же порядок.
    'deepseek-chat': {
      inputPerMTok: 0.27,
      outputPerMTok: 1.1,
      cacheReadRatio: 0.26,
      cacheWriteRatio: 1,
    },
    'deepseek-reasoner': {
      inputPerMTok: 0.55,
      outputPerMTok: 2.19,
      cacheReadRatio: 0.26,
      cacheWriteRatio: 1,
    },
  },
};

/** Локальные модели бесплатны — считать нечего. */
const FREE_PROVIDERS = new Set(['ollama', 'lmstudio']);

export function rateFor(provider: string, model: string): ModelRate | null {
  return RATES[provider]?.[model] ?? null;
}

/**
 * Оценка стоимости вызова. Возвращает `undefined`, если тариф неизвестен —
 * лучше не показать цифру, чем показать выдуманную.
 */
export function estimateCost(usage: Omit<Usage, 'costUsd'>): number | undefined {
  if (FREE_PROVIDERS.has(usage.provider)) return 0;

  const rate = rateFor(usage.provider, usage.model);
  if (!rate) return undefined;

  // inputTokens у всех провайдеров означает «не считая кэша» — нормализация
  // происходит в самих провайдерах, тут уже можно складывать.
  const input = (usage.inputTokens * rate.inputPerMTok) / 1_000_000;
  const cacheRead =
    (usage.cachedInputTokens * rate.inputPerMTok * rate.cacheReadRatio) / 1_000_000;
  const cacheWrite =
    (usage.cacheWriteTokens * rate.inputPerMTok * rate.cacheWriteRatio) / 1_000_000;
  const output = (usage.outputTokens * rate.outputPerMTok) / 1_000_000;

  return input + cacheRead + cacheWrite + output;
}

/**
 * Доля контекста, пришедшая из кэша. Главная метрика экономии: если она
 * держится около нуля на длинном разговоре — кэш сломан.
 */
export function cacheHitRatio(usage: Pick<Usage, 'inputTokens' | 'cachedInputTokens'>): number {
  const total = usage.inputTokens + usage.cachedInputTokens;
  return total === 0 ? 0 : usage.cachedInputTokens / total;
}
