/**
 * Векторы и слияние выдач.
 *
 * Чистая математика без ввода-вывода: её можно проверить, и она не зависит ни
 * от провайдера, ни от хранилища. Всё остальное в семантическом поиске —
 * обвязка вокруг этих трёх функций.
 */

/**
 * Вектор в байты для хранения в базе.
 *
 * `Float32`, а не `Float64`: точность эмбеддинга и близко не требует double,
 * а размер вдвое меньше. На пяти тысячах сообщений это разница между
 * пятнадцатью мегабайтами и тридцатью.
 */
export function pack(vector: readonly number[]): Buffer {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

export function unpack(blob: Uint8Array): Float32Array {
  // Копия, а не вид поверх чужой памяти: SQLite отдаёт буфер, который может
  // быть переиспользован под следующую строку.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/**
 * Косинусная близость.
 *
 * Векторы у эмбеддингов обычно уже нормированы, и тогда хватило бы скалярного
 * произведения. Но «обычно» — не «всегда»: разные модели ведут себя
 * по-разному, а деление на длины стоит один проход и снимает вопрос
 * целиком. На тысячах векторов это микросекунды.
 */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;

  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    lengthA += x * x;
    lengthB += y * y;
  }

  if (lengthA === 0 || lengthB === 0) return 0;
  return dot / Math.sqrt(lengthA * lengthB);
}

/** Ранг элемента — от нуля. Отсутствующий считается бесконечно далёким. */
const MISSING = Number.POSITIVE_INFINITY;

/**
 * Сгладить влияние верхних мест.
 *
 * Классическое значение из работ про reciprocal rank fusion. Смысл в том, что
 * без него первое место одной выдачи перевешивает всё остальное, и слияние
 * вырождается в «показать результаты того, кто ответил первым».
 */
const RRF_K = 60;

/**
 * Слить две выдачи по рангам, а не по оценкам.
 *
 * Оценки полнотекстового поиска и косинусной близости несравнимы: у первого
 * это вес BM25 в своих единицах, у второго — число от минус единицы до
 * единицы. Привести их друг к другу нельзя, зато можно сравнить **места**:
 * то, что оба способа поставили высоко, почти наверняка и есть нужное.
 *
 * Это и есть главный выигрыш от гибрида. Полнотекстовый находит точное слово —
 * имя, код ошибки, название файла, — где семантика бесполезна. Семантический
 * находит «переезд» по запросу «сменил квартиру», где точное слово не
 * встречается. Порознь каждый регулярно промахивается; вместе — редко.
 */
export function fuse(lists: ReadonlyArray<readonly string[]>, limit: number): string[] {
  const scores = new Map<string, number>();

  for (const list of lists) {
    list.forEach((id, index) => {
      const rank = index === -1 ? MISSING : index;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}
