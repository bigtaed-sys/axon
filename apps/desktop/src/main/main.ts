import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import * as autostart from './autostart.js';
import { ConnectionManager, type Connection } from './connection.js';

const here = __dirname;

let window: BrowserWindow | null = null;
let connections: ConnectionManager | null = null;
let startupError: string | null = null;

/**
 * Меню правки — без него не работает вставка.
 *
 * В Electron горячие клавиши правки живут не в поле ввода, а в меню
 * приложения: Ctrl+V, Ctrl+C, Ctrl+A и Ctrl+Z существуют ровно постольку,
 * поскольку в меню есть пункты с соответствующими ролями. Приложение без
 * меню выглядит обычным, пока человек не попробует вставить в поле пароль
 * или ключ — и не сможет. Ввести руками длинный токен не предложишь.
 *
 * Само меню при этом не показывается: полоса заголовка у нас своя, и
 * системная строка меню в неё не вписывается. Скрытая полоса ускорителей не
 * отменяет — это разные вещи.
 */
function installEditMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'editMenu' },
      // Перезагрузка и инструменты разработчика: в собранном приложении
      // единственный способ посмотреть, что случилось в окне.
      {
        label: 'Вид',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
    ]),
  );
}

/**
 * Правая кнопка в поле ввода.
 *
 * Своего контекстного меню Electron не рисует вовсе, и это второй способ,
 * которым человек пытается вставить текст. Не найдя ни горячей клавиши, ни
 * правой кнопки, он решает, что поле сломано, — и будет прав.
 */
function installContextMenu(target: BrowserWindow): void {
  target.webContents.on('context-menu', (_event, params) => {
    const editable = params.isEditable;
    const selected = params.selectionText.trim().length > 0;
    if (!editable && !selected) return;

    Menu.buildFromTemplate([
      { role: 'cut', label: 'Вырезать', enabled: editable && selected },
      { role: 'copy', label: 'Копировать', enabled: selected },
      { role: 'paste', label: 'Вставить', enabled: editable },
      { type: 'separator' },
      { role: 'selectAll', label: 'Выделить всё', enabled: editable },
    ]).popup({ window: target });
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0b0d',
    // Своя полоса заголовка: системная в тёмной теме выбивается из окна.
    // Цвета — стартовые; дальше их присылает рендерер под выбранную тему.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#141418', symbolColor: '#a0a0ac', height: 48 },
    show: false,
    // Полоса меню скрыта, а само меню есть: иначе исчезнут ускорители правки.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.setMenuBarVisibility(false);
  installContextMenu(window);

  window.once('ready-to-show', () => window?.show());

  // Внешние ссылки — в браузер: окно приложения не должно уезжать на сайт.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env['AXON_DEV_SERVER'];
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(here, '../renderer/index.html'));
  }
}

/**
 * Записать причину падения рядом с данными приложения.
 *
 * В собранном приложении консоли нет: упавший до создания окна процесс просто
 * исчезает, и снаружи это неотличимо от «не запускается». Один файл рядом с
 * данными превращает такой отказ в починяемый.
 */
function logStartupFailure(stage: string, error: unknown): void {
  const text =
    `[${new Date().toISOString()}] ${stage}: ` +
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`;

  process.stderr.write(text);
  try {
    const file = path.join(app.getPath('userData'), 'startup-error.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
  } catch {
    // Писать некуда — остаётся только stderr, который уже написан.
  }
}

process.on('uncaughtException', (error) => logStartupFailure('необработанная ошибка', error));

// Второй экземпляр приложения поднял бы второе ядро на той же базе.
// Вместо этого показываем уже открытое окно.
if (!app.requestSingleInstanceLock()) {
  // Молча выйти здесь — значит оставить человека с приложением, которое
  // «не запускается»: окно уже открыто, но, например, на другом рабочем столе.
  process.stderr.write('Axon уже запущен — показываю открытое окно\n');
  // `quit` не прерывает выполнение сам по себе: без выхода отсюда второй
  // экземпляр успевал бы навесить обработчики и полезть в те же файлы.
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(async () => {
  installEditMenu();

  try {
    connections = new ConnectionManager(app.getPath('userData'));
  } catch (e) {
    logStartupFailure('подключение', e);
    startupError = (e as Error).message;
  }

  try {
    await connections?.start();
  } catch (e) {
    // Окно всё равно показываем: пустое приложение без объяснения хуже,
    // чем приложение, которое честно говорит, что пошло не так.
    startupError = (e as Error).message;
    logStartupFailure('запуск ядра', e);
  }

  try {
    createWindow();
  } catch (e) {
    // Без окна приложения нет вовсе — здесь только записать и выйти.
    logStartupFailure('создание окна', e);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ─── Мост в рендерер ────────────────────────────────────────────────────────

ipcMain.handle('axon:connection', () => ({
  connection: connections?.connection ?? null,
  error: startupError,
}));

/** Переключиться на своё ядро. */
ipcMain.handle('axon:use-embedded', async (): Promise<Connection> => {
  const connection = await connections!.useEmbedded();
  startupError = null;
  return connection;
});

/** Открыть или закрыть своё ядро для устройств из локальной сети. */
ipcMain.handle('axon:set-exposed', async (_event, expose: boolean): Promise<Connection> => {
  const connection = await connections!.useEmbedded({ expose });
  startupError = null;
  return connection;
});

/** Обменять код на токен и переключиться на чужое ядро. */
ipcMain.handle(
  'axon:connect-remote',
  async (_event, input: { url: string; code: string; name: string }): Promise<Connection> => {
    const connection = await connections!.connectRemote(input);
    startupError = null;
    return connection;
  },
);

/** Жив ли адрес — проверяем до ввода кода, чтобы не гадать. */
ipcMain.handle('axon:probe', async (_event, url: string) => connections!.probe(url));

ipcMain.handle('axon:forget-remote', async (): Promise<Connection> => {
  const connection = await connections!.forgetRemote();
  startupError = null;
  return connection;
});

/**
 * Кнопки окна рисует не мы, а система — их цвет задаётся отсюда. Поэтому при
 * смене темы рендерер присылает актуальные цвета: иначе управляющие кнопки
 * остаются от прошлой темы и выбиваются из шапки.
 */
ipcMain.handle('axon:titlebar', (_event, colors: { color: string; symbolColor: string }) => {
  if (!window || window.isDestroyed()) return;
  window.setTitleBarOverlay({ ...colors, height: 48 });
});

/** Ядро на этой машине: работает ли и можно ли его остановить отсюда. */
ipcMain.handle('axon:local-status', async () => ({
  running: await connections!.localRunning(),
}));

ipcMain.handle('axon:stop-local', () => connections!.stopLocal());

ipcMain.handle('axon:restart-local', async (): Promise<Connection> => {
  const connection = await connections!.restartLocal();
  return connection;
});

/** Автозапуск ядра при входе в систему. */
ipcMain.handle('axon:autostart', () => ({
  supported: autostart.isSupported(),
  enabled: autostart.isEnabled(),
}));

ipcMain.handle('axon:set-autostart', (_event, enable: boolean) => {
  if (enable) autostart.enable(connections!.autostartTarget());
  else autostart.disable();
  return { supported: autostart.isSupported(), enabled: autostart.isEnabled() };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Ядро при выходе не останавливаем: оно самостоятельная программа, и агент
// должен продолжать работать после закрытия окна.
