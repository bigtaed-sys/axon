import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Ключ подписи приложения.
 *
 * Android ставит обновление поверх старого, только если оно подписано тем же
 * ключом. Другой ключ — и человеку придётся удалить приложение вместе со всеми
 * его данными, а потом ставить заново. Поэтому ключ заводится один раз и живёт
 * дольше всех версий: потерять его значит потерять право обновлять приложение
 * у всех, кто его поставил.
 *
 * Ни ключ, ни пароль в репозиторий не попадают. Здесь их нет и быть не может:
 * репозиторий публичный, а ключ подписи — это и есть право выпускать
 * приложение от нашего имени.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'signing');
const keystore = path.join(dir, 'axon.keystore');
const properties = path.join(dir, 'keystore.properties');

if (fs.existsSync(keystore)) {
  console.error(`Ключ уже есть: ${keystore}`);
  console.error('Второй ключ сделает обновления невозможными — удалите старый осознанно.');
  process.exit(1);
}

const java = process.env['JAVA_HOME'];
const keytool = java ? path.join(java, 'bin', 'keytool') : 'keytool';

// Пароль можно задать своим — иначе берём случайный: придуманный человеком
// обычно слабее, а вводить его руками при каждой сборке всё равно не нужно.
const password = process.env['AXON_KEYSTORE_PASSWORD'] || crypto.randomBytes(24).toString('base64url');

fs.mkdirSync(dir, { recursive: true });

execFileSync(
  keytool,
  [
    '-genkeypair',
    '-v',
    '-keystore', keystore,
    '-alias', 'axon',
    '-keyalg', 'RSA',
    '-keysize', '4096',
    // Двадцать семь лет: срок, после которого подпись перестанет годиться,
    // должен быть заведомо дольше интереса к программе.
    '-validity', '10000',
    '-storepass', password,
    '-keypass', password,
    '-dname', 'CN=Axon, OU=Axon, O=Axon, C=RU',
  ],
  // Без оболочки: путь к JDK почти всегда с пробелом («Android Studio»), а
  // cmd рвёт по нему команду на две.
  { stdio: 'inherit' },
);

fs.writeFileSync(
  properties,
  [
    '# Пароль от ключа подписи. В репозиторий не попадает.',
    `storeFile=${keystore.replace(/\\/g, '/')}`,
    'keyAlias=axon',
    `storePassword=${password}`,
    `keyPassword=${password}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);

console.log('');
console.log(`Ключ: ${keystore}`);
console.log(`Пароль: ${password}`);
console.log('');
console.log('  Сохраните и ключ, и пароль там, где не потеряете: в диспетчере паролей,');
console.log('  в резервной копии, где угодно вне этой машины. Без них выпустить');
console.log('  обновление, которое встанет поверх установленного, будет нельзя —');
console.log('  людям придётся удалять приложение вместе с данными.');
