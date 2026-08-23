import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell } from 'electron';
import * as autostart from './autostart.js';
import { ConnectionManager, type Connection } from './connection.js';
import { policy } from './csp.js';

const here = __dirname;

/**
 * `standard` — чтобы работали относительные пути и origin (без него `'self'` в
 * политике не значит ничего), `secure` — чтобы страница считалась защищённой:
 * иначе Chromium запретит ей часть возможностей как обычному http.
 */
const RENDERER_SCHEME = 'axon';
protocol.registerSchemesAsPrivileged([
  { scheme: RENDERER_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let window: BrowserWindow | null = null;
let connections: ConnectionManager | null = null;
let startupError: string | null = null;

/**
 * Правка в полях ввода: вставка, копирование, отмена.
 *
 * В Electron это не даётся само. Горячие клавиши правки живут в меню
 * приложения, а у нас своя полоса заголовка (`titleBarStyle: 'hidden'`) —
 * значит, на Windows строки меню нет вовсе, и вешать ускорители не на что.
 * Снаружи это выглядит как сломанное поле: набрать можно, вставить нельзя.
 * Длинный токен руками не набирают.
 *
 * Поэтому на macOS оставляем настоящее меню — там оно и положено, и работает,
 * — а на Windows и Linux перехватываем клавиши сами. Разводить их обязательно:
 * если сработают оба пути, вставка случится дважды.
 */
function installEditing(target: BrowserWindow): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ]),
    );
  } else {
    // Меню нет — и не должно быть: пустая строка над своим заголовком.
    Menu.setApplicationMenu(null);
    installShortcuts(target);
  }

  installContextMenu(target);
}

/**
 * Свой разбор Ctrl+V и соседей.
 *
 * `before-input-event` приходит до того, как окно решит, что делать с
 * клавишей, и не зависит ни от меню, ни от рамки окна. Вызываем методы
 * `webContents`, а не подсовываем текст в поле: они работают с настоящим
 * буфером обмена и с любым полем, включая те, что ещё не написаны.
 *
 * `preventDefault` обязателен. Без него страница обрабатывает ту же клавишу
 * сама, и вставка случается дважды — в поле оказывается ключ, склеенный сам с
 * собой. Выглядит это не как двойная вставка, а как «ключ сохранён, но не
 * работает»: ядро исправно хранит то, что ему дали.
 */
function installShortcuts(target: BrowserWindow): void {
  target.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!input.control && !input.meta) return;
    if (input.alt) return;

    const contents = target.webContents;
    switch (input.key.toLowerCase()) {
      case 'v':
        contents.paste();
        break;
      case 'c':
        contents.copy();
        break;
      case 'x':
        contents.cut();
        break;
      case 'a':
        contents.selectAll();
        break;
      case 'z':
        if (input.shift) contents.redo();
        else contents.undo();
        break;
      case 'y':
        contents.redo();
        break;
      default:
        return;
    }

    event.preventDefault();
  });
}

/**
 * Правая кнопка в поле ввода.
 *
 * Своего контекстного меню Electron не рисует вовсе, а это второй способ,
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

/** Типы файлов рендерера. Их немного и они известны: сборка Vite плюс шрифты. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Своя схема для рендерера: `axon://app/index.html` вместо `file://`.
 *
 * Нужна ради политики безопасности. Политика зависит от того, к какому ядру мы
 * подключены, а `<meta>` в статическом index.html зависеть ни от чего не
 * может: она читается при разборе документа. Значит, политика должна приехать
 * заголовком — а заголовков у `file://` нет вовсе.
 *
 * Своя схема, а не перехват `file://`: подменять его целиком значит брать на
 * себя всё, что Chromium делает с локальными файлами — докачку по диапазонам,
 * кэширование, внутренние загрузки. Здесь же ровно один каталог со сборкой.
 */
function serveRenderer(): void {
  const root = path.join(here, '../renderer');

  protocol.handle(RENDERER_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const file = path.join(root, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));

    // Ссылка приходит из нашей же страницы, но проверка стоит трёх строк:
    // `..` в пути превратил бы окно в файловый менеджер.
    if (!file.startsWith(root)) return new Response('нельзя', { status: 403 });

    let data: Buffer;
    try {
      data = await fs.promises.readFile(file);
    } catch {
      return new Response('нет такого файла', { status: 404 });
    }

    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'content-type': type };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = policy(connections?.connection?.url ?? null);
    }
    return new Response(new Uint8Array(data), { headers });
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

  installEditing(window);

  window.once('ready-to-show', () => window?.show());

  /**
   * Упавший рендерер — это чёрное окно или его отсутствие, и больше ничего.
   * Без записи в файл про такое можно только гадать: главный процесс жив,
   * ошибок не печатает, а приложения нет.
   */
  window.webContents.on('render-process-gone', (_event, details) => {
    logStartupFailure('рендерер', new Error(`${details.reason}, код ${details.exitCode ?? '—'}`));
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3) return; // отменённая загрузка — не отказ
    logStartupFailure('загрузка окна', new Error(`${description} (${code}) ${url}`));
  });

  // Внешние ссылки — в браузер: окно приложения не должно уезжать на сайт.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env['AXON_DEV_SERVER'];
  if (devServer) {
    // В разработке страницу отдаёт Vite по http, и политики на ней нет: строгая
    // ломает горячую перезагрузку, которая живёт на встроенном скрипте. Electron
    // об этом честно ругается в консоли — в собранном приложении политика есть.
    void window.loadURL(devServer);
  } else {
    void window.loadURL(`${RENDERER_SCHEME}://app/index.html`);
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
    serveRenderer();
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

/**
 * Сменилось ядро — перезагрузить окно.
 *
 * Политика безопасности уезжает заголовком вместе с документом: другое ядро —
 * другой источник, и разрешить его на лету нельзя. Перезагрузка не теряет
 * ничего: состояние живёт в ядре, а рендерер поднимает его снапшотом.
 *
 * Небольшая задержка — чтобы ответ на вызов успел уйти в рендерер: иначе
 * `connectRemote` вернётся в перезагружаемое окно и вызов повиснет.
 */
function reloadOnCoreChange(before: string | null): void {
  if ((connections?.connection?.url ?? null) === before) return;
  setTimeout(() => window?.reload(), 50);
}

/** Переключиться на своё ядро. */
ipcMain.handle('axon:use-embedded', async (): Promise<Connection> => {
  const before = connections?.connection?.url ?? null;
  const connection = await connections!.useEmbedded();
  startupError = null;
  reloadOnCoreChange(before);
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
    const before = connections?.connection?.url ?? null;
    const connection = await connections!.connectRemote(input);
    startupError = null;
    reloadOnCoreChange(before);
    return connection;
  },
);

/** Жив ли адрес — проверяем до ввода кода, чтобы не гадать. */
ipcMain.handle('axon:probe', async (_event, url: string) => connections!.probe(url));

ipcMain.handle('axon:forget-remote', async (): Promise<Connection> => {
  const before = connections?.connection?.url ?? null;
  const connection = await connections!.forgetRemote();
  startupError = null;
  reloadOnCoreChange(before);
  return connection;
});

/**
 * Кнопки окна рисует не мы, а система — их цвет задаётся отсюда. Поэтому при
 * смене темы рендерер присылает актуальные цвета: иначе управляющие кнопки
 * остаются от прошлой темы и выбиваются из шапки.
 */
/**
 * Выбрать папку с плагином.
 *
 * Единственное, ради чего понадобился системный диалог: путь к папке рендерер
 * узнать не может — в вебе такого нет и быть не должно.
 *
 * Имеет смысл только для ядра на этой же машине. У ядра на сервере своя
 * файловая система, и выбранный здесь путь там ничего не значит — поэтому
 * окно спрашивает про это до того, как покажет кнопку.
 */
ipcMain.handle('axon:pick-folder', async (): Promise<string | null> => {
  if (!window) return null;

  const chosen = await dialog.showOpenDialog(window, {
    title: 'Папка с плагином',
    properties: ['openDirectory'],
    buttonLabel: 'Выбрать',
  });

  return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
});

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
