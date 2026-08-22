import clsx from 'clsx';

export function ChatHeader({
  title,
  provider,
  model,
  toolCount,
  showToolCalls,
  onToggleToolCalls,
  onOpenTools,
  onOpenSettings,
  onOpenContext,
}: {
  title: string;
  provider: string;
  model: string;
  toolCount: number;
  showToolCalls: boolean;
  onToggleToolCalls: () => void;
  onOpenTools: () => void;
  onOpenSettings: () => void;
  onOpenContext: () => void;
}) {
  return (
    <header className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-border bg-surface">
      <i className="bi bi-chat-dots text-text-dim" />
      <h1 className="text-[13px] font-medium truncate">{title}</h1>

      <div className="ml-auto flex items-center gap-1 text-[12px] text-text-muted">
        <button
          type="button"
          onClick={onToggleToolCalls}
          title={showToolCalls ? 'Скрыть вызовы инструментов' : 'Показать вызовы инструментов'}
          className={clsx(
            'h-7 w-7 rounded-lg flex items-center justify-center transition-colors hover:bg-bg-hover',
            showToolCalls ? 'text-text' : 'text-text-dim',
          )}
        >
          <i className={clsx('bi text-[12px]', showToolCalls ? 'bi-eye' : 'bi-eye-slash')} />
        </button>

        <button
          type="button"
          onClick={onOpenTools}
          className="h-7 px-2 rounded-lg flex items-center gap-1.5 hover:bg-bg-hover hover:text-text transition-colors"
          title="Инструменты"
        >
          <i className="bi bi-tools text-[12px]" />
          <span>{toolCount}</span>
        </button>

        <button
          type="button"
          onClick={onOpenContext}
          className="h-7 px-2 rounded-lg flex items-center gap-1.5 hover:bg-bg-hover hover:text-text transition-colors"
          title="Из чего собран контекст следующего запроса"
        >
          <i className="bi bi-layers-half text-[12px]" />
        </button>

        <span className="text-text-dim">·</span>

        <button
          type="button"
          onClick={onOpenSettings}
          className="h-7 px-2 rounded-lg flex items-center gap-1.5 hover:bg-bg-hover hover:text-text transition-colors"
          title="Провайдер и модель"
        >
          <i className="bi bi-cpu text-[12px]" />
          <span>{provider}</span>
        </button>

        <span className="font-mono text-[11px] text-text-dim truncate max-w-[220px]" title={model}>
          {model}
        </span>
      </div>
    </header>
  );
}
