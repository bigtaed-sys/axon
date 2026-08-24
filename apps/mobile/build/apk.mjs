import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from '../../../scripts/version.mjs';

/**
 * Сборка APK.
 *
 * Существует ради одного: чтобы версия приложения на телефоне приходила из
 * git-тега, как у ядра и десктопа. Gradle читает её из окружения — иначе
 * пришлось бы править `build.gradle` руками перед каждым выпуском, а такое
 * забывают на второй раз.
 *
 * Числовой код версии Android обязан только расти и ничего больше не значит:
 * собираем его из той же календарной версии, `2026.8.27` → `20260827`.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = path.join(root, 'android');

const version = resolveVersion();
const [year = '0', month = '0', release = '0'] = version.split(/[.-]/);
const code = Number(year) * 10000 + Number(month) * 100 + Number(release);

if (!Number.isSafeInteger(code) || code <= 0) {
  console.error(`Из версии «${version}» не выходит числовой код для Android.`);
  process.exit(1);
}

/**
 * Android SDK и Java ищутся в окружении.
 *
 * Подставлять сюда чьи-то конкретные пути нельзя: у каждого они свои, а
 * молчаливое умолчание однажды соберёт не тем компилятором.
 */
if (!process.env['ANDROID_HOME'] && !fs.existsSync(path.join(android, 'local.properties'))) {
  console.error('Не задан ANDROID_HOME и нет android/local.properties с sdk.dir.');
  process.exit(1);
}

console.log(`Версия ${version}, код ${code}\n`);

/**
 * Страница собирается здесь же и здесь же переносится в оболочку.
 *
 * Раньше это делал соседний скрипт, а этот только звал Gradle. Одного запуска
 * в обход соседа хватило, чтобы APK собрался из вчерашней страницы: нативная
 * часть новая, веб старый, и по виду не отличить. Полчаса ушло на поиск
 * правок, которых в сборке не было.
 */
run('npx', ['vite', 'build']);
run('npx', ['cap', 'sync', 'android']);

// Полный путь, а не имя: с оболочкой Windows ищет команду по PATH, а не в
// рабочей папке, и «gradlew.bat не является внутренней командой» — это оно.
const gradle = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');

execFileSync(gradle, ['assembleDebug'], {
  cwd: android,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, AXON_VERSION: version, AXON_VERSION_CODE: String(code) },
});

const apk = path.join(android, 'app/build/outputs/apk/debug/app-debug.apk');
const named = path.join(root, `Axon-${version}.apk`);
fs.copyFileSync(apk, named);

console.log(`\nГотово: ${named} (${(fs.statSync(named).size / 1024 / 1024).toFixed(1)} МБ)`);

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}
