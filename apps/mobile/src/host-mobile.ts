import { setHost, type Connection, type CoreProbe } from '@axon/ui';
import { notify } from './notify.js';

/**
 * Хозяин окна на телефоне.
 *
 * Своего ядра здесь нет: телефон — это окно к ядру, которое стоит дома или на
 * сервере. Поэтому вся платформа сводится к одному — помнить, к какому ядру
 * подключены, и уметь обменять код на токен.
 *
 * Обмен делается прямо отсюда, а не через ядро приложения (его нет), поэтому
 * ядро обязано разрешать этот запрос с чужого источника — см. CORS в Daemon.
 */
const STORAGE_KEY = 'axon.connection';

function load(): Connection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Connection;
    // Токен без адреса (или наоборот) — обломок прошлой версии, а не
    // подключение: лучше показать экран подключения, чем стучаться в пустоту.
    return saved.url && saved.token ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Почему не дозвонились.
 *
 * Телефон обрывает такие запросы в трёх разных местах — система не пускает
 * незашифрованный трафик, не пускает в локальную сеть, или до ядра просто нет
 * дороги, — и во всех случаях браузер отдаёт одно и то же пустое «failed to
 * fetch». Различить их из приложения нельзя, поэтому честнее показать всё
 * сразу: одна из трёх строчек окажется той самой, и человек проверит её сам,
 * вместо того чтобы гадать.
 */
function unreachable(target: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return [
    `Не удалось достучаться до ${target} (${reason}).`,
    '',
    `1. Откройте ${target}/health в браузере телефона. Не отвечает — дело в сети:`,
    '   ядро слушает только себя (нужен axon start --host 0.0.0.0) или запросы',
    '   не пускает файрвол той машины.',
    '2. Разрешение «устройства поблизости» в настройках приложения — без него',
    '   свежие Android не пускают в локальную сеть вовсе.',
    '3. Адрес — тот, что печатает само ядро при запуске, вместе с портом.',
  ].join('\n');
}

/** Адрес без хвоста: человек копирует его из консоли вместе со слэшем и текстом. */
function normalize(input: string): string {
  const text = input.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(text) ? text : `http://${text}`;
}

export function installMobileHost(app: { version: string; builtAt: string }): void {
  setHost({
    app,
    notify,

    connection: async () => ({ connection: load(), error: null }),

    probe: async (url) => {
      const target = normalize(url);
      const response = await fetch(`${target}/health`).catch((error: unknown) => {
        throw new Error(unreachable(target, error));
      });
      if (!response.ok) throw new Error(`Ядро ответило ошибкой ${response.status}`);
      return (await response.json()) as CoreProbe;
    },

    connectRemote: async ({ url, code, name }) => {
      const target = normalize(url);
      const response = await fetch(`${target}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase(), name, platform: 'mobile' }),
      }).catch((error: unknown) => {
        throw new Error(unreachable(target, error));
      });

      if (response.status === 403) {
        throw new Error(
          'Код неверен или уже использован. Новый выдаёт ядро: axon code на той машине, где оно запущено',
        );
      }
      if (!response.ok) throw new Error(`Ядро ответило ошибкой ${response.status}`);

      const paired = (await response.json()) as { token: string };
      const connection: Connection = {
        mode: 'remote',
        url: target,
        token: paired.token,
        label: new URL(target).host,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(connection));
      return connection;
    },
  });
}
