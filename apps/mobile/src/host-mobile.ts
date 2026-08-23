import { setHost, type Connection, type CoreProbe } from '@axon/ui';

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

/** Адрес без хвоста: человек копирует его из консоли вместе со слэшем и текстом. */
function normalize(input: string): string {
  const text = input.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(text) ? text : `http://${text}`;
}

export function installMobileHost(app: { version: string; builtAt: string }): void {
  setHost({
    app,

    connection: async () => ({ connection: load(), error: null }),

    probe: async (url) => {
      const response = await fetch(`${normalize(url)}/health`).catch(() => null);
      if (!response?.ok) throw new Error('Ядро не отвечает по этому адресу');
      return (await response.json()) as CoreProbe;
    },

    connectRemote: async ({ url, code, name }) => {
      const target = normalize(url);
      const response = await fetch(`${target}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase(), name, platform: 'mobile' }),
      }).catch(() => {
        throw new Error(`Не удалось достучаться до ${target}. Проверьте адрес и что ядро запущено.`);
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
