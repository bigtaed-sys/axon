import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Собрать ядро в вид, пригодный для укладки в ресурсы приложения.
 *
 * Одного бандла мало. Часть зависимостей ядра намеренно не вшита в него: pino
 * подгружает транспорты динамически, iconv-lite тянет таблицы кодировок, и
 * собранные внутрь они ломаются. В npm-пакете их ставит npm — а в десктопе
 * ставить некому, поэтому это делается здесь, один раз при сборке.
 *
 * Результат — самодостаточная папка `resources/daemon`, откуда ядро
 * запускается обычным `node cli.js`. Ровно её ищет LocalCore.resolveCli.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const daemon = path.resolve(desktop, '../../packages/daemon');
const staging = path.join(desktop, 'build/daemon');

const bundle = path.join(daemon, 'dist');
if (!fs.existsSync(path.join(bundle, 'cli.js'))) {
  throw new Error('Ядро не собрано. Сначала `npm run build` в корне монорепы.');
}

fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });

// Только исполняемое: карты кода и объявления типов в приложении не нужны и
// весят больше самого ядра.
for (const file of fs.readdirSync(bundle)) {
  if (!file.endsWith('.js')) continue;
  fs.copyFileSync(path.join(bundle, file), path.join(staging, file));
}

const manifest = JSON.parse(fs.readFileSync(path.join(daemon, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(staging, 'package.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      private: true,
      type: 'module',
      dependencies: manifest.dependencies,
    },
    null,
    2,
  ),
);

console.log('Ставлю зависимости ядра…');
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  [
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    // Без своего package-lock и вне рабочих пространств монорепы: иначе npm
    // поднимется до корня и поставит туда, где приложение ничего не найдёт.
    '--no-package-lock',
    '--install-strategy=nested',
  ],
  {
    cwd: staging,
    stdio: 'inherit',
    // На Windows npm — это .cmd, а Node 22 отказывается запускать такие файлы
    // напрямую (EINVAL) из соображений безопасности. Аргументы здесь свои и
    // без пробелов, так что оболочке нечего разбирать неправильно.
    shell: process.platform === 'win32',
  },
);

const size = folderSize(staging);
console.log(`Ядро готово к упаковке: ${(size / 1024 / 1024).toFixed(1)} МБ`);

function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderSize(full) : fs.statSync(full).size;
  }
  return total;
}
