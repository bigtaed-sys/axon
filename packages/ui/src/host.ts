/**
 * Хозяин окна — всё, чего нельзя сделать по протоколу Axon.
 *
 * Таких вещей ровно две: выбор ядра, к которому подключаться (протокол
 * начинается уже после выбора), и обращение к самому устройству — окно,
 * автозапуск, выбор папки. Всё остальное интерфейс делает через протокол и
 * потому одинаково везде.
 *
 * Это разделение придумано не ради красоты. Приложение на телефоне —
 * тот же интерфейс, подключённый к тому же ядру; отличается он ровно тем, что
 * здесь. Пока рендерер звал `window.axon` напрямую, перенести его было
 * невозможно: Electron сидел в каждом экране.
 *
 * Своё ядро вынесено в отдельную необязательную часть намеренно. На телефоне
 * его нет и быть не может, и `local === undefined` заставляет интерфейс
 * считаться с этим на уровне типов, а не «забыть спрятать» вкладку.
 */

export interface Connection {
  mode: 'embedded' | 'remote';
  url: string;
  token: string;
  label?: string;
  /** Своё ядро открыто для устройств из локальной сети. */
  exposed?: boolean;
  /** Адреса, которые нужно набрать на другом устройстве. */
  lan?: string[];
}

/** Что ядро отвечает о себе до подключения — чтобы не вводить код вслепую. */
export interface CoreProbe {
  coreId: string;
  version: string;
  devices: number;
}

export interface AutostartState {
  supported: boolean;
  enabled: boolean;
}

/** Своё ядро рядом с приложением. Есть на компьютере, нет на телефоне. */
export interface LocalCoreHost {
  /** Переключиться на своё ядро, подняв его при необходимости. */
  use(options?: { expose?: boolean }): Promise<Connection>;
  status(): Promise<{ running: boolean }>;
  stop(): Promise<boolean>;
  restart(): Promise<Connection>;
  autostart(): Promise<AutostartState>;
  setAutostart(enable: boolean): Promise<AutostartState>;
}

/**
 * Само приложение: что показывать в «О программе» и с чем сверять версию ядра.
 *
 * Приходит от платформы, а не подставляется при сборке интерфейса: у десктопа
 * и телефона версии свои, а интерфейс один.
 */
export interface AppInfo {
  version: string;
  /** Когда собрано, ISO-8601. */
  builtAt: string;
}

export interface Host {
  app: AppInfo;
  /** Куда подключаться сейчас и почему не вышло, если не вышло. */
  connection(): Promise<{ connection: Connection | null; error: string | null }>;
  /** Обменять код на токен и запомнить чужое ядро. */
  connectRemote(input: { url: string; code: string; name: string }): Promise<Connection>;
  probe(url: string): Promise<CoreProbe>;

  local?: LocalCoreHost;
  /**
   * Сказать человеку то, чего он не ждёт.
   *
   * Когда сказать — решает общий код: агент написал сам, рутина отработала. А
   * чем сказать — у каждой платформы своё: в окне на компьютере это
   * уведомление браузера, на телефоне — системное, которого в WebView нет
   * вовсе. Без разделения телефон молчал бы в пустоту именно в том случае,
   * ради которого уведомления и нужны: когда человек не смотрит на экран.
   */
  notify?(input: { title: string; body: string; silent?: boolean }): void;
  /** Цвет системных кнопок окна — только там, где окно рисуем мы. */
  titlebar?(colors: { color: string; symbolColor: string }): void;
  /** Выбрать папку с плагином. `null` — человек передумал. */
  pickFolder?(): Promise<string | null>;
}

let current: Host | null = null;

/** Вызывается один раз при запуске, до первой отрисовки. */
export function setHost(next: Host): void {
  current = next;
}

/**
 * Текущий хозяин окна.
 *
 * Бросает, если его забыли задать: молчаливая заглушка превратила бы «забыли
 * подключить платформу» в «кнопки ничего не делают», а это самый дорогой вид
 * поломки — тот, который не видно.
 */
export function host(): Host {
  if (!current) throw new Error('Платформа не задана: setHost не вызван при запуске');
  return current;
}
