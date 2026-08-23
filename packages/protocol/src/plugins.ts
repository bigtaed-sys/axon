import { z } from 'zod';
import { zId, zTimestamp } from './primitives.js';
import { zRiskTier } from './domain.js';

/**
 * Плагины — единственный способ добавить ядру возможностей.
 *
 * Плагин — это единица установки, а не единица кода. Внутри может лежать что
 * угодно из трёх: собственные инструменты на JS, подключения к MCP-серверам и
 * скиллы (текстовые инструкции). Плагин без `main` — законная и частая вещь:
 * манифест из десяти строк, поднимающий чужой MCP-сервер.
 *
 * Сделано так, потому что для пользователя это один список: «что я поставил
 * себе в Axon». Разводить его на три раздела значит заставлять человека знать
 * нашу внутреннюю таксономию, чтобы найти уже поставленное.
 */

/** Слаг: им же префиксуются инструменты плагина, поэтому набор символов узкий. */
export const zPluginId = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Только строчные латинские буквы, цифры, дефис и подчёркивание');

// ─── Права ──────────────────────────────────────────────────────────────────

/**
 * Что плагин просит у ядра. Показывается человеку до установки — это не
 * песочница, а информированное согласие: код плагина живёт в своём процессе,
 * но с правами пользователя, и запретить ему читать диск средствами Node
 * невозможно. Честнее показать запрос, чем делать вид, что есть изоляция.
 */
export const zPluginPermission = z.enum([
  /** Читает и пишет файлы вне своей папки. */
  'fs',
  /** Ходит в сеть. */
  'net',
  /** Запускает процессы. */
  'shell',
  /** Читает секреты ядра — только свои, из собственного пространства имён. */
  'secrets',
  /** Подписывается на журнал: видит переписку. */
  'journal',
]);
export type PluginPermission = z.infer<typeof zPluginPermission>;

// ─── Транспорт MCP ──────────────────────────────────────────────────────────

/**
 * Как ядро дотягивается до MCP-сервера.
 *
 * `stdio` — обычный случай: сервер ставится через npx/uvx и живёт дочерним
 * процессом ядра. `http` — уже поднятый где-то сервер, ядро только шлёт запросы.
 */
export const zMcpTransport = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string()).default({}),
  }),
]);
export type McpTransport = z.infer<typeof zMcpTransport>;

// ─── Настройки плагина ──────────────────────────────────────────────────────

/**
 * Описание одного поля настроек. Плагин объявляет форму, интерфейс её рисует —
 * иначе каждый новый плагин требовал бы правки десктопного клиента.
 */
export const zPluginSettingField = z.object({
  key: z.string().min(1).max(60),
  label: z.string().max(120),
  description: z.string().max(400).optional(),
  /**
   * `secret` хранится шифрованным и не отдаётся обратно клиенту — только
   * признак «задано». Всё остальное лежит в обычных настройках.
   */
  type: z.enum(['text', 'secret', 'number', 'boolean', 'select', 'path', 'textarea']),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  default: z.unknown().optional(),
  required: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
  /**
   * Показывать поле, только когда другое имеет заданное значение.
   *
   * Без этого плагин с двумя способами подключения вываливает поля обоих
   * сразу, и человек заполняет половину впустую. Условие простое до
   * неприличия — одно поле, одно значение: сложнее бывает нужно редко, а
   * язык выражений в манифесте плагина означал бы интерпретатор в ядре.
   */
  visibleWhen: z.object({ key: z.string(), equals: z.unknown() }).optional(),
});
export type PluginSettingField = z.infer<typeof zPluginSettingField>;

/**
 * Раздел на странице настроек плагина.
 *
 * Плоский список полей годится, пока их пять. Дальше человек смотрит на два
 * десятка подписей и не понимает, какие из них связаны между собой.
 */
export const zPluginSettingSection = z.object({
  title: z.string().max(120),
  description: z.string().max(600).optional(),
  fields: z.array(z.string()).default([]),
});
export type PluginSettingSection = z.infer<typeof zPluginSettingSection>;

/**
 * Кнопка на странице настроек: «проверить подключение», «обновить список».
 *
 * Плагин объявляет её, ядро зовёт обработчик, интерфейс показывает, что
 * вернулось. Это тот минимум, ради которого страница вообще нужна: настройки
 * без способа проверить, что они верные, — это анкета, а не настройка.
 *
 * Обратите внимание, чего здесь нет: разметки, стилей, кода для окна. Плагин
 * описывает, что показать, а рисует приложение. Дать плагину рисовать самому
 * значило бы пустить его код в окно с полным доступом к ядру — ровно то, от
 * чего его отделили отдельным процессом.
 */
export const zPluginAction = z.object({
  name: z.string().min(1).max(60),
  label: z.string().max(120),
  description: z.string().max(400).optional(),
  /** Раздел, в котором показать кнопку. Пусто — внизу страницы. */
  section: z.string().max(120).optional(),
  /** Спросить подтверждение перед вызовом. Для необратимого. */
  confirm: z.string().max(300).optional(),
});
export type PluginAction = z.infer<typeof zPluginAction>;

// ─── Манифест ───────────────────────────────────────────────────────────────

/** Объявление задачи по расписанию. Плагин получает вызов, ядро — контроль. */
export const zPluginJob = z.object({
  name: z.string().min(1).max(60),
  /** Период в секундах. Минимум минута: чаще — это не расписание, а цикл. */
  everySeconds: z.number().int().min(60),
  /** Запускать сразу при активации, не дожидаясь первого периода. */
  immediate: z.boolean().default(false),
});
export type PluginJob = z.infer<typeof zPluginJob>;

export const zPluginManifest = z.object({
  id: zPluginId,
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  version: z.string().max(40).default('0.0.0'),
  author: z.string().max(120).optional(),
  homepage: z.string().max(300).optional(),
  /** Версия API плагинов, на которую он рассчитан. */
  api: z.number().int().positive().default(1),
  /** Точка входа. Нет — плагин без кода: только MCP-серверы и скиллы. */
  main: z.string().max(200).optional(),
  permissions: z.array(zPluginPermission).default([]),
  settings: z.array(zPluginSettingField).default([]),
  sections: z.array(zPluginSettingSection).default([]),
  actions: z.array(zPluginAction).default([]),
  /** Папка со скиллами (*.md) относительно корня плагина. */
  skills: z.string().max(200).optional(),
  mcpServers: z.record(zMcpTransport).default({}),
  jobs: z.array(zPluginJob).default([]),
});
export type PluginManifest = z.infer<typeof zPluginManifest>;

// ─── Состояние ──────────────────────────────────────────────────────────────

/**
 * Что с плагином прямо сейчас. Отдельно от `enabled`: выключен пользователем и
 * упал при запуске — разные состояния, и чинятся по-разному.
 */
export const zPluginStatus = z.enum(['disabled', 'starting', 'ready', 'failed', 'needs_setup']);
export type PluginStatus = z.infer<typeof zPluginStatus>;

export const zPluginOrigin = z.object({
  type: z.enum(['catalog', 'git', 'link', 'builtin', 'archive']),
  /** Идентификатор в каталоге, URL репозитория, путь на диске или имя архива. */
  ref: z.string(),
});
export type PluginOrigin = z.infer<typeof zPluginOrigin>;

export const zMcpServerInfo = z.object({
  name: z.string(),
  status: zPluginStatus,
  error: z.string().optional(),
  toolCount: z.number().int().nonnegative().default(0),
});
export type McpServerInfo = z.infer<typeof zMcpServerInfo>;

export const zSkillInfo = z.object({
  /** Уникально в пределах ядра: `<pluginId>/<file>`. */
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** Оценка размера тела в токенах — видно, во что обойдётся раскрытие. */
  tokens: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
});
export type SkillInfo = z.infer<typeof zSkillInfo>;

export const zPluginInfo = z.object({
  id: zPluginId,
  name: z.string(),
  description: z.string(),
  version: z.string(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  origin: zPluginOrigin,
  permissions: z.array(zPluginPermission).default([]),
  /** Форма настроек — интерфейс рисует её по этому описанию. */
  settings: z.array(zPluginSettingField).default([]),
  sections: z.array(zPluginSettingSection).default([]),
  actions: z.array(zPluginAction).default([]),
  /**
   * Текущие значения. Секреты сюда не попадают: вместо значения — `true`,
   * если задано. Иначе токен уехал бы на каждое устройство в снапшоте.
   */
  settingValues: z.record(z.unknown()).default({}),

  /** Хочет ли пользователь, чтобы плагин работал. */
  enabled: z.boolean(),
  /** Работает ли он на самом деле. */
  status: zPluginStatus,
  /** Почему не работает. Текст для человека, не стектрейс. */
  error: z.string().optional(),

  /** Что плагин принёс в ядро. Пусто, пока он не запустился. */
  tools: z.array(z.object({ name: z.string(), title: z.string(), tier: zRiskTier })).default([]),
  skills: z.array(zSkillInfo).default([]),
  mcpServers: z.array(zMcpServerInfo).default([]),
  providers: z.array(z.string()).default([]),
  jobs: z
    .array(
      z.object({
        name: z.string(),
        everySeconds: z.number().int().positive(),
        lastRunAt: zTimestamp.optional(),
        lastError: z.string().optional(),
      }),
    )
    .default([]),

  installedAt: zTimestamp,
  updatedAt: zTimestamp,
});
export type PluginInfo = z.infer<typeof zPluginInfo>;

// ─── Каталог ────────────────────────────────────────────────────────────────

/**
 * Встроенный список проверенных плагинов. Едет вместе с ядром, а не тянется с
 * сервера: у Axon нет обязательного облака, и раздел «Каталог», пустой без
 * интернета, был бы издевательством.
 */
export const zCatalogEntry = z.object({
  id: zPluginId,
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  homepage: z.string().optional(),
  permissions: z.array(zPluginPermission).default([]),
  /** Что спросить у человека до установки: токены, пути, ключи. */
  setup: z.array(zPluginSettingField).default([]),
  install: z.discriminatedUnion('type', [
    z.object({ type: z.literal('git'), url: z.string(), ref: z.string().optional() }),
    /**
     * Плагин-обёртка вокруг MCP-сервера: ядро соберёт манифест само.
     * `${setup.ключ}` в аргументах и окружении подставляется из ответов.
     */
    z.object({ type: z.literal('mcp'), transport: zMcpTransport }),
  ]),
});
export type CatalogEntry = z.infer<typeof zCatalogEntry>;

// ─── Установка ──────────────────────────────────────────────────────────────

export const zPluginSource = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('catalog'),
    id: zPluginId,
    /** Ответы на `setup` из записи каталога. */
    values: z.record(z.string()).default({}),
  }),
  z.object({
    type: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().optional(),
  }),
  /**
   * Свой MCP-сервер, которого нет в каталоге.
   *
   * Главный способ поставить что-то в Axon, а не запасной: MCP-серверов
   * существуют сотни, и каталог из шести проверенных — это закладки, а не
   * граница возможного. Ядро соберёт вокруг конфигурации плагин-обёртку само.
   */
  z.object({
    type: z.literal('mcp'),
    name: zPluginId,
    /** Как показать сервер в списке. Пусто — возьмём имя. */
    title: z.string().max(80).optional(),
    transport: zMcpTransport,
  }),
  /**
   * Папка на машине ядра. Подключается по месту, а не копируется — это режим
   * разработки: правишь файлы, перезапускаешь плагин, видишь результат.
   */
  z.object({ type: z.literal('link'), path: z.string().min(1) }),
  /**
   * Архив, загруженный человеком. Едет блобом, как вложение к сообщению:
   * гонять мегабайты через WebSocket, у которого своя очередь кадров, — верный
   * способ подвесить всё остальное на время загрузки.
   */
  z.object({ type: z.literal('archive'), blobId: zId, name: z.string().max(200).optional() }),
]);
export type PluginSource = z.infer<typeof zPluginSource>;

// ─── Разбор чужой конфигурации MCP ──────────────────────────────────────────

export interface ParsedMcpServer {
  name: string;
  transport: McpTransport;
}

/**
 * Понять конфигурацию MCP-сервера в том виде, в каком её печатают в README.
 *
 * Своего формата у нас нет намеренно. Каждый MCP-сервер документирует себя
 * куском JSON для Claude Desktop или VS Code, и человек приходит к нам именно
 * с ним. Заставлять его переписывать это в наши поля — верный способ сделать
 * установку чужого сервера тем, чем никто не пользуется.
 *
 * Принимаются все формы, которые встречаются в природе:
 *
 * ```json
 * { "mcpServers": { "github": { "command": "npx", "args": ["-y", "…"] } } }
 * { "servers":    { "github": { "type": "http", "url": "https://…" } } }
 * { "github": { "command": "npx" } }
 * { "command": "npx", "args": ["-y", "…"] }
 * ```
 */
export function parseMcpConfig(text: string): ParsedMcpServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    throw new Error('Это не JSON. Вставьте конфигурацию сервера целиком, как в его README.');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Ожидался объект JSON');

  const root = raw as Record<string, unknown>;
  const map = pickServerMap(root);

  const servers: ParsedMcpServer[] = [];
  for (const [name, value] of Object.entries(map)) {
    const transport = toTransport(value, name);
    servers.push({ name: slugify(name), transport });
  }

  if (servers.length === 0) throw new Error('В конфигурации нет ни одного сервера');
  return servers;
}

/** Достать «имя → конфигурация», в какой бы обёртке она ни приехала. */
function pickServerMap(root: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['mcpServers', 'servers'] as const) {
    const nested = root[key];
    if (nested && typeof nested === 'object') return nested as Record<string, unknown>;
  }
  // Один сервер без обёртки и без имени — назовём по команде или по хосту.
  if (typeof root['command'] === 'string' || typeof root['url'] === 'string') {
    return { [defaultName(root)]: root };
  }
  return root;
}

function toTransport(value: unknown, name: string): McpTransport {
  if (!value || typeof value !== 'object') {
    throw new Error(`Сервер ${name}: ожидался объект с command или url`);
  }
  const config = value as Record<string, unknown>;

  if (typeof config['url'] === 'string') {
    return zMcpTransport.parse({
      type: 'http',
      url: config['url'],
      headers: config['headers'] ?? {},
    });
  }

  if (typeof config['command'] === 'string') {
    return zMcpTransport.parse({
      type: 'stdio',
      command: config['command'],
      args: config['args'] ?? [],
      env: config['env'] ?? {},
      ...(typeof config['cwd'] === 'string' ? { cwd: config['cwd'] } : {}),
    });
  }

  throw new Error(`Сервер ${name}: нет ни command, ни url`);
}

/**
 * Имя по умолчанию — из последнего осмысленного куска команды или из хоста.
 * `npx -y @modelcontextprotocol/server-memory` → `server-memory`.
 */
function defaultName(config: Record<string, unknown>): string {
  const url = config['url'];
  if (typeof url === 'string') {
    try {
      return new URL(url).hostname.split('.')[0] ?? 'mcp';
    } catch {
      return 'mcp';
    }
  }

  const args = Array.isArray(config['args']) ? (config['args'] as unknown[]) : [];
  const pkg = args.filter((a): a is string => typeof a === 'string' && !a.startsWith('-')).pop();
  const source = pkg ?? String(config['command'] ?? 'mcp');
  return source.split('/').pop() ?? 'mcp';
}

/** Привести имя к тому, что примет `zPluginId`. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 40);
  return slug || 'mcp';
}
