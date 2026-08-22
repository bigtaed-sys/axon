import type { Observation } from '@axon/protocol';

/**
 * Политика наблюдений: как они стареют, подтверждаются и вытесняются.
 *
 * Файл нарочно без зависимостей и без ввода-вывода — чистые функции над
 * данными. Хранилище зовёт их при записи, сборщик контекста при чтении, и обе
 * стороны считают по одному правилу. Разложи эту арифметику по местам вызова,
 * и однажды промпт начнёт показывать не то, что показывает человеку экран
 * памяти.
 */

/**
 * За сколько дней вес падает вдвое.
 *
 * Разные по виду — потому что стареют они по-разному. Привычка «не любит
 * длинных объяснений» верна и через год. Настроение «на этой неделе выгорел» —
 * уже через месяц не просто бесполезно, а вредно: агент будет обращаться к
 * человеку, которого больше нет.
 */
const HALF_LIFE_DAYS: Readonly<Record<Observation['kind'], number>> = {
  habit: 240,
  preference: 240,
  relationship: 150,
  context: 45,
  mood: 10,
};

/** Выше этого вес не растёт: иначе одна мысль, повторённая десять раз, вытеснит всё. */
const MAX_WEIGHT = 4;

/** Ниже этого наблюдение считается выцветшим и в промпт не идёт. */
const LIVE_THRESHOLD = 0.2;

/** Сколько наблюдений уходит в системный блок. */
const PROMPT_LIMIT = 14;

/** Сколько всего хранится. Остальное вытесняется самым выцветшим. */
export const OBSERVATION_CAPACITY = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Вес с учётом прошедшего времени.
 *
 * Экспоненциальное затухание, а не линейное: наблюдение не должно исчезать в
 * заранее известный день. Линейное «минус столько-то в сутки» даёт обрыв —
 * вчера помнил, сегодня нет; половинное затухание оставляет длинный хвост, и
 * старое воспоминание не пропадает, а перестаёт перебивать свежее.
 */
export function effectiveWeight(observation: Observation, now = Date.now()): number {
  const elapsed = now - Date.parse(observation.lastSeenAt);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return observation.weight;

  const halfLife = HALF_LIFE_DAYS[observation.kind] ?? HALF_LIFE_DAYS.context;
  return observation.weight * Math.pow(0.5, elapsed / DAY_MS / halfLife);
}

/**
 * Вес после подтверждения.
 *
 * Считается от затухшего, а не от записанного: наблюдение, подтверждённое
 * спустя полгода, начинает почти с нуля — и правильно, полгода назад это был
 * другой человек. Прибавка убывающая, поэтому вес подходит к потолку, но не
 * упирается в него с третьего раза.
 */
export function reinforcedWeight(observation: Observation, now = Date.now()): number {
  const current = effectiveWeight(observation, now);
  return Math.min(MAX_WEIGHT, current + (MAX_WEIGHT - current) * 0.45 + 0.35);
}

/**
 * Что показать модели: живое и самое весомое, сверху.
 *
 * Порог отсекает выцветшее, предел — хвост. Отдать всё было бы честнее по
 * форме и хуже по сути: в списке на двести строк характер тонет, а модель
 * начинает отвечать памяти, а не человеку.
 */
export function selectForPrompt(
  observations: readonly Observation[],
  now = Date.now(),
): Observation[] {
  return observations
    .map((observation) => ({ observation, weight: effectiveWeight(observation, now) }))
    .filter((entry) => entry.weight >= LIVE_THRESHOLD)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, PROMPT_LIMIT)
    .map((entry) => entry.observation);
}

/**
 * Кого удалить, когда наблюдений стало больше, чем помещается.
 *
 * Вытесняется самое выцветшее, а не самое старое. Разница существенная:
 * привычка, замеченная год назад и подтверждённая на прошлой неделе, — это
 * лучшее, что у агента есть, и по дате создания она вылетела бы первой.
 */
export function evictionCandidates(
  observations: readonly Observation[],
  capacity = OBSERVATION_CAPACITY,
  now = Date.now(),
): Observation[] {
  if (observations.length <= capacity) return [];

  return observations
    .map((observation) => ({ observation, weight: effectiveWeight(observation, now) }))
    .sort((a, b) => a.weight - b.weight)
    .slice(0, observations.length - capacity)
    .map((entry) => entry.observation);
}
