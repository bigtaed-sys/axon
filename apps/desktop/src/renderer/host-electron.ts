import { setHost, type Connection, type CoreProbe, type AutostartState } from '@axon/ui';

/**
 * Хозяин окна в Electron — тонкая обёртка над мостом из preload.
 *
 * Единственный файл рендерера, который знает про Electron. Всё, что здесь
 * появится сверх перевода вызовов, окажется возможностью, которой нет у
 * телефона, — и об этом стоит подумать дважды.
 */
interface AxonBridge {
  connection(): Promise<{ connection: Connection | null; error: string | null }>;
  useEmbedded(): Promise<Connection>;
  setExposed(expose: boolean): Promise<Connection>;
  connectRemote(input: { url: string; code: string; name: string }): Promise<Connection>;
  probe(url: string): Promise<CoreProbe>;
  forgetRemote(): Promise<Connection>;
  localStatus(): Promise<{ running: boolean }>;
  stopLocal(): Promise<boolean>;
  restartLocal(): Promise<Connection>;
  autostart(): Promise<AutostartState>;
  setAutostart(enable: boolean): Promise<AutostartState>;
  pickFolder?(): Promise<string | null>;
  titlebar?(colors: { color: string; symbolColor: string }): Promise<void>;
}

declare global {
  interface Window {
    axon?: AxonBridge;
  }
}

/** `false` — окно открыто не в Electron; звать было некого. */
export function installElectronHost(): boolean {
  const bridge = window.axon;
  if (!bridge) return false;

  setHost({
    app: { version: __APP_VERSION__, builtAt: __APP_BUILT_AT__ },
    connection: () => bridge.connection(),
    connectRemote: (input) => bridge.connectRemote(input),
    probe: (url) => bridge.probe(url),
    forgetRemote: () => bridge.forgetRemote(),

    local: {
      // Открытость в сеть и выбор своего ядра — одно действие: доступность
      // задаётся адресом прослушивания, а он выбирается при запуске.
      use: (options) =>
        options?.expose === undefined
          ? bridge.useEmbedded()
          : bridge.setExposed(options.expose),
      status: () => bridge.localStatus(),
      stop: () => bridge.stopLocal(),
      restart: () => bridge.restartLocal(),
      autostart: () => bridge.autostart(),
      setAutostart: (enable) => bridge.setAutostart(enable),
    },

    ...(bridge.titlebar ? { titlebar: (colors) => void bridge.titlebar?.(colors) } : {}),
    ...(bridge.pickFolder ? { pickFolder: () => bridge.pickFolder!() } : {}),
  });

  return true;
}
