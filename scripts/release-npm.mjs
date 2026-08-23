import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from './version.mjs';

/**
 * Публикация пакетов в npm.
 *
 * Номер берётся из тега, а не из package.json: в репозитории там стоит
 * заглушка, и это намеренно. Версия в файле, который правят руками, рано или
 * поздно расходится с тем, что на самом деле опубликовано — правку забыли, а
 * пакет выпустили. Тег забыть нельзя.
 *
 * Поэтому здесь: проставить версию из тега, опубликовать, вернуть заглушку на
 * место. В git номер версии не попадает никогда.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Порядок важен: ядро зависит от типов SDK. */
const PACKAGES = ['packages/plugin-sdk', 'packages/daemon'];

const dryRun = process.argv.includes('--dry-run');

/**
 * Всё остальное уходит в npm как есть — прежде всего `--otp=123456`.
 *
 * При включённой двухфакторной защите npm спрашивает код в терминале, а
 * запущенный из скрипта publish спросить его не может: ввода нет, и
 * публикация падает с 403.
 */
const passThrough = process.argv.slice(2).filter((arg) => arg !== '--dry-run');

const version = resolveVersion();

// `2026.8.23-27-g8c24498` — это сборка из середины работы, а не релиз.
// Публиковать такое означает выдать чужой машине версию, которую невозможно
// повторить: коммит уедет, а пакет в реестре останется навсегда.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Версия «${version}» не тег релиза.`);
  console.error('Поставьте тег на этот коммит: git tag -a v2026.8.24 -m "…"');
  process.exit(1);
}

console.log(`Версия ${version}${dryRun ? ' (примерка)' : ''}\n`);

for (const dir of PACKAGES) {
  const file = path.join(root, dir, 'package.json');
  const original = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(original);

  console.log(`── ${pkg.name}`);

  // Уже в реестре — например, второй пакет упал на коде двухфакторной защиты,
  // и скрипт запускают заново. Повторная публикация той же версии всё равно
  // невозможна, и падать на ней вместо того, чтобы доделать остальное, глупо.
  if (!dryRun && published(pkg.name, version)) {
    console.log(`${version} уже в реестре, пропускаю\n`);
    continue;
  }

  fs.writeFileSync(file, original.replace(/"version": "[^"]*"/, `"version": "${version}"`), 'utf8');
  try {
    execFileSync('npm', ['publish', ...(dryRun ? ['--dry-run'] : []), ...passThrough], {
      cwd: path.join(root, dir),
      stdio: 'inherit',
      shell: process.platform === 'win32',
      // Сборка пакета зовёт resolveVersion, а дерево уже грязное — из-за
      // версии, которую мы только что в него вписали. Без подсказки в бандл
      // уехало бы `2026.8.24-dirty`.
      env: { ...process.env, AXON_VERSION: version },
    });
  } catch {
    // Стек вызовов node здесь не нужен: npm уже напечатал, что не так, и
    // ошибка не в этом скрипте.
    console.error(`\n${pkg.name} не опубликован.`);
    console.error('Если npm просит код двухфакторной защиты: npm run release:npm -- --otp=123456');
    process.exitCode = 1;
    break;
  } finally {
    // Возвращаем заглушку в любом случае: упавшая публикация не должна
    // оставлять в репозитории версию, которой там не место.
    fs.writeFileSync(file, original, 'utf8');
  }
}

if (!process.exitCode) console.log('\nГотово.');

/** Есть ли такая версия в реестре. Нет пакета вовсе — тоже «нет». */
function published(name, wanted) {
  try {
    const answer = execFileSync('npm', ['view', `${name}@${wanted}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    return answer.trim() === wanted;
  } catch {
    return false;
  }
}
