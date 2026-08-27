import { LocalNotifications } from '@capacitor/local-notifications';

/**
 * Системные уведомления на телефоне.
 *
 * Веб-уведомлений в Android WebView нет вовсе — тот способ, которым живёт
 * десктоп, здесь просто не существует. Поэтому системные, через оболочку.
 *
 * **Чего они не умеют.** Соединение с ядром держит само приложение, поэтому
 * закрытое оно ничего не получает: инициатива агента доходит, пока приложение
 * живо — открыто или свёрнуто. Доставка в любой момент требует либо
 * пуш-сервера, либо службы, которая держит соединение и висит в шторке
 * постоянным значком. Ни то ни другое не бесплатно: первое — чужой сервер в
 * середине, второе — вечно работающий процесс и разряженная батарея.
 */

/**
 * Два канала: обычный и тихий.
 *
 * На Android громкость уведомления — свойство канала, а не самого уведомления:
 * попросить «то же самое, но без звука» в отдельном сообщении нельзя. Тихий
 * канал нужен рутинам, отработавшим штатно: сказать о них стоит, будить ради
 * них — нет.
 *
 * Заодно человек получает два переключателя в настройках системы вместо
 * одного и может заглушить рутины, оставив голос агента.
 */
const LOUD = 'axon';
const QUIET = 'axon-quiet';

let ready: Promise<boolean> | null = null;

/**
 * Разрешение спрашивается один раз, при первом уведомлении.
 *
 * Не при запуске: спрашивать до того, как случилось что-то стоящее
 * уведомления, значит просить доверия авансом — и получать отказ.
 */
function prepare(): Promise<boolean> {
  ready ??= (async () => {
    try {
      const current = await LocalNotifications.checkPermissions();
      const decision =
        current.display === 'granted' ? current : await LocalNotifications.requestPermissions();
      if (decision.display !== 'granted') return false;

      await LocalNotifications.createChannel({
        id: LOUD,
        name: 'Axon',
        description: 'Когда агент написал сам',
        importance: 4,
      });
      await LocalNotifications.createChannel({
        id: QUIET,
        name: 'Рутины',
        description: 'Отработавшие задачи по расписанию',
        importance: 2,
      });
      return true;
    } catch {
      // Оболочки нет — страница открыта в обычном браузере. Не повод падать.
      return false;
    }
  })();

  return ready;
}

export function notify(input: { title: string; body: string; silent?: boolean }): void {
  void (async () => {
    if (!(await prepare())) return;

    await LocalNotifications.schedule({
      notifications: [
        {
          // Идентификатор обязан быть числом и не повторяться: одинаковые
          // система схлопывает в одно, и второе сообщение агента молча
          // заменило бы первое.
          id: Date.now() % 2_147_483_647,
          title: input.title,
          body: input.body,
          channelId: input.silent ? QUIET : LOUD,
        },
      ],
    }).catch(() => undefined);
  })();
}
