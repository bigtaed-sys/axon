import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logger } from '../src/logger.js';
import { createFileTools } from '../src/tools/builtin/files.js';
import { createShellTools } from '../src/tools/builtin/shell.js';
import { PathGuard } from '../src/tools/builtin/paths.js';
import { ToolExecutor } from '../src/tools/ToolExecutor.js';
import { ToolRegistry } from '../src/tools/ToolRegistry.js';
import type { ToolContext } from '../src/tools/types.js';

let root: string;
let outside: string;
let registry: ToolRegistry;
let executor: ToolExecutor;

function context(signal = new AbortController().signal): ToolContext {
  return {
    conversationId: 'c1',
    runId: 'r1',
    signal,
    logger,
    requestPermission: async () => true,
  };
}

const access = { scopes: ['tools.safe', 'tools.sensitive', 'tools.dangerous'] as const };

const run = (name: string, args: unknown, ctx = context()) =>
  executor.execute({ name, args, ctx, access: { scopes: [...access.scopes] } });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-files-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-outside-'));
  fs.writeFileSync(path.join(outside, 'секрет.txt'), 'чужие данные');

  const guard = new PathGuard([root]);
  registry = new ToolRegistry();
  registry.registerAll([...createFileTools(guard), ...createShellTools(guard)]);
  executor = new ToolExecutor(registry);
});

afterEach(() => {
  // Убитый по таймауту процесс отпускает рабочую папку не мгновенно —
  // без повторов уборка спотыкается об EBUSY.
  const options = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  fs.rmSync(root, options);
  fs.rmSync(outside, options);
});

describe('ограничение папок', () => {
  it('не выпускает за пределы разрешённой папки', async () => {
    const result = await run('read_file', { path: path.join(outside, 'секрет.txt') });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/вне разрешённых папок/);
  });

  it('не выпускает через ..', async () => {
    const result = await run('read_file', {
      path: path.join(root, '..', path.basename(outside), 'секрет.txt'),
    });
    expect(result.ok).toBe(false);
  });

  it('не даёт записать наружу', async () => {
    const result = await run('write_file', {
      path: path.join(outside, 'вторжение.txt'),
      content: 'привет',
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'вторжение.txt'))).toBe(false);
  });

  it('не запускает команду в чужой папке', async () => {
    const result = await run('run_shell', { command: 'echo привет', cwd: outside });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/вне разрешённых папок/);
  });

  it('пустой список папок закрывает доступ целиком', async () => {
    const closed = new ToolRegistry();
    closed.registerAll(createFileTools(new PathGuard([])));

    const result = await new ToolExecutor(closed).execute({
      name: 'read_file',
      args: { path: path.join(root, 'что-угодно.txt') },
      ctx: context(),
      access: { scopes: [...access.scopes] },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/не настроен/);
  });
});

describe('файлы', () => {
  it('пишет и читает с номерами строк', async () => {
    const file = path.join(root, 'заметка.txt');
    const written = await run('write_file', { path: file, content: 'раз\nдва\nтри' });
    expect(written.ok).toBe(true);

    const read = await run('read_file', { path: file });
    expect(read.ok && read.preview).toContain('1\tраз');
    expect(read.ok && read.preview).toContain('3\tтри');
  });

  it('читает кусками и говорит, сколько всего строк', async () => {
    const file = path.join(root, 'длинный.txt');
    fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `строка ${i + 1}`).join('\n'));

    const read = await run('read_file', { path: file, offset: 100, limit: 5 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.preview).toContain('строка 100');
    expect(read.preview).toContain('строка 104');
    expect(read.preview).not.toContain('строка 105');
    expect(read.preview).toMatch(/из 500/);
  });

  it('у чтения свой потолок вывода — общего не хватило бы', async () => {
    const file = path.join(root, 'большой.txt');
    fs.writeFileSync(file, Array.from({ length: 300 }, () => 'x'.repeat(30)).join('\n'));

    const read = await run('read_file', { path: file, limit: 300 });
    expect(read.ok).toBe(true);
    // Общий потолок 2000 символов обрезал бы это в самом начале.
    expect(read.ok && read.preview.length).toBeGreaterThan(5_000);
  });

  it('показывает папку и находит файлы по имени', async () => {
    fs.mkdirSync(path.join(root, 'вложенная'));
    fs.writeFileSync(path.join(root, 'вложенная', 'отчёт-2026.md'), '# отчёт');
    fs.writeFileSync(path.join(root, 'прочее.txt'), 'текст');

    const list = await run('list_dir', { path: root });
    expect(list.ok && list.preview).toContain('вложенная/');
    expect(list.ok && list.preview).toContain('прочее.txt');

    const found = await run('find_files', { path: root, query: 'отчёт' });
    expect(found.ok && found.preview).toContain('отчёт-2026.md');
  });

  it('чтение папки вместо файла — понятная ошибка', async () => {
    const result = await run('read_file', { path: root });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/папка/);
  });
});

describe('оболочка', () => {
  it('возвращает вывод и код возврата', async () => {
    const result = await run('run_shell', { command: 'echo привет-из-оболочки', cwd: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview).toContain('привет-из-оболочки');
    expect(result.preview).toContain('код возврата: 0');
  });

  it('ненулевой код возврата виден модели, а не прячется', async () => {
    const command = process.platform === 'win32' ? 'exit /b 3' : 'exit 3';
    const result = await run('run_shell', { command, cwd: root });
    expect(result.ok).toBe(true);
    expect(result.ok && result.preview).toContain('код возврата: 3');
  });

  it('зависшая команда останавливается по таймауту', async () => {
    const command =
      process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const result = await run('run_shell', { command, cwd: root, timeoutMs: 1000 });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/не уложилась/);
  }, 15_000);

  it('требует подтверждения — это опасный инструмент', () => {
    const info = registry.list().find((t) => t.name === 'run_shell')!;
    expect(info.tier).toBe('dangerous');
    expect(registry.list().find((t) => t.name === 'write_file')!.tier).toBe('dangerous');
    expect(registry.list().find((t) => t.name === 'read_file')!.tier).toBe('sensitive');
  });
});
