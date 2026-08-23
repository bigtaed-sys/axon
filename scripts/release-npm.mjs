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
const version = resolveVersion();

// `2026.8.23-27-g8c24498` — это сборка из середины работы, а не релиз.
// Публиковать такое означает выдать чужой машине версию, которую невозможно
// повторить: коммит уедет, а пакет в реестре останется навсегда.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Версия «${version}» не тег релиза.`);
  console.error('Поставьте тег на этот коммит: git tag -a v2026.8.23 -m "…"');
  process.exit(1);
}

console.log(`Версия ${version}${dryRun ? ' (примерка)' : ''}\n`);

for (const dir of PACKAGES) {
  const file = path.join(root, dir, 'package.json');
  const original = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(original);

  console.log(`── ${pkg.name}`);

  fs.writeFileSync(file, original.replace(/"version": "[^"]*"/, `"version": "${version}"`), 'utf8');
  try {
    execFileSync('npm', dryRun ? ['publish', '--dry-run'] : ['publish'], {
      cwd: path.join(root, dir),
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  } finally {
    // Возвращаем заглушку в любом случае: упавшая публикация не должна
    // оставлять в репозитории версию, которой там не место.
    fs.writeFileSync(file, original, 'utf8');
  }
}

console.log('\nГотово.');
