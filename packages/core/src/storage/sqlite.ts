import { createRequire } from 'node:module';

/**
 * Подключение встроенного SQLite.
 *
 * Через обычный `import` он ломает сборщики: `sqlite` отсутствует в
 * `module.builtinModules`, поэтому любой инструмент, который срезает префикс
 * `node:` и ищет пакет по остатку, промахивается — так падают и Vite, и
 * бандлеры. `createRequire` уводит подключение в рантайм, где оно разрешается
 * настоящим Node и работает всегда.
 *
 * Заодно это единственное место, которое придётся править, если модуль
 * переедет или сменит имя: он пока помечен экспериментальным.
 */
const require = createRequire(import.meta.url);

/**
 * При первом подключении модуль печатает ExperimentalWarning. Пользователю
 * ядра это сообщение ничего не даёт и выглядит как ошибка, поэтому гасим —
 * но ровно его и ровно на время подключения: глушить предупреждения Node
 * навсегда библиотека права не имеет.
 */
function requireSqlite(): typeof import('node:sqlite') {
  const original = process.emitWarning;

  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    if (text.includes('SQLite is an experimental feature')) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}

export const { DatabaseSync } = requireSqlite();

export type SqliteDatabase = InstanceType<typeof DatabaseSync>;
