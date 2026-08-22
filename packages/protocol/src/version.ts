/**
 * Сравнение версий сборки.
 *
 * Версия календарная и приходит из git-тега: `2026.8.23`, а между тегами —
 * `2026.8.23-4-g1a2b3c`, то есть четвёртый коммит после тега.
 *
 * Сравнивать это правилами semver **нельзя**, и это не мелочь: там суффикс
 * после дефиса означает предрелиз, то есть версию *младше* тега. У нас он
 * означает ровно обратное — коммиты, сделанные после. Возьми готовый semver, и
 * свежая сборка из середины работы окажется старше релиза, от которого она
 * отсчитывается.
 *
 * Живёт в протоколе, потому что сравнивают обе стороны: ядро присылает свою
 * версию в рукопожатии, клиент сверяет её со своей.
 */

export interface ParsedVersion {
  /** Числа до дефиса: год, месяц, число. */
  parts: number[];
  /** Сколько коммитов после тега. 0 — ровно тег. */
  ahead: number;
  /** Есть ли несохранённые правки в дереве сборки. */
  dirty: boolean;
  /** Разобралась ли версия вообще. `false` — сборка без тегов. */
  known: boolean;
}

const RELEASE = /^v?(\d+(?:\.\d+)*)(?:-(\d+)-g[0-9a-f]+)?(-dirty)?$/i;

export function parseVersion(raw: string): ParsedVersion {
  const match = RELEASE.exec(raw.trim());
  if (!match?.[1]) return { parts: [], ahead: 0, dirty: false, known: false };

  return {
    parts: match[1].split('.').map(Number),
    ahead: match[2] ? Number(match[2]) : 0,
    dirty: Boolean(match[3]),
    known: true,
  };
}

/**
 * Отрицательное — `a` старше `b`. Ноль — одна и та же сборка.
 *
 * Неразобранная версия считается равной чему угодно: сборка без тегов — это
 * обычное состояние в разработке, и делать из него повод для предупреждений
 * значит показывать предупреждение всегда, а показанное всегда его перестают
 * замечать.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left.known || !right.known) return 0;

  const length = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  if (left.ahead !== right.ahead) return left.ahead < right.ahead ? -1 : 1;
  return 0;
}

/** Как показать версию человеку. */
export function formatVersion(raw: string): string {
  const parsed = parseVersion(raw);
  if (!parsed.known) return raw;

  const base = `v${parsed.parts.join('.')}`;
  if (parsed.ahead === 0) return parsed.dirty ? `${base} (с правками)` : base;
  return `${base} +${parsed.ahead}${parsed.dirty ? ' с правками' : ''}`;
}
