/**
 * Оценка размера текста в токенах.
 *
 * Это именно оценка, и она нужна только для решений внутри ядра: пора ли
 * сворачивать историю, влезет ли ещё один блок в контекст. Настоящие цифры
 * приходят от провайдера в `usage` и идут в учёт и в интерфейс — смешивать
 * эти два числа нельзя, иначе счётчик расхода начнёт врать.
 *
 * Точный подсчёт потребовал бы отдельного запроса к API на каждый ход: лишняя
 * задержка и лишние деньги ради решения, которое прекрасно принимается по
 * приблизительной цифре.
 */

/** Кириллица токенизируется плотнее латиницы — примерно вдвое. */
const CHARS_PER_TOKEN_CYRILLIC = 2.2;
const CHARS_PER_TOKEN_LATIN = 3.8;

export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cyrillic = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0x0400 && code <= 0x04ff) cyrillic++;
  }
  const other = text.length - cyrillic;

  return Math.ceil(cyrillic / CHARS_PER_TOKEN_CYRILLIC + other / CHARS_PER_TOKEN_LATIN);
}

/**
 * Бюджет прогона.
 *
 * Потолок проверяется перед каждым обращением к модели, а не после: агент,
 * который «заметил» перерасход постфактум, уже потратил деньги. Проверка до
 * вызова стоит один if и превращает бюджет из пожелания в границу.
 */
export class TokenBudget {
  private used = 0;

  constructor(readonly total: number | null) {}

  spend(tokens: number): void {
    this.used += tokens;
  }

  get spent(): number {
    return this.used;
  }

  get remaining(): number {
    return this.total === null ? Number.POSITIVE_INFINITY : Math.max(0, this.total - this.used);
  }

  /** Исчерпан ли бюджет. Без потолка — никогда. */
  get exhausted(): boolean {
    return this.total !== null && this.used >= this.total;
  }
}
