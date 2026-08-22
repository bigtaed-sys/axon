import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { ConnectionStatus } from '@axon/client-sdk';
import { THEMES, type ThemeId } from '../theme.js';

const STATUS: Record<ConnectionStatus, { label: string; icon: string; tone: string }> = {
  offline: { label: 'Нет связи с ядром', icon: 'bi-plug', tone: 'text-danger' },
  connecting: { label: 'Подключение', icon: 'bi-three-dots', tone: 'text-warning' },
  syncing: { label: 'Синхронизация', icon: 'bi-arrow-repeat', tone: 'text-warning' },
  ready: { label: 'Ядро на связи', icon: 'bi-check-circle-fill', tone: 'text-success' },
};

export function TopBar({
  status,
  theme,
  onTheme,
}: {
  status: ConnectionStatus;
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
}) {
  const state = STATUS[status];

  return (
    // Правый отступ — под системные кнопки окна: рамка скрыта, но Electron
    // резервирует под них полосу, и всё, что окажется под ней, некликабельно.
    <header className="drag-region h-12 shrink-0 flex items-center justify-between pl-4 pr-[150px] border-b border-border bg-surface">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-lg bg-accent text-accent-fg flex items-center justify-center">
          <i className="bi bi-robot text-base" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold tracking-tight">Axon</span>
          {/*
            Версия подставляется при сборке из package.json. Зашитая строка
            здесь однажды разошлась бы с настоящей — и первый же отчёт об
            ошибке пришёл бы с неверным номером.
          */}
          <span className="text-[11px] text-text-dim">v{__APP_VERSION__}</span>
        </div>
        <span className="w-px h-4 bg-border mx-1" />
        <div className={clsx('flex items-center gap-1.5 text-[12px]', state.tone)}>
          <i className={clsx('bi', state.icon)} />
          <span className="text-text-muted">{state.label}</span>
        </div>
      </div>

      <div className="no-drag flex items-center gap-2">
        <ThemePicker current={theme} onSelect={onTheme} />
      </div>
    </header>
  );
}

function ThemePicker({
  current,
  onSelect,
}: {
  current: ThemeId;
  onSelect: (theme: ThemeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const meta = THEMES.find((t) => t.id === current) ?? THEMES[0]!;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-8 px-3 rounded-lg flex items-center gap-2 text-[12px] text-text-muted hover:text-text hover:bg-bg-hover border border-border transition-colors"
        title="Тема оформления"
      >
        <i className={clsx('bi', meta.icon)} />
        <span>{meta.label}</span>
        <i className="bi bi-chevron-down text-[10px] opacity-60" />
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+4px)] w-56 card shadow-pop overflow-hidden z-50 animate-fade-in">
          <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-text-dim border-b border-border">
            Тема
          </div>
          <ul className="p-1">
            {THEMES.map((t) => {
              const active = t.id === current;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(t.id);
                      setOpen(false);
                    }}
                    className={clsx(
                      'w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] transition-colors',
                      active ? 'bg-accent text-accent-fg' : 'text-text hover:bg-bg-hover',
                    )}
                  >
                    <i className={clsx('bi', t.icon, 'text-base')} />
                    <span className="flex-1 text-left">{t.label}</span>
                    {active && <i className="bi bi-check2 text-base" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
