import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Ограничение файловых операций разрешёнными папками.
 *
 * Путь приходит от модели, а значит может быть чем угодно — включая то, что
 * ей подсказали в прочитанном файле или на веб-странице. Поэтому проверка
 * здесь не «на всякий случай», а обязательная часть каждого файлового
 * инструмента: без неё одна инъекция в тексте превращает чтение документа в
 * чтение `~/.ssh`.
 *
 * Проверяем не строку, а разрешённый путь, и по возможности — реальный:
 * симлинк наружу иначе прошёл бы проверку и увёл куда угодно.
 */
export class PathGuard {
  private readonly roots: string[];

  constructor(roots: readonly string[]) {
    this.roots = roots.map((root) => path.resolve(expandHome(root)));
  }

  get allowedRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Привести путь к абсолютному и убедиться, что он внутри разрешённых папок.
   * Бросает с внятным текстом — он уедет модели как результат вызова.
   */
  resolve(target: string): string {
    if (this.roots.length === 0) {
      throw new Error('Доступ к файлам не настроен: не задано ни одной разрешённой папки');
    }

    const resolved = path.resolve(expandHome(target));
    const real = this.realpathOfExistingPart(resolved);

    if (!this.roots.some((root) => contains(root, real))) {
      throw new Error(
        `Путь вне разрешённых папок: ${resolved}. Разрешено: ${this.roots.join(', ')}`,
      );
    }
    return resolved;
  }

  /**
   * Реальный путь ближайшего существующего предка.
   *
   * Для нового файла самого пути ещё нет, а вот его папка может оказаться
   * симлинком наружу — проверять надо именно её.
   */
  private realpathOfExistingPart(target: string): string {
    let current = target;
    for (;;) {
      try {
        const real = fs.realpathSync(current);
        return current === target ? real : path.join(real, path.relative(current, target));
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return target;
        current = parent;
      }
    }
  }
}

function contains(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function expandHome(target: string): string {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return path.join(os.homedir(), target.slice(2));
  }
  return target;
}

/** Папки, куда лезть незачем и дорого. */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  'dist',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
]);
