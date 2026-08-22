import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import { parseMcpConfig } from '@axon/protocol';
import type { CatalogEntry, PluginInfo, PluginSettingField, PluginStatus } from '@axon/protocol';
import { CardGrid, Empty, Screen, TIER, Toggle } from './Panels.js';

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

const PERMISSION: Record<string, string> = {
  fs: 'файлы на диске',
  net: 'доступ в сеть',
  shell: 'запуск программ',
  secrets: 'свои секреты',
  journal: 'чтение переписки',
};

export function PluginsPanel({ plugins, client }: { plugins: PluginInfo[]; client: AxonClient }) {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [installing, setInstalling] = useState<CatalogEntry | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [mcpJson, setMcpJson] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // Разбираем по ходу набора: человек видит, что получилось, до того как
  // нажмёт «Поставить», а не после отказа.
  const parsed = useMemo(() => {
    if (!mcpJson.trim()) return { servers: null, problem: null };
    try {
      return { servers: parseMcpConfig(mcpJson), problem: null };
    } catch (error) {
      return { servers: null, problem: (error as Error).message };
    }
  }, [mcpJson]);

  const mcpServers = parsed.servers;
  const mcpProblem = parsed.problem;
  const mcpPreview = mcpServers
    ?.map((server) => `${server.name} (${server.transport.type})`)
    .join(', ');

  useEffect(() => {
    void client
      .call('plugin.catalog', {})
      .then((res) => setCatalog(res.entries))
      // Отличать «каталог пуст» от «каталог не приехал» обязательно: иначе
      // старое ядро, не знающее про плагины, выглядит как ядро без каталога,
      // и человек ищет проблему не там.
      .catch(() => setCatalog(null));
  }, []);

  const installed = new Set(plugins.map((p) => p.id));
  const available = (catalog ?? []).filter((entry) => !installed.has(entry.id));

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

  const installMcp = (): void => {
    if (!mcpServers) return;
    void run('mcp', async () => {
      // Один вставленный конфиг может описывать несколько серверов — ставим
      // каждый отдельным плагином, чтобы их можно было включать по одному.
      for (const server of mcpServers) {
        await client.call('plugin.install', {
          source: { type: 'mcp', name: server.name, transport: server.transport },
        });
      }
      setMcpJson('');
    });
  };

  const installFromGit = (): void => {
    const url = gitUrl.trim();
    if (!url) return;
    void run('git', async () => {
      await client.call('plugin.install', { source: { type: 'git', url } });
      setGitUrl('');
    });
  };

  return (
    <Screen
      title="Плагины"
      icon="bi-puzzle-fill"
      width="wide"
      hint="Плагин приносит агенту новые возможности: свои инструменты, подключения к MCP-серверам и скиллы. Каждый работает отдельным процессом — упавший плагин не роняет ядро."
    >
      {failure && (
        <div className="card mb-4 px-3 py-2.5 border-danger/40 flex items-start gap-2.5">
          <i className="bi bi-exclamation-triangle text-danger mt-0.5" />
          <p className="text-[12px] leading-relaxed text-text-muted flex-1">{failure}</p>
          <button
            type="button"
            onClick={() => setFailure(null)}
            className="text-text-dim hover:text-text"
          >
            <i className="bi bi-x-lg text-[11px]" />
          </button>
        </div>
      )}

      {plugins.length === 0 ? (
        <Empty
          icon="bi-puzzle"
          text="Плагинов пока нет. Поставьте что-нибудь из каталога ниже — например, документацию библиотек или браузер."
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

      {/* ─── Каталог ─── */}
      <h3 className="mt-7 mb-1 text-[13px] font-semibold">Каталог</h3>
      <p className="mb-3 text-[11px] text-text-dim leading-relaxed">
        Проверенные плагины. Список едет вместе с ядром, поэтому работает и без интернета.
      </p>

      {catalog === null ? (
        <p className="text-[12px] text-warning">
          Ядро не отдало каталог — скорее всего, оно старее приложения. Обновите ядро.
        </p>
      ) : available.length === 0 ? (
        <p className="text-[12px] text-text-dim">Всё из каталога уже установлено.</p>
      ) : (
        <CardGrid>
          {available.map((entry) => (
            <div key={entry.id} className="card flex items-start gap-3 px-3 py-2.5">
              <i className="bi bi-box-seam text-accent mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-medium">{entry.name}</span>
                  {entry.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[10px] px-1.5 py-px rounded bg-surface-high text-text-dim"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
                  {entry.description}
                </p>
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
                  // Плагин, которому нужен токен, нельзя ставить молча: без
                  // него он всё равно поднимется в состояние «нужна настройка».
                  if (entry.setup.length > 0) setInstalling(entry);
                  else
                    void run(entry.id, () =>
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
        </CardGrid>
      )}

      {/* ─── Свой MCP-сервер ─── */}
      <h3 className="mt-7 mb-1 text-[13px] font-semibold">Свой MCP-сервер</h3>
      <p className="mb-3 text-[11px] text-text-dim leading-relaxed">
        Каталог — это закладки, а не граница возможного. Вставьте конфигурацию любого MCP-сервера в
        том виде, в каком она написана в его README, — Axon разберёт её сам.
      </p>
      <textarea
        value={mcpJson}
        onChange={(e) => setMcpJson(e.target.value)}
        rows={5}
        spellCheck={false}
        placeholder={
          '{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "@автор/mcp-server"]\n    }\n  }\n}'
        }
        className="w-full px-3 py-2 rounded-lg bg-surface border border-border text-[11px] font-mono leading-relaxed outline-none focus:border-accent transition-colors resize-y scrollbar"
      />
      {mcpPreview && (
        <p className="mt-1.5 text-[11px] text-success">
          <i className="bi bi-check2 mr-1" />
          Разобрано: {mcpPreview}
        </p>
      )}
      {mcpProblem && <p className="mt-1.5 text-[11px] text-warning">{mcpProblem}</p>}
      <button
        type="button"
        disabled={!mcpServers || busy !== null}
        onClick={installMcp}
        className="mt-2 h-9 px-4 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {busy === 'mcp' ? 'Ставлю…' : 'Поставить'}
      </button>

      {/* ─── Из репозитория ─── */}
      <h3 className="mt-7 mb-1 text-[13px] font-semibold">Из репозитория</h3>
      <p className="mb-3 text-[11px] text-text-dim leading-relaxed">
        Ядро склонирует репозиторий к себе. Код чужого плагина выполняется на машине ядра — ставьте
        только то, чему доверяете.
      </p>
      <div className="flex gap-2">
        <input
          value={gitUrl}
          onChange={(e) => setGitUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && installFromGit()}
          placeholder="https://github.com/автор/axon-plugin-…"
          className="flex-1 h-9 px-3 rounded-lg bg-surface border border-border text-[12px] font-mono outline-none focus:border-accent transition-colors"
        />
        <button
          type="button"
          disabled={!gitUrl.trim() || busy !== null}
          onClick={installFromGit}
          className="h-9 px-4 rounded-lg border border-border text-[12px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40 transition-colors"
        >
          {busy === 'git' ? 'Клонирую…' : 'Поставить'}
        </button>
      </div>

      {installing && (
        <SetupDialog
          entry={installing}
          onCancel={() => setInstalling(null)}
          onSubmit={(values) =>
            run(installing.id, async () => {
              await client.call('plugin.install', {
                source: { type: 'catalog', id: installing.id, values },
              });
              setInstalling(null);
            })
          }
        />
      )}
    </Screen>
  );
}

// ─── Карточка установленного ───────────────────────────────────────────────

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
        {plugin.settings.length > 0 && (
          <MiniButton
            icon="bi-sliders"
            label="Настройки"
            active={open}
            onClick={() => setOpen((v) => !v)}
          />
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
        <SettingsForm plugin={plugin} client={client} onSaved={() => setOpen(false)} />
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

function SettingsForm({
  plugin,
  client,
  onSaved,
}: {
  plugin: PluginInfo;
  client: AxonClient;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

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
      .then(onSaved)
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-2.5 ml-4 p-3 rounded-lg bg-bg border border-border">
      {plugin.settings.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          // У секрета показывать нечего: ядро отдаёт только признак «задан».
          current={plugin.settingValues[field.key]}
          value={draft[field.key]}
          onChange={(value) => setDraft((d) => ({ ...d, [field.key]: value }))}
        />
      ))}
      <button
        type="button"
        disabled={saving || Object.keys(draft).length === 0}
        onClick={save}
        className="mt-1 h-8 px-3 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
      >
        {saving ? 'Сохраняю…' : 'Сохранить'}
      </button>
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
