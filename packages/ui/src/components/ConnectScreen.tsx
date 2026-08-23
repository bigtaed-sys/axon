import { useState } from 'react';
import clsx from 'clsx';
import { host } from '../host.js';
import type { Connection } from '../host.js';

type Tab = 'embedded' | 'remote';

/**
 * Выбор ядра, к которому подключается приложение.
 *
 * Своё ядро — ядро рядом с приложением, всё хранится на этой машине. Чужое —
 * то же самое ядро, но на сервере или на другом компьютере: тогда история,
 * память и ключи живут там, а это приложение становится просто окном к нему.
 */
export function ConnectScreen({
  current,
  error,
  onConnected,
}: {
  current: Connection | null;
  error: string | null;
  onConnected: () => void;
}) {
  /**
   * Своё ядро есть не везде. На телефоне вкладки «на этом компьютере» быть не
   * должно вовсе — не спрятанной, а отсутствующей: предлагать поднять ядро
   * там, где его негде поднять, значит врать.
   */
  const local = host().local;
  const [tab, setTab] = useState<Tab>(
    !local || current?.mode === 'remote' ? 'remote' : 'embedded',
  );

  return (
    <div className="flex-1 overflow-y-auto scrollbar">
      <div className="max-w-lg mx-auto px-6 py-10">
        <div className="flex items-center gap-2.5 mb-1">
          <i className="bi bi-hdd-network text-lg text-accent" />
          <h2 className="text-[17px] font-semibold tracking-tight">Подключение к ядру</h2>
        </div>
        <p className="text-[12px] text-text-muted leading-relaxed mb-5">
          Ядро — это то, что хранит переписку, память и ключи и разговаривает с моделью.
          Приложение к нему только подключается.
        </p>

        {error && (
          <div className="mb-5 flex items-start gap-2 rounded-xl2 border border-danger/30 bg-danger/10 px-3 py-2.5 text-[12px] text-danger">
            <i className="bi bi-exclamation-triangle-fill mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {local && (
          <div className="seg mb-5">
            <button
              type="button"
              aria-pressed={tab === 'embedded'}
              onClick={() => setTab('embedded')}
            >
              На этом компьютере
            </button>
            <button type="button" aria-pressed={tab === 'remote'} onClick={() => setTab('remote')}>
              На другом
            </button>
          </div>
        )}

        {local && tab === 'embedded' ? (
          <EmbeddedTab current={current} onConnected={onConnected} />
        ) : (
          <RemoteTab current={current} onConnected={onConnected} />
        )}
      </div>
    </div>
  );
}

function EmbeddedTab({
  current,
  onConnected,
}: {
  current: Connection | null;
  onConnected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const active = current?.mode === 'embedded';

  return (
    <div className="card p-4">
      <p className="text-[13px] leading-relaxed">
        Ядро запускается рядом с приложением и слушает только локальный адрес. Всё — история,
        память, ключи — остаётся на этой машине и никуда не уходит.
      </p>

      {active && (
        <p className="mt-3 text-[12px] text-success flex items-center gap-1.5">
          <i className="bi bi-check-circle-fill" />
          сейчас используется, {current.url}
        </p>
      )}

      {failure && <p className="mt-3 text-[12px] text-danger">{failure}</p>}

      {!active && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setFailure(null);
            try {
              await host().local!.use();
              onConnected();
            } catch (e) {
              setFailure((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="mt-4 h-10 w-full rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors disabled:opacity-40"
        >
          {busy ? 'Запускаю…' : 'Использовать ядро на этом компьютере'}
        </button>
      )}
    </div>
  );
}

function RemoteTab({
  current,
  onConnected,
}: {
  current: Connection | null;
  onConnected: () => void;
}) {
  const [url, setUrl] = useState(current?.mode === 'remote' ? current.url : '');
  const [code, setCode] = useState('');
  const [name, setName] = useState('Десктоп');
  const [probe, setProbe] = useState<{ coreId: string; version: string; devices: number } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const active = current?.mode === 'remote';

  const check = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setProbe(null);
    try {
      setProbe(await host().probe(url));
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await host().connectRemote({ url, code, name });
      onConnected();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-4">
      {active && (
        <p className="mb-4 text-[12px] text-success flex items-center gap-1.5">
          <i className="bi bi-check-circle-fill" />
          сейчас используется {current.label ?? current.url}
        </p>
      )}

      <label className="block text-[12px] font-medium mb-1.5">Адрес ядра</label>
      <p className="text-[11px] text-text-dim mb-2 leading-relaxed">
        Например <span className="font-mono">192.168.1.50:8787</span> или{' '}
        <span className="font-mono">axon.мойсервер.ру</span>. Порт по умолчанию — 8787.
      </p>
      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="адрес или IP"
          className="input flex-1 font-mono text-[12px]"
        />
        <button
          type="button"
          disabled={!url.trim() || busy}
          onClick={() => void check()}
          className="h-9 px-3 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors disabled:opacity-40"
        >
          Проверить
        </button>
      </div>

      {probe && (
        <p className="mt-2 text-[11px] text-success flex items-center gap-1.5">
          <i className="bi bi-check-circle-fill" />
          ядро отвечает, версия {probe.version}, устройств: {probe.devices}
        </p>
      )}

      <label className="block text-[12px] font-medium mt-4 mb-1.5">Код подключения</label>
      <p className="text-[11px] text-text-dim mb-2 leading-relaxed">
        Код выдаётся на том ядре: в его настройках, раздел «Устройства». Он одноразовый и живёт
        несколько минут.
      </p>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="XXXX-XXXX"
        className="input font-mono tracking-[0.2em] text-center text-[15px]"
      />

      <label className="block text-[12px] font-medium mt-4 mb-1.5">Как назвать это устройство</label>
      <input value={name} onChange={(e) => setName(e.target.value)} className="input" />

      {failure && <p className="mt-3 text-[12px] text-danger">{failure}</p>}

      <button
        type="button"
        disabled={!url.trim() || !code.trim() || busy}
        onClick={() => void connect()}
        className="mt-4 h-10 w-full rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors disabled:opacity-40"
      >
        {busy ? 'Подключаюсь…' : 'Подключиться'}
      </button>

      <p className="mt-3 text-[11px] text-text-dim leading-relaxed">
        Соединение идёт без шифрования. По локальной сети это нормально, а вот через интернет
        ядро стоит выставлять только за туннелем или обратным прокси с TLS.
      </p>
    </div>
  );
}
