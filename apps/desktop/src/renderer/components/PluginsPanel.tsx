import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import { parseMcpConfig } from '@axon/protocol';
import type {
  CatalogEntry,
  PluginAction,
  PluginInfo,
  PluginSettingField,
  PluginStatus,
} from '@axon/protocol';
import { Empty, KindBadge, Screen, TIER, Toggle } from './Panels.js';

/**
 * Состояние плагина глазами пользователя.
 *
 * Пять состояний вместо двух — не усложнение, а следствие того, что «не
 * работает» бывает по разным причинам, и лечатся они по-разному: выключенный
 * включают, ненастроенный настраивают, упавший смотрят в логах.
 */
const STATUS: Record<PluginStatus, { label: string; tone: string; dot: string }> = {
  ready: { label: 'работает', tone: 'text-success', dot: 'bg-success' },
  starting: { label: 'запускается', tone: 'text-text-muted', dot: 'bg-warning animate-pulse' },
  needs_setup: { label: 'нужна настройка', tone: 'text-warning', dot: 'bg-warning' },
  failed: { label: 'не работает', tone: 'text-danger', dot: 'bg-danger' },
  disabled: { label: 'выключен', tone: 'text-text-dim', dot: 'bg-text-dim' },
};

/** Пример конфигурации в поле ввода: ровно то, что лежит в README серверов. */
const MCP_EXAMPLE = `{
  "mcpServers": {
    "мой-сервер": {
      "command": "npx",
      "args": ["-y", "@автор/mcp-server"]
    }
  }
}`;

const PERMISSION: Record<string, string> = {
  fs: 'файлы на диске',
  net: 'доступ в сеть',
  shell: 'запуск программ',
  secrets: 'свои секреты',
  journal: 'чтение переписки',
};

export function PluginsPanel({ plugins, client }: { plugins: PluginInfo[]; client: AxonClient }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(label);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen
      title="Плагины"
      icon="bi-puzzle-fill"
      width="wide"
      hint="Плагин приносит агенту новые возможности: свои инструменты, подключения к MCP-серверам и скиллы. Каждый работает отдельным процессом — упавший плагин не роняет ядро."
      actions={
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="h-8 px-3 rounded-lg bg-accent text-accent-fg text-[12px] font-medium hover:opacity-90 transition-opacity flex items-center gap-1.5"
        >
          <i className="bi bi-plus-lg text-[11px]" />
          Добавить плагин
        </button>
      }
    >
      {failure && <Failure text={failure} onClose={() => setFailure(null)} />}

      {plugins.length === 0 ? (
        <Empty
          icon="bi-puzzle"
          text="Плагинов пока нет. Нажмите «Добавить плагин» — в каталоге есть документация библиотек, браузер и файлы."
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {plugins.map((plugin) => (
            <PluginCard
              key={plugin.id}
              plugin={plugin}
              client={client}
              busy={busy === plugin.id}
              onAction={(action) => run(plugin.id, action)}
            />
          ))}
        </div>
      )}

      {adding && (
        <AddDialog
          client={client}
          installed={new Set(plugins.map((p) => p.id))}
          onClose={() => setAdding(false)}
        />
      )}
    </Screen>
  );
}

function Failure({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="card mb-4 px-3 py-2.5 border-danger/40 flex items-start gap-2.5">
      <i className="bi bi-exclamation-triangle text-danger mt-0.5" />
      <p className="text-[12px] leading-relaxed text-text-muted flex-1">{text}</p>
      <button type="button" onClick={onClose} className="text-text-dim hover:text-text">
        <i className="bi bi-x-lg text-[11px]" />
      </button>
    </div>
  );
}

// ─── Добавление ─────────────────────────────────────────────────────────────

type Way = 'catalog' | 'mcp' | 'git';

const WAYS: Array<{ id: Way; title: string; icon: string }> = [
  { id: 'catalog', title: 'Каталог', icon: 'bi-box-seam' },
  { id: 'mcp', title: 'MCP-сервер', icon: 'bi-plug' },
  { id: 'git', title: 'Репозиторий', icon: 'bi-git' },
];

type RunFn = (label: string, action: () => Promise<unknown>) => Promise<void>;

/**
 * Окно установки.
 *
 * Раньше все три способа лежали секциями на самом экране, друг под другом, и
 * ссылка на репозиторий оказывалась в самом низу длинной страницы. Установка —
 * действие редкое, а занимала две трети места; список установленного, на
 * который смотрят каждый день, ютился сверху.
 *
 * Способы разведены вкладками, а не секциями: это выбор одного из трёх, а не
 * последовательность шагов, и пролистывать мимо двух ненужных не надо.
 */
function AddDialog({
  client,
  installed,
  onClose,
}: {
  client: AxonClient;
  installed: Set<string>;
  onClose: () => void;
}) {
  const [way, setWay] = useState<Way>('catalog');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const run: RunFn = async (label, action) => {
    setBusy(label);
    setFailure(null);
    try {
      await action();
      onClose();
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-2xl max-h-[80vh] flex flex-col rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <i className="bi bi-plus-circle text-accent" />
          <h3 className="text-[15px] font-semibold flex-1">Добавить плагин</h3>
          <button type="button" onClick={onClose} className="text-text-dim hover:text-text">
            <i className="bi bi-x-lg text-[12px]" />
          </button>
        </div>

        <div className="px-5">
          <div className="seg w-full">
            {WAYS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={way === item.id}
                onClick={() => setWay(item.id)}
                className="flex-1 flex items-center justify-center gap-1.5"
              >
                <i className={clsx('bi', item.icon, 'text-[11px]')} />
                {item.title}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar px-5 py-4">
          {failure && <Failure text={failure} onClose={() => setFailure(null)} />}

          {way === 'catalog' && (
            <CatalogWay client={client} installed={installed} busy={busy} onRun={run} />
          )}
          {way === 'mcp' && <McpWay client={client} busy={busy} onRun={run} />}
          {way === 'git' && <GitWay client={client} busy={busy} onRun={run} />}
        </div>
      </div>
    </div>
  );
}

function CatalogWay({
  client,
  installed,
  busy,
  onRun,
}: {
  client: AxonClient;
  installed: Set<string>;
  busy: string | null;
  onRun: RunFn;
}) {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [setup, setSetup] = useState<CatalogEntry | null>(null);

  useEffect(() => {
    void client
      .call('plugin.catalog', {})
      .then((res) => setCatalog(res.entries))
      // Отличать «каталог пуст» от «каталог не приехал» обязательно: иначе
      // старое ядро, не знающее про плагины, выглядит как ядро без каталога,
      // и человек ищет проблему не там.
      .catch(() => setCatalog(null));
  }, []);

  const available = (catalog ?? []).filter((entry) => !installed.has(entry.id));

  if (catalog === null) {
    return (
      <p className="text-[12px] text-warning">
        Ядро не отдало каталог — скорее всего, оно старее приложения. Обновите ядро.
      </p>
    );
  }

  if (available.length === 0) {
    return <p className="text-[12px] text-text-dim">Всё из каталога уже установлено.</p>;
  }

  return (
    <>
      <p className="mb-3 text-[11px] text-text-dim leading-relaxed">
        Проверенные плагины. Список едет вместе с ядром, поэтому работает и без интернета — но это
        закладки, а не граница возможного: соседние вкладки ставят что угодно.
      </p>

      <div className="flex flex-col gap-1.5">
        {available.map((entry) => (
          <div key={entry.id} className="card flex items-start gap-3 px-3 py-2.5">
            <i className="bi bi-box-seam text-accent mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[13px] font-medium">{entry.name}</span>
                <KindBadge mcp={entry.install.type === 'mcp'} />
                {entry.tags.map((tag) => (
                  <span
                    key={tag}
                    className="text-[10px] px-1.5 py-px rounded bg-surface-high text-text-dim"
                  >
                    {tag}
                  </span>
                ))}
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{entry.description}</p>
              {entry.permissions.length > 0 && (
                <p className="mt-1.5 text-[11px] text-text-dim">
                  <i className="bi bi-shield-lock mr-1" />
                  Запрашивает: {entry.permissions.map((p) => PERMISSION[p] ?? p).join(', ')}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                // Плагин, которому нужен токен, нельзя ставить молча: без него
                // он всё равно поднимется в состояние «нужна настройка».
                if (entry.setup.length > 0) setSetup(entry);
                else
                  void onRun(entry.id, () =>
                    client.call('plugin.install', {
                      source: { type: 'catalog', id: entry.id, values: {} },
                    }),
                  );
              }}
              className="shrink-0 h-8 px-3 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              {busy === entry.id ? '…' : 'Поставить'}
            </button>
          </div>
        ))}
      </div>

      {setup && (
        <SetupDialog
          entry={setup}
          onCancel={() => setSetup(null)}
          onSubmit={(values) => {
            const entry = setup;
            setSetup(null);
            void onRun(entry.id, () =>
              client.call('plugin.install', {
                source: { type: 'catalog', id: entry.id, values },
              }),
            );
          }}
        />
      )}
    </>
  );
}

function McpWay({ client, busy, onRun }: { client: AxonClient; busy: string | null; onRun: RunFn }) {
  const [json, setJson] = useState('');

  // Разбираем по ходу набора: человек видит, что получилось, до того как
  // нажмёт «Поставить», а не после отказа.
  const parsed = useMemo(() => {
    if (!json.trim()) return { servers: null, problem: null };
    try {
      return { servers: parseMcpConfig(json), problem: null };
    } catch (error) {
      return { servers: null, problem: (error as Error).message };
    }
  }, [json]);

  const servers = parsed.servers;
  const preview = servers?.map((server) => `${server.name} (${server.transport.type})`).join(', ');

  return (
    <>
      <p className="mb-3 text-[11px] text-text-dim leading-relaxed">
        Вставьте конфигурацию MCP-сервера в том виде, в каком она написана в его README, — для
        Claude Desktop, VS Code или любую другую. Своего формата у Axon нет намеренно: переписывать
        готовый кусок JSON в чужие поля никто не станет.
      </p>

      <textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        rows={8}
        spellCheck={false}
        placeholder={MCP_EXAMPLE}
        className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-[11px] font-mono leading-relaxed outline-none focus:border-accent transition-colors resize-y scrollbar"
      />

      {preview && (
        <p className="mt-1.5 text-[11px] text-success">
          <i className="bi bi-check2 mr-1" />
          Разобрано: {preview}
        </p>
      )}
      {parsed.problem && <p className="mt-1.5 text-[11px] text-warning">{parsed.problem}</p>}

      <button
        type="button"
        disabled={!servers || busy !== null}
        onClick={() => {
          if (!servers) return;
          // Один конфиг может описывать несколько серверов — ставим каждый
          // отдельным плагином, чтобы их можно было включать по одному.
          void onRun('mcp', async () => {
            for (const server of servers) {
              await client.call('plugin.install', {
                source: { type: 'mcp', name: server.name, transport: server.transport },
              });
            }
          });
        }}
        className="mt-3 h-9 px-4 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {busy === 'mcp' ? 'Ставлю…' : 'Поставить'}
      </button>
    </>
  );
}

function GitWay({ client, busy, onRun }: { client: AxonClient; busy: string | null; onRun: RunFn }) {
  const [url, setUrl] = useState('');

  const install = (): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    void onRun('git', () =>
      client.call('plugin.install', { source: { type: 'git', url: trimmed } }),
    );
  };

  return (
    <>
      <p className="mb-3 text-[11px] text-text-dim leading-relaxed">
        Ядро склонирует репозиторий к себе и запустит плагин отдельным процессом.
      </p>

      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && install()}
        placeholder="https://github.com/автор/axon-plugin-…"
        className="w-full h-9 px-3 rounded-lg bg-bg border border-border text-[12px] font-mono outline-none focus:border-accent transition-colors"
      />

      <div className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-warning/10 border border-warning/30">
        <i className="bi bi-exclamation-triangle text-warning text-[12px] mt-0.5" />
        <p className="text-[11px] text-text-muted leading-relaxed">
          Код чужого плагина выполняется на машине ядра с вашими правами. Отдельный процесс
          защищает от падений, но не от намерений — ставьте только то, чему доверяете.
        </p>
      </div>

      <button
        type="button"
        disabled={!url.trim() || busy !== null}
        onClick={install}
        className="mt-3 h-9 px-4 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {busy === 'git' ? 'Клонирую…' : 'Поставить'}
      </button>
    </>
  );
}

function PluginCard({
  plugin,
  client,
  busy,
  onAction,
}: {
  plugin: PluginInfo;
  client: AxonClient;
  busy: boolean;
  onAction: (action: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<Array<{ at: string; level: string; text: string }> | null>(null);
  const status = STATUS[plugin.status];

  const showLogs = (): void => {
    if (logs) return setLogs(null);
    void client
      .call('plugin.logs', { id: plugin.id })
      .then((res) => setLogs(res.lines.length ? res.lines : [{ at: '', level: '', text: 'Пусто' }]))
      .catch(() => setLogs([{ at: '', level: 'error', text: 'Логи недоступны' }]));
  };

  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className={clsx('mt-2 w-1.5 h-1.5 rounded-full shrink-0', status.dot)} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium">{plugin.name}</span>
            <KindBadge mcp={plugin.mcpServers.length > 0} />
            <span className="text-[10px] text-text-dim font-mono">{plugin.version}</span>
            <span className={clsx('text-[10px]', status.tone)}>{status.label}</span>
          </div>

          <p className="mt-1 text-[12px] leading-relaxed text-text-muted">{plugin.description}</p>

          {plugin.error && (
            <p className="mt-1.5 text-[11px] text-danger leading-relaxed">{plugin.error}</p>
          )}

          <div className="mt-2 flex items-center gap-3 flex-wrap text-[11px] text-text-dim">
            {plugin.tools.length > 0 && (
              <span>
                <i className="bi bi-tools mr-1" />
                {plugin.tools.length} инстр.
              </span>
            )}
            {plugin.skills.length > 0 && (
              <span>
                <i className="bi bi-file-earmark-text mr-1" />
                {plugin.skills.length} скилл.
              </span>
            )}
            {plugin.mcpServers.map((server) => (
              <span key={server.name} className={STATUS[server.status].tone}>
                <i className="bi bi-plug mr-1" />
                {server.name}
              </span>
            ))}
            {plugin.jobs.map((job) => (
              <span key={job.name}>
                <i className="bi bi-clock-history mr-1" />
                {job.name} · раз в {Math.round(job.everySeconds / 60)} мин
              </span>
            ))}
          </div>
        </div>

        <Toggle
          on={plugin.enabled}
          onClick={() =>
            onAction(() =>
              client.call('plugin.setEnabled', { id: plugin.id, enabled: !plugin.enabled }),
            )
          }
        />
      </div>

      <div className="mt-2.5 pl-4 flex items-center gap-1.5 flex-wrap">
        {(plugin.settings.length > 0 || plugin.actions.length > 0) && (
          <MiniButton icon="bi-gear-fill" label="Настройки" onClick={() => setOpen(true)} />
        )}
        <MiniButton icon="bi-terminal" label="Логи" active={logs !== null} onClick={showLogs} />
        {plugin.origin.type === 'git' && (
          <MiniButton
            icon="bi-download"
            label={busy ? '…' : 'Обновить'}
            onClick={() => onAction(() => client.call('plugin.update', { id: plugin.id }))}
          />
        )}
        <MiniButton
          icon="bi-arrow-clockwise"
          label={busy ? '…' : 'Перезапустить'}
          onClick={() => onAction(() => client.call('plugin.reload', { id: plugin.id }))}
        />
        <MiniButton
          icon="bi-trash3"
          label="Удалить"
          danger
          onClick={() => onAction(() => client.call('plugin.remove', { id: plugin.id }))}
        />
        {plugin.homepage && (
          <a
            href={plugin.homepage}
            target="_blank"
            rel="noreferrer"
            className="h-7 px-2 rounded-lg text-[11px] text-text-dim hover:bg-bg-hover hover:text-text transition-colors flex items-center gap-1.5"
          >
            <i className="bi bi-box-arrow-up-right" />
            Сайт
          </a>
        )}
      </div>

      {open && plugin.settings.length > 0 && (
        <PluginSettings plugin={plugin} client={client} onClose={() => setOpen(false)} />
      )}

      {logs && (
        <pre className="mt-2.5 ml-4 p-2.5 rounded-lg bg-bg border border-border text-[10px] font-mono leading-relaxed text-text-muted overflow-x-auto scrollbar max-h-56 overflow-y-auto">
          {logs.map((line, index) => (
            <div key={index} className={line.level === 'error' ? 'text-danger' : undefined}>
              {line.text}
            </div>
          ))}
        </pre>
      )}

      {plugin.tools.length > 0 && (
        <div className="mt-2 ml-4 flex flex-wrap gap-1">
          {plugin.tools.map((tool) => (
            <span
              key={tool.name}
              title={tool.title}
              className={clsx(
                'text-[10px] font-mono px-1.5 py-px rounded bg-surface-high',
                TIER[tool.tier].tone,
              )}
            >
              {tool.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniButton({
  icon,
  label,
  onClick,
  active = false,
  danger = false,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'h-7 px-2 rounded-lg text-[11px] flex items-center gap-1.5 transition-colors',
        danger
          ? 'text-text-dim hover:bg-danger/10 hover:text-danger'
          : active
            ? 'bg-bg-hover text-accent'
            : 'text-text-dim hover:bg-bg-hover hover:text-text',
      )}
    >
      <i className={clsx('bi', icon)} />
      {label}
    </button>
  );
}

// ─── Форма настроек ────────────────────────────────────────────────────────

/**
 * Страница настроек плагина.
 *
 * Раньше это была форма, разворачивавшаяся прямо в карточке. Пока полей три,
 * так и лучше; но плагин с десятком полей, разделами и кнопкой «проверить
 * подключение» превращал список плагинов в простыню, где не найти ни сам
 * список, ни нужное поле.
 *
 * Плагин описывает страницу, а рисует её приложение. Ни разметки, ни кода для
 * окна плагин не присылает — иначе его код оказался бы в окне с полным
 * доступом к ядру, ровно там, откуда его убрали отдельным процессом.
 */
function PluginSettings({
  plugin,
  client,
  onClose,
}: {
  plugin: PluginInfo;
  client: AxonClient;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  /** Значение поля с учётом несохранённой правки. */
  const valueOf = (key: string): unknown =>
    draft[key] ?? (plugin.settingValues[key] as string | undefined);

  /**
   * Показывать ли поле.
   *
   * Условие смотрит на текущее значение, включая ещё не сохранённое: человек
   * выбирает способ подключения и тут же видит поля именно для него, а не
   * после сохранения.
   */
  const visible = (field: PluginSettingField): boolean => {
    if (!field.visibleWhen) return true;
    return String(valueOf(field.visibleWhen.key) ?? '') === String(field.visibleWhen.equals ?? '');
  };

  const shown = plugin.settings.filter(visible);
  const grouped = new Set(plugin.sections.flatMap((section) => section.fields));
  const loose = shown.filter((field) => !grouped.has(field.key));

  const save = (): void => {
    setSaving(true);
    const values: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};

    for (const field of plugin.settings) {
      const raw = draft[field.key];
      if (raw === undefined) continue;
      if (field.type === 'secret') secrets[field.key] = raw;
      else if (field.type === 'number') values[field.key] = Number(raw);
      else if (field.type === 'boolean') values[field.key] = raw === 'true';
      else values[field.key] = raw;
    }

    void client
      .call('plugin.configure', { id: plugin.id, values, secrets })
      .then(() => {
        setDraft({});
        setSaid({ ok: true, text: 'Сохранено' });
      })
      .catch((error: Error) => setSaid({ ok: false, text: error.message }))
      .finally(() => setSaving(false));
  };

  const act = (action: PluginAction): void => {
    if (action.confirm && !window.confirm(action.confirm)) return;

    setRunning(action.name);
    setSaid(null);
    void client
      .call('plugin.action', { id: plugin.id, action: action.name })
      .then((res) => setSaid({ ok: res.ok, text: res.message }))
      .catch((error: Error) => setSaid({ ok: false, text: error.message }))
      .finally(() => setRunning(null));
  };

  const field = (key: string) => {
    const found = shown.find((item) => item.key === key);
    if (!found) return null;
    return (
      <FieldInput
        key={found.key}
        field={found}
        current={plugin.settingValues[found.key]}
        value={draft[found.key]}
        onChange={(value) => setDraft((d) => ({ ...d, [found.key]: value }))}
      />
    );
  };

  const buttons = (section?: string) =>
    plugin.actions
      .filter((action) => (action.section ?? '') === (section ?? ''))
      .map((action) => (
        <button
          key={action.name}
          type="button"
          title={action.description ?? ''}
          disabled={running !== null}
          onClick={() => act(action)}
          className="h-8 px-3 rounded-lg border border-border text-[12px] text-text-muted hover:border-accent hover:text-text disabled:opacity-40 transition-colors"
        >
          {running === action.name ? '…' : action.label}
        </button>
      ));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-xl max-h-[80vh] flex flex-col rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <i className="bi bi-gear-fill text-accent" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold truncate">{plugin.name}</h3>
            <p className="text-[11px] text-text-dim truncate">{plugin.description}</p>
          </div>
          <button type="button" onClick={onClose} className="text-text-dim hover:text-text">
            <i className="bi bi-x-lg text-[12px]" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto scrollbar px-5 py-4 space-y-5">
          {plugin.sections.map((section) => (
            <section key={section.title}>
              <h4 className="text-[13px] font-semibold">{section.title}</h4>
              {section.description && (
                <p className="mt-1 mb-3 text-[11px] text-text-dim leading-relaxed">
                  {section.description}
                </p>
              )}
              {section.fields.map((key) => field(key))}
              <div className="mt-2 flex flex-wrap gap-1.5">{buttons(section.title)}</div>
            </section>
          ))}

          {loose.length > 0 && (
            <section>
              {plugin.sections.length > 0 && (
                <h4 className="text-[13px] font-semibold mb-2">Прочее</h4>
              )}
              {loose.map((item) => field(item.key))}
            </section>
          )}

          <div className="flex flex-wrap gap-1.5">{buttons()}</div>

          {said && (
            <p
              className={clsx(
                'text-[12px] leading-relaxed',
                said.ok ? 'text-success' : 'text-danger',
              )}
            >
              {said.text}
            </p>
          )}
        </div>

        <div className="px-5 py-4 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-4 rounded-lg border border-border text-[12px] text-text-muted hover:text-text transition-colors"
          >
            Закрыть
          </button>
          <button
            type="button"
            disabled={saving || Object.keys(draft).length === 0}
            onClick={save}
            className="h-9 px-4 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            {saving ? 'Сохраняю…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({
  field,
  current,
  value,
  onChange,
}: {
  field: PluginSettingField;
  current: unknown;
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  const placeholder =
    field.type === 'secret'
      ? current === true
        ? 'задан — введите новый, чтобы заменить'
        : (field.placeholder ?? 'не задан')
      : (field.placeholder ?? '');

  return (
    <div className="mb-3">
      <label className="block text-[11px] font-medium mb-1">
        {field.label}
        {field.required && <span className="text-danger ml-1">*</span>}
      </label>
      {field.description && (
        <p className="text-[10px] text-text-dim mb-1.5 leading-relaxed">{field.description}</p>
      )}

      {field.type === 'boolean' ? (
        <Toggle
          on={(value ?? String(current)) === 'true'}
          onClick={() => onChange(String((value ?? String(current)) !== 'true'))}
        />
      ) : field.type === 'textarea' ? (
        <textarea
          rows={5}
          value={value ?? String(current ?? '')}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-2 py-1.5 rounded-lg bg-surface border border-border text-[12px] font-mono leading-relaxed outline-none focus:border-accent transition-colors resize-y scrollbar"
        />
      ) : field.type === 'select' ? (
        <select
          value={value ?? String(current ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className="w-full h-8 px-2 rounded-lg bg-surface border border-border text-[12px] outline-none focus:border-accent transition-colors"
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text'}
          value={value ?? (field.type === 'secret' ? '' : String(current ?? ''))}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full h-8 px-2 rounded-lg bg-surface border border-border text-[12px] font-mono outline-none focus:border-accent transition-colors"
        />
      )}
    </div>
  );
}

// ─── Диалог установки ──────────────────────────────────────────────────────

function SetupDialog({
  entry,
  onCancel,
  onSubmit,
}: {
  entry: CatalogEntry;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const ready = entry.setup.every((field) => !field.required || values[field.key]?.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="card w-full max-w-md p-5 rise">
        <div className="flex items-center gap-2.5 mb-1">
          <i className="bi bi-box-seam text-accent" />
          <h3 className="text-[15px] font-semibold">{entry.name}</h3>
        </div>
        <p className="text-[12px] text-text-muted leading-relaxed mb-4">{entry.description}</p>

        {entry.setup.map((field) => (
          <FieldInput
            key={field.key}
            field={field}
            current={field.default}
            value={values[field.key]}
            onChange={(value) => setValues((v) => ({ ...v, [field.key]: value }))}
          />
        ))}

        <div className="flex gap-2 justify-end mt-4">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 px-4 rounded-lg border border-border text-[12px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => onSubmit(values)}
            className="h-9 px-4 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            Поставить
          </button>
        </div>
      </div>
    </div>
  );
}
