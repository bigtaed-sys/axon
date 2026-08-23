import { execFileSync } from 'node:child_process';
import { resolveVersion } from '../../../scripts/version.mjs';

/**
 * Запуск electron-builder с версией из git-тега.
 *
 * Сборщик берёт номер из package.json, а там стоит заглушка — и установщик
 * получался «Axon Setup 0.1.0.exe» при том, что само приложение показывало
 * 2026.8.23. Две разные версии одной программы: одна в имени файла и в списке
 * установленных программ Windows, другая на экране.
 *
 * `extraMetadata.version` подменяет номер в упакованном package.json, поэтому
 * совпадает всё сразу: имя установщика, запись в «Программах и компонентах» и
 * `app.getVersion()`.
 */
const version = resolveVersion('0.0.0-dev');

console.log(`Версия сборки: ${version}`);

execFileSync('electron-builder', [`-c.extraMetadata.version=${version}`, ...process.argv.slice(2)], {
  stdio: 'inherit',
  // На Windows electron-builder — это .cmd из node_modules/.bin, а его без
  // оболочки не запустить.
  shell: process.platform === 'win32',
});
