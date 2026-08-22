import { useState } from 'react';
import clsx from 'clsx';
import type { Message, ToolCall } from '@axon/protocol';

/**
 * Вызов инструмента вместе с его результатом — одной строкой.
 *
 * Раньше это были две отдельные записи в ленте: чип вызова внутри пузыря и
 * следом простыня вывода на весь экран. Один `list_dir` по домашней папке
 * выталкивал разговор за пределы окна, и читать переписку становилось нельзя.
 *
 * Теперь вызов и результат — один свёрнутый ряд: имя, короткая выжимка
 * аргументов и объём вывода. Разворачивается по клику, когда действительно
 * нужно посмотреть, что вернулось.
 */
export function ToolCallRow({ call, result }: { call: ToolCall; result: Message | null }) {
  const [open, setOpen] = useState(false);

  const text = result ? textOf(result) : null;
  const failed = text?.startsWith('Ошибка:') ?? false;

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!text}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left transition-colors hover:bg-bg-hover disabled:hover:bg-transparent"
      >
        <i
          className={clsx(
            'bi shrink-0',
            !text ? 'bi-hourglass text-text-dim' : failed ? 'bi-x-octagon text-danger' : 'bi-gear-fill text-text-dim',
          )}
        />
        <span className="font-mono text-accent shrink-0">{call.name}</span>
        <span className="font-mono text-text-dim truncate min-w-0">{summarize(call)}</span>

        <span className="ml-auto shrink-0 flex items-center gap-1.5 text-text-dim">
          {text ? volume(text) : 'выполняется…'}
          {text && <i className={clsx('bi', open ? 'bi-chevron-up' : 'bi-chevron-down')} />}
        </span>
      </button>

      {open && text && (
        <pre className="px-3 py-2 border-t border-border font-mono text-[11px] leading-relaxed text-text-muted max-h-80 overflow-auto scrollbar whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
    </div>
  );
}

/** Аргументы одной строкой: длинные значения подрезаем, ключи оставляем. */
function summarize(call: ToolCall): string {
  const entries = Object.entries(call.arguments ?? {});
  if (entries.length === 0) return '()';

  const parts = entries.map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const short = text.length > 48 ? `${text.slice(0, 48)}…` : text;
    return `${key}: ${short}`;
  });
  return `(${parts.join(', ')})`;
}

function volume(text: string): string {
  const lines = text.split('\n').length;
  return lines > 1 ? `${lines} строк` : `${text.length} симв.`;
}

function textOf(message: Message): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
}
