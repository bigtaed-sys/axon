import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import iconv from 'iconv-lite';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types.js';
import type { PathGuard } from './paths.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
/** Сколько вывода вообще забирать из процесса. */
const MAX_OUTPUT_BYTES = 512 * 1024;

export function createShellTools(guard: PathGuard): ToolDefinition[] {
  const run = defineTool({
    name: 'run_shell',
    title: 'Выполнить команду',
    description:
      'Выполнить команду в системной оболочке и вернуть её вывод. Вызывай, когда ' +
      'задачу решает готовая утилита: git, сборка, тесты, обработка файлов. ' +
      'Для чтения и записи файлов есть отдельные инструменты — они безопаснее и ' +
      'понятнее. Каждый вызов требует подтверждения пользователя.',
    tier: 'dangerous',
    source: 'builtin',
    previewLimit: 6_000,
    schema: z.object({
      command: z.string().min(1).describe('Команда целиком, как в терминале'),
      cwd: z.string().optional().describe('Рабочая папка; по умолчанию домашняя'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(MAX_TIMEOUT_MS)
        .optional()
        .describe(`Потолок времени, по умолчанию ${DEFAULT_TIMEOUT_MS} мс`),
    }),
    async execute({ command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }, ctx) {
      // Рабочая папка проходит ту же проверку, что и файловые операции:
      // без неё команда стартует где угодно, и ограничение папок — фикция.
      const workdir = cwd ? guard.resolve(cwd) : os.homedir();

      const result = await runCommand({ command, cwd: workdir, timeoutMs, signal: ctx.signal });

      const parts: string[] = [];
      if (result.stdout) parts.push(result.stdout);
      if (result.stderr) parts.push(`--- stderr ---\n${result.stderr}`);
      parts.push(`--- код возврата: ${result.code} ---`);

      return { text: parts.join('\n') };
    },
  });

  return [run];
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Запуск команды.
 *
 * Три вещи, без которых инструмент опасен не тем, чем кажется: потолок
 * времени (иначе `npm install` подвесит прогон), потолок вывода (иначе
 * `find /` съест память процесса) и убийство дерева процессов по таймауту —
 * оболочка порождает детей, и убийство только её оставляет их работать.
 */
function runCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    // Копим байты, а не строки. Декодировать каждый кусок отдельно нельзя:
    // многобайтовый символ спокойно разрывается по границе чанка, и на месте
    // разрыва получается мусор даже в UTF-8.
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const kill = (): void => {
      if (isWindows && child.pid) {
        // taskkill /T — иначе выживут внуки, порождённые оболочкой.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        child.kill('SIGKILL');
      }
    };

    const timeoutError = new Error(
      `Команда не уложилась в ${input.timeoutMs} мс и была остановлена`,
    );
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;

    // По таймауту не отвечаем сразу, а ждём фактической смерти дерева
    // процессов. Иначе «команда остановлена» — неправда: процесс ещё жив,
    // держит рабочую папку и файлы, и следующая же операция об это спотыкается.
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      kill();
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(timeoutError);
      }, 3000);
    }, input.timeoutMs);

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      const error = new Error('Вызов отменён');
      error.name = 'AbortError';
      reject(error);
    };
    input.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= MAX_OUTPUT_BYTES) return;
      stdout.push(chunk);
      stdoutBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= MAX_OUTPUT_BYTES) return;
      stderr.push(chunk);
      stderrBytes += chunk.length;
    });

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      reject(e);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      input.signal.removeEventListener('abort', onAbort);

      if (timedOut) return reject(timeoutError);

      resolve({
        stdout: decodeOutput(Buffer.concat(stdout)).trimEnd(),
        stderr: decodeOutput(Buffer.concat(stderr)).trimEnd(),
        code,
      });
    });
  });
}

/**
 * Декодирование вывода команды.
 *
 * На Windows cmd.exe пишет в OEM-кодировке — на русской системе это CP866, и
 * `chcp 65001` тут не помогает: кодовая страница меняется, а `echo` всё равно
 * отдаёт старые байты. Поэтому сначала пробуем UTF-8 (современные утилиты
 * пишут в нём), и только если получился мусор — разбираем как OEM.
 *
 * Признак мусора надёжный: корректный UTF-8 никогда не даёт U+FFFD.
 */
function decodeOutput(buffer: Buffer): string {
  if (buffer.length === 0) return '';

  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�') || process.platform !== 'win32') return utf8;

  const codepage = oemCodepage();
  return codepage && iconv.encodingExists(codepage) ? iconv.decode(buffer, codepage) : utf8;
}

let cachedCodepage: string | null | undefined;

/** Активная кодовая страница консоли. Спрашиваем систему один раз. */
function oemCodepage(): string | null {
  if (cachedCodepage !== undefined) return cachedCodepage;

  try {
    const result = spawnSync('chcp', { shell: true, windowsHide: true, encoding: 'latin1' });
    // Вывод локализован («Active code page: 866» / «Текущая кодовая
    // страница: 866»), поэтому берём последнее число, а не разбираем текст.
    const match = /(\d{3,5})\s*$/.exec((result.stdout ?? '').trim());
    cachedCodepage = match ? `cp${match[1]}` : null;
  } catch {
    cachedCodepage = null;
  }
  return cachedCodepage;
}
