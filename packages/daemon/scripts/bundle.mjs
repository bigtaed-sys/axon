import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion, buildStamp } from '../../../scripts/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/**
 * Сборка публикуемого пакета.
 *
 * Внутренние пакеты монорепы (`@axon/core`, `@axon/protocol`) вшиваются в
 * бандл: по отдельности они никому не нужны, а публиковать и версионировать
 * три пакета ради одного продукта — лишняя работа.
 *
 * Сторонние зависимости, наоборот, остаются внешними и объявлены в
 * package.json. Часть из них бандлится плохо: pino подгружает транспорты
 * динамически, iconv-lite тянет таблицы кодировок. Пусть их ставит npm — он
 * это умеет лучше.
 */
const external = Object.keys(pkg.dependencies ?? {});

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  logLevel: 'info',
  // Версия пакета — единственный источник правды; в /health и в hello уходит она.
  define: {
    __AXON_VERSION__: JSON.stringify(resolveVersion(pkg.version)),
    __AXON_BUILT_AT__: JSON.stringify(buildStamp()),
  },
};

await build({
  ...common,
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(root, 'dist/index.js'),
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/cli.ts')],
  // Шебанг esbuild переносит из исходника сам — добавлять свой нельзя,
  // второй такой строкой ниже первой Node уже не понимает.
  outfile: path.join(root, 'dist/cli.js'),
});

// Хост плагинов запускается через fork, то есть по пути к файлу. Он обязан
// лежать рядом с index.js: именно там его ищет resolveHostScript.
await build({
  ...common,
  entryPoints: [path.join(root, 'src/plugin-host.ts')],
  outfile: path.join(root, 'dist/plugin-host.js'),
});

// Права на запуск: без них `axon` из npm не стартует на Linux и macOS.
fs.chmodSync(path.join(root, 'dist/cli.js'), 0o755);

const size = (file) => `${(fs.statSync(path.join(root, 'dist', file)).size / 1024).toFixed(0)} КБ`;
console.log(
  `\nГотово: cli.js ${size('cli.js')}, index.js ${size('index.js')}, ` +
    `plugin-host.js ${size('plugin-host.js')}`,
);
