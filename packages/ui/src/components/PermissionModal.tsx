import clsx from 'clsx';
import type { PermissionDecision, PermissionRequest, RiskTier } from '@axon/protocol';

/**
 * `expired` сюда не входит: это исход, а не выбор. Так его нельзя случайно
 * отправить как ответ пользователя.
 */
export type UserDecision = Exclude<PermissionDecision, 'expired'>;

const TIER: Record<RiskTier, { label: string; icon: string; tone: string }> = {
  safe: { label: 'безопасное действие', icon: 'bi-shield-check', tone: 'text-success' },
  sensitive: {
    label: 'затрагивает внешние системы',
    icon: 'bi-shield-exclamation',
    tone: 'text-warning',
  },
  dangerous: {
    label: 'необратимо меняет систему',
    icon: 'bi-exclamation-octagon-fill',
    tone: 'text-danger',
  },
};

/**
 * Подтверждение действия.
 *
 * Не всплывашка «вы уверены?», а последний рубеж: показываем инструмент,
 * уровень риска и настоящие аргументы вызова. «Всегда разрешать» стоит слабее
 * по акценту, чем разовое согласие — оно снимает вопрос навсегда.
 */
export function PermissionModal({
  request,
  onDecide,
}: {
  request: PermissionRequest;
  onDecide: (decision: UserDecision) => void;
}) {
  const tier = TIER[request.tier];

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center animate-fade-in">
      <div className="card shadow-elev w-full max-w-md p-5 animate-msg-in">
        <div className="flex items-start gap-3">
          <div
            className={clsx(
              'w-9 h-9 shrink-0 rounded-xl bg-surface-elev border border-border flex items-center justify-center text-lg',
              tier.tone,
            )}
          >
            <i className={clsx('bi', tier.icon)} />
          </div>
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold">Агент просит разрешение</h2>
            <p className="mt-0.5 text-[12px] text-text-muted">{tier.label}</p>
          </div>
        </div>

        <div className="mt-4 rounded-xl2 bg-bg border border-border p-3">
          <div className="flex items-center gap-2 text-[13px]">
            <i className="bi bi-terminal text-text-dim" />
            <span className="font-mono">{request.toolName}</span>
          </div>
          <pre className="mt-2 max-h-40 overflow-auto scrollbar whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-muted">
            {JSON.stringify(request.arguments, null, 2)}
          </pre>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onDecide('allow_once')}
            className="h-10 w-full rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors flex items-center justify-center gap-2"
          >
            <i className="bi bi-check2" />
            Разрешить один раз
          </button>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onDecide('deny_once')}
              className="flex-1 h-9 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors flex items-center justify-center gap-2"
            >
              <i className="bi bi-x-lg text-[11px]" />
              Отклонить
            </button>
            <button
              type="button"
              onClick={() => onDecide('allow_always')}
              title="Больше не спрашивать про этот инструмент"
              className="flex-1 h-9 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors flex items-center justify-center gap-2"
            >
              <i className="bi bi-infinity text-[11px]" />
              Всегда
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
