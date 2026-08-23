import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import { OBSERVATION_KINDS } from '@axon/protocol';
import type {
  Device,
  Fact,
  Observation,
  PluginInfo,
  ProviderInfo,
  RiskTier,
  SecretStatus,
  ToolInfo,
} from '@axon/protocol';
import { host } from '../host.js';
import type { Connection } from '../host.js';

/**
 * Ширина экрана.
 *
 * Одной ширины на всё не бывает. Форму настроек читают строкой, и колонка в
 * 672 пикселя тут правильная: длинная строка ввода неудобна, а текст подсказки
 * при большей ширине перестаёт читаться.
 *
 * Списку карточек та же колонка вредит: при окне в 1280 половина ширины
 * пропадает, а список инструментов растягивается на три экрана прокрутки
 * вместо полутора.
 */
type ScreenWidth = 'reading' | 'wide';

const WIDTH: Record<ScreenWidth, string> = {
  reading: 'max-w-2xl',
  wide: 'max-w-5xl',
};

export function Screen({
  title,
  icon,
  hint,
  width = 'reading',
  tabs,
  actions,
  children,
}: {
  title: string;
  icon: string;
  hint?: string;
  width?: ScreenWidth;
  /**
   * Разделы одного экрана — по центру, между названием и кнопками.
   *
   * Не слева и не справа: слева переключатель читается как продолжение
   * заголовка, справа — как ещё одна кнопка действия. Посередине он ничем
   * другим быть не может.
   */
  tabs?: React.ReactNode;
  /** Что поставить справа от заголовка: поиск, переключатель вида. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto scrollbar">
      <div className={clsx('mx-auto px-6 py-6', WIDTH[width])}>
        <div className="flex items-center gap-2.5 mb-1">
          <i className={clsx('bi', icon, 'text-lg text-accent')} />
          <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
          {tabs && <div className="flex-1 flex justify-center">{tabs}</div>}
          {actions && (
            <div className={clsx('flex items-center gap-2', !tabs && 'ml-auto')}>{actions}</div>
          )}
        </div>
        {hint && (
          <p className="text-[12px] text-text-muted mb-5 leading-relaxed max-w-2xl">{hint}</p>
        )}
        {!hint && <div className="mb-5" />}
        {children}
      </div>
    </div>
  );
}

/**
 * Сетка карточек. На узком окне — один столбец, на широком — два.
 *
 * Больше двух не делаем: в карточке есть описание в пару строк, и на третьем
 * столбце оно превращается в лесенку из одиночных слов.
 *
 * Карточки в ряду тянутся до одной высоты (`items-stretch` по умолчанию, а
 * `h-full` на самой карточке доводит её до края ячейки). Иначе высоту ряда всё
 * равно задаёт самая длинная карточка, а короткая соседка кончается выше — и
 * между рядами появляются рваные пустоты неодинакового размера, будто список
 * собран криво.
 */
export function CardGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-1.5 [&>*]:h-full">{children}</div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="block text-[12px] font-medium mb-1.5">{label}</label>
      {hint && <p className="text-[11px] text-text-dim mb-2 leading-relaxed">{hint}</p>}
      {children}
    </div>
  );
}


/**
 * Устройства и коды подключения.
 *
 * Отсюда выдаётся код, который вводят на телефоне или на другом компьютере.
 * Права нового устройства нельзя поднять выше своих — ядро это проверяет, но
 * и в интерфейсе незачем предлагать то, что всё равно отклонят.
 */
export function DevicesPanel({
  client,
  devices,
  connection,
  onReconnect,
}: {
  client: AxonClient;
  devices: Device[];
  connection: Connection | null;
  onReconnect: () => void;
}) {
  const [autostart, setAutostart] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [code, setCode] = useState<{ value: string; expiresAt: number } | null>(null);
  const [left, setLeft] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [scopes, setScopes] = useState<'full' | 'chat'>('chat');

  useEffect(() => {
    void host().local?.autostart().then(setAutostart);
  }, []);

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => {
      const seconds = Math.max(0, Math.round((code.expiresAt - Date.now()) / 1000));
      setLeft(seconds);
      if (seconds === 0) setCode(null);
    }, 500);
    return () => clearInterval(timer);
  }, [code]);

  const issue = async (): Promise<void> => {
    setFailure(null);
    try {
      const result = await client.call('device.pairBegin', {
        name: 'Новое устройство',
        platform: 'desktop',
        scopes:
          scopes === 'full'
            ? [
                'chat.read',
                'chat.write',
                'tools.safe',
                'tools.sensitive',
                'tools.dangerous',
                'settings.write',
                'devices.manage',
              ]
            : ['chat.read', 'chat.write', 'tools.safe'],
        ttlSeconds: 300,
      });
      setCode({ value: result.code, expiresAt: Date.now() + result.expiresInSeconds * 1000 });
    } catch (e) {
      setFailure((e as Error).message);
    }
  };

  return (
    <Screen
      title="Устройства"
      icon="bi-hdd-network"
      width="wide"
      hint="Каждое устройство подключается своим токеном и со своими правами. Телефон в дороге и компьютер дома — разный уровень доверия, даже если человек один."
    >
      <div className="card p-4 mb-5">
        <p className="text-[13px] font-medium mb-1">Подключить ещё одно устройство</p>
        <p className="text-[11px] text-text-dim leading-relaxed mb-3">
          Код одноразовый и живёт пять минут. Введите его в приложении на другом устройстве.
        </p>

        <div className="seg mb-3">
          <button type="button" aria-pressed={scopes === 'chat'} onClick={() => setScopes('chat')}>
            Только чат
          </button>
          <button type="button" aria-pressed={scopes === 'full'} onClick={() => setScopes('full')}>
            Полный доступ
          </button>
        </div>

        {code ? (
          <div className="rounded-xl2 border border-border bg-bg p-4 text-center">
            <p className="font-mono text-[26px] tracking-[0.25em]">{code.value}</p>
            <p className="mt-2 text-[11px] text-text-dim">
              действует ещё {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void issue()}
            className="h-9 px-4 rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors"
          >
            Выдать код
          </button>
        )}

        {failure && <p className="mt-3 text-[12px] text-danger">{failure}</p>}
      </div>

      <p className="text-[12px] font-medium mb-2">Подключённые устройства</p>
      <div className="flex flex-col gap-1.5">
        {devices.map((device) => (
          <div key={device.id} className="card group flex items-center gap-3 px-3 py-2.5">
            <i className={clsx('bi', PLATFORM_ICON[device.platform] ?? 'bi-question-circle')} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] truncate">{device.name}</p>
              <p className="text-[10px] text-text-dim font-mono truncate">
                {device.scopes.length} прав · с {new Date(device.pairedAt).toLocaleDateString('ru')}
              </p>
            </div>
            <button
              type="button"
              title="Отозвать доступ"
              onClick={() => void client.call('device.revoke', { id: device.id })}
              className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-text-dim opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-bg-hover transition-all"
            >
              <i className="bi bi-x-lg text-[12px]" />
            </button>
          </div>
        ))}
      </div>
    </Screen>
  );
}

const PLATFORM_ICON: Record<string, string> = {
  desktop: 'bi-pc-display',
  mobile: 'bi-phone',
  web: 'bi-browser-chrome',
  telegram: 'bi-telegram',
  cli: 'bi-terminal',
};

export function MemoryPanel({
  facts,
  observations,
  client,
}: {
  facts: Fact[];
  observations: Observation[];
  client: AxonClient;
}) {
  /**
   * Наблюдения сверху, факты снизу.
   *
   * Не по важности, а по тому, что человек пришёл проверить. Факты он агенту
   * сам и сказал — сюрпризов там нет. Наблюдения агент вывел сам, и именно их
   * хочется прочитать: согласиться, поморщиться или выкинуть.
   */
  const empty = facts.length === 0 && observations.length === 0;

  return (
    <Screen
      title="Память"
      icon="bi-journal-bookmark-fill"
      width="wide"
      hint="Что агент знает о вас и что успел заметить. Всё это подставляется в каждый разговор — в стабильную часть промпта, поэтому кэш не ломает."
    >
      {empty ? (
        <Empty
          icon="bi-inbox"
          text="Пока пусто. Поговорите с агентом — он сам запомнит, что стоит помнить."
        />
      ) : (
        <div className="space-y-7">
          {observations.length > 0 && (
            <section>
              <MemoryHeading
                title="Наблюдения"
                note="Догадки агента о вас. Выцветают сами, если не подтверждаются."
              />
              <CardGrid>
                {observations.map((observation) => (
                  <div
                    key={observation.id}
                    className="card group flex items-start gap-3 px-3 py-2.5 hover:border-border-strong transition-colors"
                  >
                    <i className="bi bi-eye text-accent text-[13px] mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] break-words leading-snug">{observation.text}</p>
                      <p className="mt-1 text-[11px] text-text-dim">
                        {OBSERVATION_KINDS[observation.kind]}
                        {observation.hits > 1 && ` · подтверждено ${observation.hits} раза`}
                      </p>
                    </div>
                    <button
                      type="button"
                      title="Отбросить"
                      onClick={() => void client.call('observation.forget', { id: observation.id })}
                      className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-text-dim opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-bg-hover transition-all"
                    >
                      <i className="bi bi-trash text-[12px]" />
                    </button>
                  </div>
                ))}
              </CardGrid>
            </section>
          )}

          {facts.length > 0 && (
            <section>
              <MemoryHeading title="Факты" note="То, что вы сказали прямо или агент проверил." />
              <CardGrid>
                {facts.map((fact) => (
                  <div
                    key={fact.id}
                    className="card group flex items-start gap-3 px-3 py-2.5 hover:border-border-strong transition-colors"
                  >
                    <i className="bi bi-dot text-accent text-xl leading-none -ml-1" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-text-dim">{fact.key}</p>
                      <p className="mt-0.5 text-[13px] break-words">{fact.value}</p>
                    </div>
                    <span className="shrink-0 text-[10px] text-text-dim font-mono">
                      {fact.origin === 'user' ? 'сказано' : 'выведено'}
                    </span>
                    <button
                      type="button"
                      title="Забыть"
                      onClick={() => void client.call('fact.forget', { id: fact.id })}
                      className="shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-text-dim opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-bg-hover transition-all"
                    >
                      <i className="bi bi-trash text-[12px]" />
                    </button>
                  </div>
                ))}
              </CardGrid>
            </section>
          )}
        </div>
      )}
    </Screen>
  );
}

function MemoryHeading({ title, note }: { title: string; note: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      <p className="mt-0.5 text-[11px] text-text-dim leading-relaxed">{note}</p>
    </div>
  );
}

/**
 * Метка происхождения: свой плагин или обёртка вокруг MCP-сервера.
 *
 * Заметная, а не подпись в скобках. Разница существенная для человека: у
 * MCP-сервера чужой автор, свой процесс и свой темп обновлений, а «плагин» —
 * это код, написанный под Axon.
 *
 * Обе метки цветные, и обе — своим цветом, а не акцентным. В чёрно-белых
 * темах акцент сам почти серый, поэтому «выделить акцентом» там ничего не
 * выделяет; а серая метка рядом с цветной читается как второстепенная, хотя
 * второстепенной ни одна из них не является.
 */
export function KindBadge({ mcp }: { mcp: boolean }) {
  return (
    <span
      className={clsx(
        'shrink-0 text-[9px] font-bold tracking-[0.08em] px-1.5 py-0.5 rounded border leading-none',
        mcp
          ? 'text-info border-info/45 bg-info/12'
          : 'text-success border-success/45 bg-success/12',
      )}
    >
      {mcp ? 'MCP' : 'PLUGIN'}
    </span>
  );
}

export const TIER: Record<RiskTier, { label: string; tone: string; icon: string }> = {
  safe: { label: 'безопасный', tone: 'text-success', icon: 'bi-shield-check' },
  sensitive: { label: 'внешние системы', tone: 'text-warning', icon: 'bi-shield-exclamation' },
  dangerous: { label: 'опасный', tone: 'text-danger', icon: 'bi-exclamation-octagon' },
};

/** Переключатель. Одинаковый у инструментов, скиллов и плагинов — по смыслу это одно. */
export function Toggle({
  on,
  onClick,
  title,
}: {
  on: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title ?? (on ? 'Выключить' : 'Включить')}
      onClick={onClick}
      className={clsx(
        'mt-0.5 w-9 h-5 shrink-0 rounded-full transition-colors',
        on ? 'bg-accent' : 'bg-surface-high border border-border',
      )}
    >
      <span
        className={clsx(
          'block w-4 h-4 rounded-full transition-transform',
          on ? 'translate-x-[18px] bg-accent-fg' : 'translate-x-0.5 bg-text-dim',
        )}
      />
    </button>
  );
}

/**
 * Инструменты и скиллы.
 *
 * Список группируется по источнику и умеет искать не для красоты: один
 * MCP-сервер приносит десяток инструментов, три плагина — сотню. Плоский
 * перечень, в котором встроенный `read_file` теряется между двадцатью
 * `github_*`, перестаёт быть пригодным примерно на третьем плагине.
 */
export function ToolsPanel({
  tools,
  plugins,
  client,
}: {
  tools: ToolInfo[];
  plugins: PluginInfo[];
  client: AxonClient;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const needle = query.trim().toLowerCase();
  const matches = (text: string): boolean => text.toLowerCase().includes(needle);

  const visible = needle
    ? tools.filter((tool) => matches(tool.name) || matches(tool.description) || matches(tool.title))
    : tools;

  // Имена групп берём у плагинов: `plugin:github` человеку ничего не говорит.
  const titleOf = (source: string): string => {
    if (source === 'builtin') return 'Встроенные';
    const id = source.startsWith('plugin:') ? source.slice(7) : source;
    return plugins.find((plugin) => plugin.id === id)?.name ?? id;
  };

  /**
   * Обёртка вокруг MCP-сервера или плагин со своим кодом.
   *
   * Признак — объявленные сервера: у чистой обёртки они есть, у плагина с
   * собственными инструментами их нет. Гибрид теоретически возможен, и тогда
   * MCP — более информативная из двух меток.
   */
  const isMcp = (source: string): boolean => {
    const id = source.startsWith('plugin:') ? source.slice(7) : source;
    return (plugins.find((plugin) => plugin.id === id)?.mcpServers.length ?? 0) > 0;
  };

  const groups = new Map<string, ToolInfo[]>();
  for (const tool of visible) {
    const list = groups.get(tool.source) ?? [];
    list.push(tool);
    groups.set(tool.source, list);
  }
  // Встроенные всегда первыми: это то, что есть у всех и всегда.
  const ordered = [...groups.entries()].sort(([a], [b]) =>
    a === 'builtin' ? -1 : b === 'builtin' ? 1 : titleOf(a).localeCompare(titleOf(b)),
  );

  // Скиллы живут здесь же: для пользователя это одно решение — «что агент
  // умеет и о чём знает». Разводить их по разным экранам значило бы заставить
  // его помнить нашу таксономию.
  const skills = plugins
    .flatMap((plugin) => plugin.skills.map((skill) => ({ ...skill, plugin: plugin.name })))
    .filter((skill) => !needle || matches(skill.name) || matches(skill.description));

  const off = tools.filter((tool) => !tool.enabled).length;

  return (
    <Screen
      title="Инструменты"
      icon="bi-tools"
      width="wide"
      hint="Выключенный инструмент не попадает в контекст модели — она о нём просто не знает и не тратит на него токены."
      actions={
        <div className="relative w-56">
          <i className="bi bi-search absolute left-3 top-1/2 -translate-y-1/2 text-[11px] text-text-dim pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по инструментам…"
            className="input pl-8 h-8 text-[12px]"
          />
        </div>
      }
    >
      {off > 0 && (
        <p className="-mt-3 mb-4 text-[11px] text-text-dim">
          Выключено: {off} из {tools.length}
        </p>
      )}

      {ordered.length === 0 && (
        <Empty icon="bi-search" text="Ничего не нашлось. Попробуйте другое слово." />
      )}

      {ordered.map(([source, list]) => {
        const hidden = collapsed.has(source);
        return (
          <div key={source} className="mb-5">
            <button
              type="button"
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(source)) next.delete(source);
                  else next.add(source);
                  return next;
                })
              }
              className="w-full flex items-center gap-2 mb-2 text-left group"
            >
              <i
                className={clsx(
                  'bi text-[10px] text-text-dim transition-transform',
                  hidden ? 'bi-chevron-right' : 'bi-chevron-down',
                )}
              />
              <span className="text-[13px] font-semibold">{titleOf(source)}</span>
              <span className="text-[11px] text-text-dim">{list.length}</span>
              {source !== 'builtin' && <KindBadge mcp={isMcp(source)} />}
              <span className="flex-1 border-b border-border/60 ml-2" />
            </button>

            {!hidden && (
              <CardGrid>
                {list.map((tool) => (
                  <ToolCard key={tool.name} tool={tool} client={client} />
                ))}
              </CardGrid>
            )}
          </div>
        );
      })}

      {skills.length > 0 && (
        <div className="mb-5">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[13px] font-semibold">Скиллы</span>
            <span className="text-[11px] text-text-dim">{skills.length}</span>
            <span className="flex-1 border-b border-border/60 ml-2" />
          </div>
          <p className="mb-3 text-[11px] text-text-dim leading-relaxed max-w-2xl">
            Инструкции текстом. В контексте всегда висит только название и описание — тело агент
            читает сам, когда задача под него подходит.
          </p>

          <CardGrid>
            {skills.map((skill) => (
              <div key={skill.id} className="card flex items-start gap-3 px-3 py-2.5">
                <i className="bi bi-file-earmark-text text-accent mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] font-medium">{skill.name}</span>
                    <span className="text-[10px] text-text-dim">
                      {skill.plugin} · ~{compact(skill.tokens)} токенов
                    </span>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
                    {skill.description}
                  </p>
                </div>
                <Toggle
                  on={skill.enabled}
                  onClick={() =>
                    void client.call('skill.setEnabled', { id: skill.id, enabled: !skill.enabled })
                  }
                />
              </div>
            ))}
          </CardGrid>
        </div>
      )}
    </Screen>
  );
}

function ToolCard({ tool, client }: { tool: ToolInfo; client: AxonClient }) {
  const tier = TIER[tool.tier];

  return (
    <div className={clsx('card flex items-start gap-3 px-3 py-2.5', !tool.enabled && 'opacity-60')}>
      <i className={clsx('bi', tier.icon, tier.tone, 'mt-0.5')} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[12px] break-all">{tool.name}</span>
          <span className={clsx('text-[10px]', tier.tone)}>{tier.label}</span>
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{tool.description}</p>
      </div>

      <Toggle
        on={tool.enabled}
        onClick={() =>
          void client.call('tool.setEnabled', { name: tool.name, enabled: !tool.enabled })
        }
      />
    </div>
  );
}

interface UsageSummary {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  runs: number;
  byModel: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
}

export function UsagePanel({ client }: { client: AxonClient }) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  useEffect(() => {
    void client.call('usage.summary', {}).then(setSummary);
  }, []);

  if (!summary) {
    return (
      <Screen title="Расход" icon="bi-graph-up">
        <Empty icon="bi-hourglass" text="Считаем…" />
      </Screen>
    );
  }

  const total = summary.inputTokens + summary.cachedInputTokens;
  const cacheShare = total > 0 ? Math.round((summary.cachedInputTokens / total) * 100) : 0;

  return (
    <Screen title="Расход за сегодня" icon="bi-graph-up">
      <div className="grid grid-cols-4 gap-2 mb-5">
        <Stat icon="bi-play-circle" label="прогонов" value={String(summary.runs)} />
        <Stat icon="bi-box-arrow-in-right" label="на входе" value={compact(summary.inputTokens)} />
        <Stat icon="bi-box-arrow-right" label="на выходе" value={compact(summary.outputTokens)} />
        <Stat icon="bi-cash" label="стоимость" value={`$${summary.costUsd.toFixed(3)}`} />
      </div>

      <div className="card p-3.5 mb-5">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-[12px] text-text-muted flex items-center gap-1.5">
            <i className="bi bi-lightning-charge-fill text-success" />
            Из кэша промпта
          </span>
          <span className="font-mono text-[15px]">{cacheShare}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-surface-high overflow-hidden">
          <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${cacheShare}%` }} />
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-text-dim">
          Чтение из кэша примерно вдесятеро дешевле обычного ввода. Если доля держится около
          нуля на длинном разговоре — кэш ломается, и это самая дорогая из незаметных ошибок.
        </p>
      </div>

      {summary.byModel.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {summary.byModel.map((row) => (
            <div
              key={`${row.provider}/${row.model}`}
              className="card flex items-center gap-3 px-3 py-2.5"
            >
              <i className="bi bi-cpu text-text-dim" />
              <span className="font-mono text-[12px] truncate">{row.model}</span>
              <span className="text-[10px] text-text-dim">{row.provider}</span>
              <span className="ml-auto font-mono text-[12px] text-text-muted">
                ${row.costUsd.toFixed(3)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Screen>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="card px-3 py-2.5">
      <i className={clsx('bi', icon, 'text-[13px] text-text-dim')} />
      <p className="mt-1.5 font-mono text-[17px] leading-none">{value}</p>
      <p className="mt-1.5 text-[10px] text-text-dim">{label}</p>
    </div>
  );
}

export function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <i className={clsx('bi', icon, 'text-3xl text-text-dim')} />
      <p className="mt-3 text-[13px] text-text-muted max-w-xs leading-relaxed">{text}</p>
    </div>
  );
}

export function compact(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
