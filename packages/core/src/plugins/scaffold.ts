import fs from 'node:fs';
import path from 'node:path';

/**
 * Заготовка плагина.
 *
 * Автор начинал с копирования примера и вычищения чужого кода — а «Ленты»
 * задействуют всё сразу, и вычищать там много. Заготовка даёт минимум, который
 * работает: один инструмент, одна настройка, одна кнопка. Всё остальное автор
 * дописывает, глядя на README, а не выковыривает из готового.
 *
 * Файлы пишутся с комментариями, объясняющими, что тут можно поменять. Пустой
 * шаблон без единого пояснения экономит две минуты и стоит получаса чтения
 * документации в поисках того, что и так следовало написать рядом.
 */

export interface ScaffoldResult {
  dir: string;
  id: string;
  files: string[];
}

/** Только строчная латиница, цифры и дефис — тем же правилом живут манифесты. */
const ID = /^[a-z][a-z0-9_-]*$/;

export function scaffold(target: string, rawId?: string): ScaffoldResult {
  const dir = path.resolve(target);
  const id = (rawId ?? path.basename(dir)).toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  if (!ID.test(id)) {
    throw new Error(`Негодный id плагина: «${id}». Нужны строчные латинские буквы, цифры и дефис`);
  }

  if (fs.existsSync(path.join(dir, 'axon.plugin.json'))) {
    throw new Error(`В ${dir} уже есть плагин`);
  }

  fs.mkdirSync(dir, { recursive: true });

  const files = [
    write(dir, 'axon.plugin.json', manifest(id)),
    write(dir, 'index.js', code()),
    write(dir, 'README.md', readme(id)),
  ];

  return { dir, id, files };
}

function write(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return name;
}

function manifest(id: string): string {
  return `${JSON.stringify(
    {
      id,
      name: id,
      description: 'Что делает этот плагин — одной строкой',
      version: '1.0.0',
      api: 1,
      main: './index.js',
      // Права запрашиваются те, что нужны: fs, net, shell, secrets, journal.
      permissions: ['net'],
      settings: [
        {
          key: 'greeting',
          label: 'Приветствие',
          description: 'Подставляется в ответ инструмента',
          type: 'text',
          default: 'Привет',
        },
      ],
      sections: [{ title: 'Основное', fields: ['greeting'] }],
      actions: [{ name: 'check', label: 'Проверить', section: 'Основное' }],
    },
    null,
    2,
  )}\n`;
}

function code(): string {
  return `/**
 * Здесь живёт плагин. Всё начинается с activate — ядро зовёт её при запуске.
 *
 * Зависимостей ставить не нужно: \`api\` приезжает аргументом, а всё остальное
 * есть во встроенном Node — включая fetch.
 */
export async function activate(api) {
  /**
   * Инструмент — то, что агент сможет вызвать сам.
   *
   * Описание пишется для модели, и главное в нём — **когда вызывать**, а не
   * что делает. «Показать погоду» она прочитает и не поймёт, при чём тут её
   * вопрос; «вызывай, когда спрашивают про погоду или собираются выходить» —
   * поймёт.
   */
  await api.tools.register({
    name: 'hello',
    title: 'Поздороваться',
    description: 'Поздороваться с человеком. Вызывай, когда просят это сделать.',
    tier: 'safe',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Как зовут того, с кем здороваемся' },
      },
    },
    execute: async (args) => {
      const greeting = api.settings.text('greeting', 'Привет');
      return \`\${greeting}, \${args.name ?? 'мир'}!\`;
    },
  });

  // Кнопка на странице настроек. Возвращённая строка покажется человеку.
  api.actions.on('check', async () => {
    return 'Плагин на связи';
  });

  api.log.info('плагин поднялся');
}

/** Необязательно. Вызывается перед остановкой — закрыть соединения, снять таймеры. */
export async function deactivate() {}
`;
}

function readme(id: string): string {
  return `# ${id}

Плагин для [Axon](https://github.com/bigtaed-sys/axon).

## Как проверить

Подключите папку по месту — тогда правки видны без пересборки:

\`\`\`bash
axon plugin link .
axon plugin logs ${id}
\`\`\`

Или в приложении: **Плагины → Установка плагина → Загрузить архив**.

## Что дальше

- Инструменты, вклад в промпт, задачи по расписанию, свои провайдеры моделей —
  всё это в [документации SDK](https://www.npmjs.com/package/@axon-assistant/plugin-sdk).
- Плагин может спросить модель (\`api.model.ask\`), сказать человеку
  (\`api.notify\`) и сообщить о себе (\`api.status.set\`).
- Рабочий пример со всем сразу — \`examples/feeds-plugin\` в репозитории Axon.
`;
}
