import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types.js';
import { PathGuard, SKIP_DIRS } from './paths.js';

const MAX_LINES = 2_000;
const DEFAULT_LINES = 400;
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_RESULTS = 100;
/** Файл больше этого читать целиком незачем — только кусками. */
const HUGE_FILE_BYTES = 5 * 1024 * 1024;

export function createFileTools(guard: PathGuard): ToolDefinition[] {
  const read = defineTool({
    name: 'read_file',
    title: 'Прочитать файл',
    description:
      'Прочитать текстовый файл с диска. Вызывай, когда нужно точное содержимое: ' +
      'код, конфиг, заметки, лог. Возвращает строки с номерами. Файл читается ' +
      'кусками — если нужен фрагмент дальше, повтори вызов с другим offset.',
    tier: 'sensitive',
    source: 'builtin',
    // Чтение файла с общим потолком бесполезно: модель получит пару абзацев.
    previewLimit: 12_000,
    schema: z.object({
      path: z.string().min(1).describe('Путь к файлу'),
      offset: z.number().int().min(1).optional().describe('С какой строки читать, начиная с 1'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_LINES)
        .optional()
        .describe(`Сколько строк прочитать (по умолчанию ${DEFAULT_LINES})`),
    }),
    async execute({ path: target, offset = 1, limit = DEFAULT_LINES }) {
      const file = guard.resolve(target);
      const stat = await fs.promises.stat(file);
      if (stat.isDirectory()) throw new Error(`${file} — это папка, а не файл`);

      const content = await fs.promises.readFile(file, 'utf8');
      const lines = content.split('\n');
      const from = Math.min(offset, lines.length);
      const slice = lines.slice(from - 1, from - 1 + limit);

      const numbered = slice
        .map((line, index) => `${String(from + index).padStart(5)}\t${line}`)
        .join('\n');

      const tail =
        from - 1 + slice.length < lines.length
          ? `\n… показаны строки ${from}–${from + slice.length - 1} из ${lines.length}`
          : '';

      return { text: numbered + tail };
    },
  });

  const write = defineTool({
    name: 'write_file',
    title: 'Записать файл',
    description:
      'Создать файл или полностью заменить его содержимое. Вызывай, когда нужно ' +
      'сохранить результат работы. Существующий файл перезаписывается целиком — ' +
      'если нужно изменить часть, сначала прочитай его.',
    tier: 'dangerous',
    source: 'builtin',
    schema: z.object({
      path: z.string().min(1).describe('Путь к файлу'),
      content: z.string().describe('Полное содержимое файла'),
    }),
    async execute({ path: target, content }) {
      const file = guard.resolve(target);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });

      const existed = fs.existsSync(file);
      await fs.promises.writeFile(file, content, 'utf8');

      return {
        text: `${existed ? 'Перезаписан' : 'Создан'} ${file}, ${content.length} символов`,
      };
    },
  });

  const list = defineTool({
    name: 'list_dir',
    title: 'Показать папку',
    description:
      'Список файлов и папок. Вызывай, когда нужно понять, что вообще есть на ' +
      'диске, прежде чем читать конкретный файл.',
    tier: 'sensitive',
    source: 'builtin',
    schema: z.object({
      path: z.string().min(1).describe('Путь к папке'),
    }),
    async execute({ path: target }) {
      const dir = guard.resolve(target);
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });

      const rows = entries
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => {
          if (entry.isDirectory()) return `${entry.name}/`;
          const size = safeSize(path.join(dir, entry.name));
          return size === null ? entry.name : `${entry.name}\t${formatSize(size)}`;
        })
        .sort();

      const more =
        entries.length > MAX_LIST_ENTRIES
          ? `\n… и ещё ${entries.length - MAX_LIST_ENTRIES} записей`
          : '';

      return { text: rows.join('\n') + more || '(пусто)' };
    },
  });

  const find = defineTool({
    name: 'find_files',
    title: 'Найти файлы',
    description:
      'Поиск файлов по части имени внутри папки, рекурсивно. Вызывай, когда ' +
      'знаешь примерное имя, но не знаешь, где файл лежит. Служебные папки ' +
      'вроде node_modules и .git пропускаются.',
    tier: 'sensitive',
    source: 'builtin',
    deferred: true,
    schema: z.object({
      path: z.string().min(1).describe('Где искать'),
      query: z.string().min(1).describe('Часть имени файла'),
      limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
    }),
    async execute({ path: target, query, limit = 50 }) {
      const root = guard.resolve(target);
      const needle = query.toLowerCase();
      const found: string[] = [];

      const walk = async (dir: string, depth: number): Promise<void> => {
        if (found.length >= limit || depth > 8) return;
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);

        for (const entry of entries) {
          if (found.length >= limit) return;
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
            await walk(path.join(dir, entry.name), depth + 1);
          } else if (entry.name.toLowerCase().includes(needle)) {
            found.push(path.join(dir, entry.name));
          }
        }
      };

      await walk(root, 0);
      return { text: found.length > 0 ? found.join('\n') : `Ничего не найдено по «${query}»` };
    },
  });

  return [read, write, list, find];
}

function safeSize(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    return stat.size > HUGE_FILE_BYTES ? stat.size : stat.size;
  } catch {
    return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
