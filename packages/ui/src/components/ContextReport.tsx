import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import type { ContextReport as Report } from '@axon/protocol';

/**
 * Из чего складывается следующий запрос к модели.
 *
 * Обычно расход показывают постфактум одной цифрой — с ней ничего нельзя
 * сделать. Здесь наоборот: разбор до отправки и по частям, каждую из которых
 * видно, чем уменьшить. Именно ради этого экрана в ядре разведены кэшируемая
 * и изменчивая части контекста.
 */
export function ContextReport({
  client,
  conversationId,
  onClose,
  onOpenTools,
  onOpenMemory,
  onOpenSettings,
}: {
  client: AxonClient;
  conversationId: string;
  onClose: () => void;
  onOpenTools: () => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    void client
      .call('context.report', { conversationId })
      .then(setReport)
      .catch((error: Error) => setFailure(error.message));
  }, [conversationId]);

  const where: Record<string, { text: string; go: () => void }> = {
    prompt: { text: 'Настройки', go: onOpenSettings },
    facts: { text: 'Память', go: onOpenMemory },
    tools: { text: 'Инструменты', go: onOpenTools },
    'tools.deferred': { text: 'Инструменты', go: onOpenTools },
    skills: { text: 'Инструменты', go: onOpenTools },
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2 sm:p-6 animate-fade-in"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-lg max-h-[92vh] sm:max-h-[80vh] flex flex-col rise"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-5 pb-3">
          <i className="bi bi-layers-half text-lg text-accent mt-0.5" />
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold">Во что обходится контекст</h3>
            <p className="mt-1 text-[11px] text-text-dim leading-relaxed">
              Оценка того, что уедет в модель со следующим сообщением. Точные цифры приходят от
              провайдера после ответа — эти нужны, чтобы решать заранее.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 w-6 h-6 rounded flex items-center justify-center text-text-dim hover:text-text transition-colors"
          >
            <i className="bi bi-x-lg text-[11px]" />
          </button>
        </div>

        {failure && <p className="px-5 pb-5 text-[12px] text-danger">{failure}</p>}
        {!report && !failure && (
          <p className="px-5 pb-5 text-[12px] text-text-dim">Считаю…</p>
        )}

        {report && (
          <>
            <div className="px-5">
              <Bar report={report} />
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto scrollbar px-5 py-3">
              {report.parts.map((part) => {
                const link = where[part.key];
                const share = report.totalTokens > 0 ? part.tokens / report.totalTokens : 0;
                return (
                  <div
                    key={part.key}
                    className="py-2 border-b border-border/60 last:border-b-0 flex items-start gap-3"
                  >
                    <span
                      className={clsx(
                        'mt-1.5 w-1.5 h-1.5 rounded-full shrink-0',
                        part.tokens === 0
                          ? 'bg-text-dim'
                          : part.cached
                            ? 'bg-accent'
                            : 'bg-warning',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[13px]">{part.label}</span>
                        {link && (
                          <button
                            type="button"
                            onClick={() => {
                              link.go();
                              onClose();
                            }}
                            className="text-[10px] text-text-dim hover:text-accent transition-colors"
                          >
                            {link.text} →
                          </button>
                        )}
                      </div>
                      {part.detail && (
                        <p className="mt-0.5 text-[11px] text-text-dim leading-relaxed">
                          {part.detail}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="font-mono text-[12px]">
                        {part.tokens === 0 ? '—' : compact(part.tokens)}
                      </span>
                      {part.tokens > 0 && (
                        <span className="block text-[10px] text-text-dim">
                          {Math.round(share * 100)}%
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <Footer report={report} />
          </>
        )}
      </div>
    </div>
  );
}

function Bar({ report }: { report: Report }) {
  const total = Math.max(1, report.totalTokens);
  const cachedShare = (report.cacheableTokens / total) * 100;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="text-[20px] font-semibold font-mono">{compact(report.totalTokens)}</span>
        <span className="text-[11px] text-text-dim">токенов на запрос</span>
      </div>
      <div className="h-2 rounded-full bg-surface-high overflow-hidden flex">
        <span className="bg-accent h-full" style={{ width: `${cachedShare}%` }} />
        <span className="bg-warning h-full" style={{ width: `${100 - cachedShare}%` }} />
      </div>
      <div className="mt-1.5 flex items-center gap-4 text-[10px] text-text-dim">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-accent" />
          кэшируемая часть {compact(report.cacheableTokens)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-warning" />
          изменчивый хвост {compact(report.totalTokens - report.cacheableTokens)}
        </span>
      </div>
    </div>
  );
}

/**
 * Вывод внизу — самое ценное в этом окне: цифра сама по себе ничего не значит,
 * пока не сказано, во сколько раз она дешевле или дороже, чем могла быть.
 */
function Footer({ report }: { report: Report }) {
  const share =
    report.totalTokens > 0 ? Math.round((report.cacheableTokens / report.totalTokens) * 100) : 0;

  return (
    <div className="px-5 py-3 border-t border-border text-[11px] leading-relaxed text-text-muted">
      {report.supportsPromptCache ? (
        <p>
          <i className="bi bi-lightning-charge text-accent mr-1.5" />
          {share}% контекста попадает в кэш промпта и на повторных ходах стоит примерно вдесятеро
          дешевле. Чем длиннее стабильная часть и короче хвост — тем выгоднее.
        </p>
      ) : (
        <p>
          <i className="bi bi-exclamation-circle text-warning mr-1.5" />
          {report.provider ?? 'Текущий провайдер'} не умеет кэшировать промпт: весь контекст
          оплачивается заново на каждом ходу.
        </p>
      )}
      {report.model && (
        <p className="mt-1 text-text-dim font-mono text-[10px] truncate">
          {report.provider} · {report.model}
        </p>
      )}
    </div>
  );
}

function compact(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
