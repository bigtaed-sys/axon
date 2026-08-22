import { pino } from 'pino';

/**
 * Логгер ядра. Уровень задаётся `AXON_LOG_LEVEL`.
 *
 * Тут же список полей, которые вырезаются из логов: ядро держит API-ключи и
 * токены устройств, и им нечего делать в файле, который пользователь потом
 * приложит к баг-репорту.
 */
export const logger = pino(
  {
    level: process.env['AXON_LOG_LEVEL'] ?? 'info',
    redact: {
      paths: [
        'apiKey',
        'token',
        'secret',
        'password',
        '*.apiKey',
        '*.token',
        '*.secret',
        '*.password',
        'headers.authorization',
      ],
      censor: '[скрыто]',
    },
  },
  // Логи — в stderr. stdout остаётся под вывод самой программы: демон печатает
  // туда строку рукопожатия для родительского процесса, и лог, попавший в тот
  // же поток, читается как эта строка.
  process.stderr,
);

export type Logger = typeof logger;
