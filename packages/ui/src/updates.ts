import { compareVersions } from '@axon/protocol';

/**
 * Проверка обновлений.
 *
 * Единственное место, где приложение ходит куда-то, кроме своего ядра, — и
 * потому единственное, которое стоит объяснить целиком.
 *
 * **Зачем.** Приложение раздаётся файлом: установщиком с сайта и APK, который
 * не из магазина. Значит, узнать о новой версии человеку неоткуда, кроме нас,
 * и без этой проверки каждый остаётся на той версии, которую однажды скачал.
 *
 * **Что уходит.** Обычный GET к списку релизов на GitHub. Ни токена, ни
 * заголовков о человеке, ни сведений о ядре: в запросе нет ничего, кроме
 * адреса. Ответ — открытый JSON, который любой может посмотреть в браузере.
 *
 * **Когда.** Только по нажатию или раз в сутки, если человек это включил.
 * Само по себе приложение не проверяет ничего и никогда: обещание «ядро само
 * никуда не ходит» не должно превращаться в «кроме тех случаев, когда ходит».
 */
const RELEASES = 'https://api.github.com/repos/bigtaed-sys/axon/releases/latest';

/** Как часто проверять, если проверка включена. */
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface Release {
  /** Номер без ведущей `v`: `2026.8.29`. */
  version: string;
  /** Страница релиза — её и открываем, а не качаем файл сами. */
  url: string;
  /** Заголовок релиза, если он есть. */
  title: string;
}

/**
 * Есть ли версия новее текущей.
 *
 * `null` — новее нет, либо ответ не разобрался. Отличать «нет обновлений» от
 * «не дозвонились» здесь не нужно: и то и другое означает «делать нечего», а
 * ошибка сети в углу окна — это шум, на который человек не может ответить.
 */
export async function checkForUpdate(current: string): Promise<Release | null> {
  try {
    const response = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;

    const body = (await response.json()) as { tag_name?: string; html_url?: string; name?: string };
    const tag = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
    if (!tag || !body.html_url) return null;

    // Сборка из середины работы (`2026.8.29-4-g1a2b3c`) новее выпущенного
    // тега, и предлагать ей «обновиться» назад было бы издевательством.
    return compareVersions(tag, current) > 0
      ? { version: tag, url: body.html_url, title: body.name || `Axon ${tag}` }
      : null;
  } catch {
    return null;
  }
}

const SETTING = 'axon.updates.daily';
const CHECKED = 'axon.updates.checkedAt';

/** Спрашивать ли раз в сутки. Выключено, пока человек не согласился. */
export function dailyChecks(): boolean {
  return localStorage.getItem(SETTING) === 'true';
}

export function setDailyChecks(enabled: boolean): void {
  localStorage.setItem(SETTING, String(enabled));
}

/**
 * Пора ли проверить.
 *
 * Отметка времени пишется до запроса, а не после: иначе выключенная сеть
 * заставляла бы приложение стучаться при каждом запуске.
 */
export function dueForCheck(): boolean {
  if (!dailyChecks()) return false;

  const last = Number(localStorage.getItem(CHECKED) ?? 0);
  if (Number.isFinite(last) && Date.now() - last < DAY_MS) return false;

  localStorage.setItem(CHECKED, String(Date.now()));
  return true;
}
