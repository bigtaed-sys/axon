import { contextBridge, ipcRenderer } from 'electron';

interface Connection {
  mode: 'embedded' | 'remote';
  url: string;
  token: string;
  label?: string;
  exposed?: boolean;
  lan?: string[];
}

/**
 * Мост в рендерер: всё, что нельзя сделать по протоколу Axon.
 *
 * Это ровно две вещи — выбор ядра, к которому подключаться, и цвет системных
 * кнопок окна. Всё остальное рендерер делает сам через протокол, ровно как
 * это будет делать мобильное приложение. Если бы десктоп ходил в ядро через
 * IPC в обход протокола, он бы медленно оброс возможностями, которых нет у
 * других клиентов.
 */
contextBridge.exposeInMainWorld('axon', {
  connection: (): Promise<{ connection: Connection | null; error: string | null }> =>
    ipcRenderer.invoke('axon:connection'),

  useEmbedded: (): Promise<Connection> => ipcRenderer.invoke('axon:use-embedded'),

  setExposed: (expose: boolean): Promise<Connection> =>
    ipcRenderer.invoke('axon:set-exposed', expose),

  connectRemote: (input: { url: string; code: string; name: string }): Promise<Connection> =>
    ipcRenderer.invoke('axon:connect-remote', input),

  probe: (url: string): Promise<{ coreId: string; version: string; devices: number }> =>
    ipcRenderer.invoke('axon:probe', url),

  forgetRemote: (): Promise<Connection> => ipcRenderer.invoke('axon:forget-remote'),

  localStatus: (): Promise<{ running: boolean }> => ipcRenderer.invoke('axon:local-status'),

  stopLocal: (): Promise<boolean> => ipcRenderer.invoke('axon:stop-local'),

  restartLocal: (): Promise<Connection> => ipcRenderer.invoke('axon:restart-local'),

  autostart: (): Promise<{ supported: boolean; enabled: boolean }> =>
    ipcRenderer.invoke('axon:autostart'),

  setAutostart: (enable: boolean): Promise<{ supported: boolean; enabled: boolean }> =>
    ipcRenderer.invoke('axon:set-autostart', enable),

  /** Выбрать папку с плагином. `null` — человек передумал. */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('axon:pick-folder'),

  titlebar: (colors: { color: string; symbolColor: string }): Promise<void> =>
    ipcRenderer.invoke('axon:titlebar', colors),
});
