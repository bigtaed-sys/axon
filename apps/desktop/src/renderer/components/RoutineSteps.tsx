import clsx from 'clsx';
import type { Condition, RoutineStep, StepLog } from '@axon/protocol';

/**
 * Показ скомпилированных шагов.
 *
 * Ради этого экрана рутина и компилируется заранее: человек видит, что именно
 * будет сделано, до того как включит задачу, которая работает без него. Список
 * шагов, который нельзя прочитать, ничем не лучше задания словами.
 */

const KIND: Record<string, { label: string; icon: string; tone: string }> = {
  tool: { label: 'инструмент', icon: 'bi-tools', tone: 'text-accent' },
  prompt: { label: 'вопрос модели', icon: 'bi-chat-left-quote', tone: 'text-warning' },
  extract: { label: 'разбор текста', icon: 'bi-braces', tone: 'text-warning' },
  agent: { label: 'агент', icon: 'bi-robot', tone: 'text-danger' },
  if: { label: 'если', icon: 'bi-signpost-split', tone: 'text-text-muted' },
  foreach: { label: 'для каждого', icon: 'bi-arrow-repeat', tone: 'text-text-muted' },
  set: { label: 'переменная', icon: 'bi-tag', tone: 'text-text-dim' },
  notify: { label: 'уведомление', icon: 'bi-bell', tone: 'text-accent' },
  message: { label: 'сообщение', icon: 'bi-chat-left-text', tone: 'text-accent' },
  remember: { label: 'запомнить', icon: 'bi-journal-plus', tone: 'text-success' },
  wait: { label: 'пауза', icon: 'bi-hourglass', tone: 'text-text-dim' },
  stop: { label: 'остановиться', icon: 'bi-sign-stop', tone: 'text-text-dim' },
};

const OPS: Record<Condition['op'], string> = {
  equals: 'равно',
  notEquals: 'не равно',
  contains: 'содержит',
  notContains: 'не содержит',
  matches: 'подходит под',
  empty: 'пусто',
  notEmpty: 'не пусто',
  greaterThan: 'больше',
  lessThan: 'меньше',
};

export function StepList({
  steps,
  logs,
  prefix = '',
  depth = 0,
}: {
  steps: RoutineStep[];
  /** След последнего прогона: подсвечивает, что отработало, а что упало. */
  logs?: Map<string, StepLog> | undefined;
  prefix?: string;
  depth?: number;
}) {
  return (
    <div className={clsx('flex flex-col gap-1', depth > 0 && 'mt-1 ml-4 pl-3 border-l border-border')}>
      {steps.map((step, index) => {
        const path = prefix ? `${prefix}.${index}` : String(index);
        const log = logs?.get(path);
        const meta = KIND[step.kind] ?? { label: step.kind, icon: 'bi-dot', tone: 'text-text-dim' };

        return (
          <div key={path}>
            <div
              className={clsx(
                'flex items-start gap-2 px-2 py-1.5 rounded-lg text-[12px]',
                log && !log.ok ? 'bg-danger/10' : 'bg-surface',
              )}
            >
              <i className={clsx('bi', meta.icon, meta.tone, 'mt-0.5 text-[11px]')} />

              <div className="min-w-0 flex-1">
                <span className="text-text-dim text-[10px] uppercase tracking-wider">
                  {meta.label}
                </span>
                <div className="leading-relaxed break-words">{describe(step)}</div>

                {log?.error && <p className="mt-0.5 text-[11px] text-danger">{log.error}</p>}
                {log?.output && (
                  <p className="mt-0.5 text-[11px] text-text-dim line-clamp-2">{log.output}</p>
                )}
              </div>

              {log && (
                <span className="shrink-0 text-[10px] text-text-dim">
                  {log.tokens > 0 && `${log.tokens} т · `}
                  {log.durationMs} мс
                </span>
              )}
            </div>

            {step.kind === 'if' && (
              <>
                <StepList steps={step.then} logs={logs} prefix={path} depth={depth + 1} />
                {step.otherwise && step.otherwise.length > 0 && (
                  <>
                    <p className="ml-4 mt-1 text-[10px] uppercase tracking-wider text-text-dim">
                      иначе
                    </p>
                    <StepList
                      steps={step.otherwise}
                      logs={logs}
                      prefix={path}
                      depth={depth + 1}
                    />
                  </>
                )}
              </>
            )}

            {step.kind === 'foreach' && (
              <StepList steps={step.steps} logs={logs} prefix={path} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Шаг одной фразой — так, как его прочитал бы человек. */
function describe(step: RoutineStep): string {
  switch (step.kind) {
    case 'tool': {
      const args = Object.entries(step.args)
        .map(([key, value]) => `${key}: ${short(String(value))}`)
        .join(', ');
      const into = step.outputVar ? ` → \${${step.outputVar}}` : '';
      return `${step.tool}(${args})${into}`;
    }
    case 'prompt':
      return short(step.prompt, 160) + (step.outputVar ? ` → \${${step.outputVar}}` : '');
    case 'extract':
      return `из ${short(step.from, 60)} достать: ${step.fields.map((f) => f.name).join(', ')}`;
    case 'agent':
      return short(step.task, 160);
    case 'if': {
      const { left, op, right } = step.condition;
      const tail = op === 'empty' || op === 'notEmpty' ? '' : ` «${short(right ?? '', 40)}»`;
      return `${short(left, 60)} ${OPS[op]}${tail}`;
    }
    case 'foreach':
      return `по ${short(step.source, 60)}${step.limit ? `, не больше ${step.limit}` : ''}`;
    case 'set':
      return `\${${step.name}} = ${short(step.value, 80)}`;
    case 'notify':
      return step.body ? `${step.title} — ${short(step.body, 80)}` : step.title;
    case 'message':
      return short(step.text, 160);
    case 'remember':
      return `${step.key}: ${short(step.value, 80)}`;
    case 'wait':
      return `${step.seconds} с`;
    case 'stop':
      return step.reason ?? 'закончить';
  }
}

function short(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
