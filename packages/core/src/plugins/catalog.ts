import type { CatalogEntry } from '@axon/protocol';

/**
 * Встроенный каталог.
 *
 * Едет вместе с ядром, а не тянется с нашего сервера. Причина простая: у Axon
 * нет обязательного облака, ядро может стоять в локалке без выхода наружу, и
 * раздел «Каталог», пустой без интернета, был бы издевательством над главным
 * обещанием продукта.
 *
 * Сюда попадает только то, что действительно существует и работает без
 * OAuth-танцев: всё, что требует браузерного входа, пока честнее ставить
 * руками, чем делать вид, что установка в один клик.
 */
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'Файлы (MCP)',
    description:
      'Чтение, запись и поиск в выбранных папках через официальный MCP-сервер. ' +
      'Полезен, когда нужны операции с файлами за пределами того, что умеют встроенные инструменты.',
    tags: ['файлы', 'официальный'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    permissions: ['fs', 'shell'],
    setup: [
      {
        key: 'root',
        label: 'Папка, к которой открыть доступ',
        description: 'Сервер не выйдет за её пределы. Можно указать одну папку.',
        type: 'path',
        required: true,
        placeholder: 'C:\\Users\\me\\Documents',
      },
    ],
    install: {
      type: 'mcp',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '${root}'],
        env: {},
      },
    },
  },
  {
    id: 'memory',
    name: 'Граф знаний (MCP)',
    description:
      'Долговременная память в виде графа сущностей и связей. Дополняет обычную память ' +
      'фактами, у которых есть отношения друг с другом.',
    tags: ['память', 'официальный'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    permissions: ['shell'],
    setup: [],
    install: {
      type: 'mcp',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        env: {},
      },
    },
  },
  {
    id: 'thinking',
    name: 'Пошаговое рассуждение (MCP)',
    description:
      'Инструмент для разбора сложных задач на шаги с возможностью пересматривать ' +
      'предыдущие выводы. Помогает там, где ответ «с ходу» стабильно неверный.',
    tags: ['рассуждение', 'официальный'],
    homepage: 'https://github.com/modelcontextprotocol/servers',
    permissions: ['shell'],
    setup: [],
    install: {
      type: 'mcp',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        env: {},
      },
    },
  },
  {
    id: 'playwright',
    name: 'Браузер (Playwright MCP)',
    description:
      'Управление настоящим браузером: открыть страницу, нажать, заполнить форму, ' +
      'забрать содержимое. Работает со страницами, которые не отдаются простым HTTP-запросом.',
    tags: ['браузер', 'веб'],
    homepage: 'https://github.com/microsoft/playwright-mcp',
    permissions: ['shell', 'net'],
    setup: [],
    install: {
      type: 'mcp',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: {},
      },
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    description:
      'Репозитории, задачи, пул-реквесты и код через официальный удалённый MCP-сервер GitHub. ' +
      'Ничего ставить локально не нужно — только токен.',
    tags: ['разработка'],
    homepage: 'https://github.com/github/github-mcp-server',
    permissions: ['net'],
    setup: [
      {
        key: 'token',
        label: 'Personal access token',
        description: 'Создаётся в настройках GitHub → Developer settings → Personal access tokens.',
        type: 'secret',
        required: true,
        placeholder: 'github_pat_…',
      },
    ],
    install: {
      type: 'mcp',
      transport: {
        type: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${token}' },
      },
    },
  },
  {
    id: 'context7',
    name: 'Context7 — документация библиотек',
    description:
      'Актуальная документация и примеры для тысяч библиотек. Лечит главную болезнь ' +
      'моделей в коде — устаревшее API из обучающих данных.',
    tags: ['разработка', 'документация'],
    homepage: 'https://context7.com',
    permissions: ['net'],
    setup: [],
    install: {
      type: 'mcp',
      transport: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: {} },
    },
  },
];

export function catalogEntry(id: string): CatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}
