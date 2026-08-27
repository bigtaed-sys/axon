import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import type { Routine, RoutineRun, RoutineStep, Schedule, ToolInfo } from '@axon/protocol';
import { Empty, Screen, TIER, Toggle } from './Panels.js';
import { StepList } from './RoutineSteps.js';

const DAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
/** Индекс в DAYS → номер дня в JS, где 0 — воскресенье. */
const DAY_NUMBER = [1, 2, 3, 4, 5, 6, 0];

const STATUS: Record<string, { label: string; tone: string }> = {
  ok: { label: 'отработала', tone: 'text-success' },
  failed: { label: 'не получилось', tone: 'text-danger' },
  skipped: { label: 'сообщать было не о чем', tone: 'text-text-dim' },
  running: { label: 'работает', tone: 'text-warning' },
};

export function RoutinesPanel({
  routines,
  tools,
  client,
  onOpenChat,
}: {
  routines: Routine[];
  tools: ToolInfo[];
  client: AxonClient;
  onOpenChat: (conversationId: string) => void;
}) {
  const [editing, setEditing] = useState<Routine | 'new' | null>(null);
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
      title="Рутины"
      icon="bi-clock-history"
      width="wide"
      hint="То, что агент делает сам, без вас. Вы описываете задачу словами, Axon один раз собирает из неё сценарий — дальше он выполняется по расписанию и почти ничего не стоит."
    >
      {failure && (
        <div className="card mb-4 px-3 py-2.5 border-danger/40 text-[12px] text-text-muted whitespace-pre-wrap">
          {failure}
        </div>
      )}

      <button
        type="button"
        onClick={() => setEditing('new')}
        className="w-full h-10 mb-3 rounded-xl2 border border-dashed border-border text-[13px] text-text-muted hover:border-accent hover:text-text transition-colors flex items-center justify-center gap-2"
      >
        <i className="bi bi-plus-lg" />
        Новая рутина
      </button>

      {routines.length === 0 ? (
        <Empty
          icon="bi-clock-history"
          text="Пока ничего не запланировано. Например: каждое утро посмотреть, что изменилось в папке проекта, и написать короткую сводку."
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              routine={routine}
              client={client}
              busy={busy === routine.id}
              onEdit={() => setEditing(routine)}
              onOpenChat={onOpenChat}
              onAction={(action) => run(routine.id, action)}
            />
          ))}
        </div>
      )}

      {editing && (
        <Editor
          routine={editing === 'new' ? null : editing}
          tools={tools}
          client={client}
          onCancel={() => setEditing(null)}
          onSave={(input) =>
            run('save', async () => {
              if (editing === 'new') await client.call('routine.create', input);
              else await client.call('routine.update', { id: editing.id, ...input });
              setEditing(null);
            })
          }
        />
      )}
    </Screen>
  );
}

// ─── Карточка ───────────────────────────────────────────────────────────────

function RoutineCard({
  routine,
  client,
  busy,
  onEdit,
  onOpenChat,
  onAction,
}: {
  routine: Routine;
  client: AxonClient;
  busy: boolean;
  onEdit: () => void;
  onOpenChat: (conversationId: string) => void;
  onAction: (action: () => Promise<unknown>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);

  // След последнего прогона накладывается на шаги: сразу видно, где рутина
  // остановилась, вместо «не получилось» без подробностей.
  const lastRun = runs?.[0];
  const logs = new Map((lastRun?.steps ?? []).map((step) => [step.path, step]));

  const showRuns = (): void => {
    setOpen((v) => !v);
    if (runs) return;
    void client
      .call('routine.runs', { routineId: routine.id })
      .then((res) => setRuns(res.runs))
      .catch(() => setRuns([]));
  };

  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-start gap-3">
        <i className={clsx('bi bi-clock mt-0.5', routine.enabled ? 'text-accent' : 'text-text-dim')} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium">{routine.name}</span>
            <span className="text-[10px] text-text-dim">{describe(routine.schedule)}</span>
            {routine.lastStatus && (
              <span className={clsx('text-[10px]', STATUS[routine.lastStatus]?.tone)}>
                {STATUS[routine.lastStatus]?.label}
              </span>
            )}
          </div>

          {routine.description && (
            <p className="mt-1 text-[12px] leading-relaxed text-text-muted">
              {routine.description}
            </p>
          )}

          <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[10px] text-text-dim">
            <span>
              <i className="bi bi-list-ol mr-1" />
              {routine.steps.length} {plural(routine.steps.length, 'шаг', 'шага', 'шагов')}
            </span>
            {routine.enabled && routine.nextRunAt && (
              <span>
                <i className="bi bi-arrow-right-short" />
                {when(routine.nextRunAt)}
              </span>
            )}
            {routine.lastSummary && <span>{routine.lastSummary}</span>}
          </div>
        </div>

        <Toggle
          on={routine.enabled}
          onClick={() =>
            onAction(() =>
              client.call('routine.update', { id: routine.id, enabled: !routine.enabled }),
            )
          }
        />
      </div>

      <div className="mt-2.5 pl-4 flex items-center gap-1.5 flex-wrap">
        <Mini
          icon="bi-play"
          label={busy ? 'Работает…' : 'Запустить сейчас'}
          onClick={() =>
            onAction(async () => {
              await client.call('routine.runNow', { id: routine.id });
              const res = await client.call('routine.runs', { routineId: routine.id });
              setRuns(res.runs);
              setOpen(true);
            })
          }
        />
        <Mini
          icon={open ? 'bi-chevron-up' : 'bi-list-nested'}
          label="Шаги и прогоны"
          active={open}
          onClick={showRuns}
        />
        <Mini icon="bi-pencil" label="Изменить" onClick={onEdit} />
        {routine.conversationId && (
          <Mini
            icon="bi-chat-left-text"
            label="Переписка"
            onClick={() => onOpenChat(routine.conversationId!)}
          />
        )}
        <Mini
          icon="bi-trash3"
          label="Удалить"
          danger
          onClick={() => onAction(() => client.call('routine.delete', { id: routine.id }))}
        />
      </div>

      {open && (
        <div className="mt-2.5 ml-4">
          <StepList steps={routine.steps} logs={logs} />

          {runs && runs.length > 0 && (
            <>
              <p className="mt-3 mb-1 text-[10px] uppercase tracking-wider text-text-dim">
                Последние прогоны
              </p>
              <div className="flex flex-col gap-0.5">
                {runs.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center gap-2 text-[11px] text-text-dim px-2 py-1 rounded hover:bg-bg-hover"
                  >
                    <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', dot(item.status))} />
                    <span className="w-32 shrink-0">
                      {new Date(item.startedAt).toLocaleString('ru-RU', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <span className="flex-1 truncate">{item.summary}</span>
                    {item.tokens > 0 && <span className="shrink-0">{item.tokens} т</span>}
                  </div>
                ))}
              </div>
            </>
          )}
          {runs && runs.length === 0 && (
            <p className="mt-3 text-[11px] text-text-dim">Ещё не запускалась.</p>
          )}
        </div>
      )}
    </div>
  );
}

function dot(status: string): string {
  if (status === 'ok') return 'bg-success';
  if (status === 'failed') return 'bg-danger';
  if (status === 'running') return 'bg-warning animate-pulse';
  return 'bg-text-dim';
}

function Mini({
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

// ─── Редактор ───────────────────────────────────────────────────────────────

interface EditorInput {
  name: string;
  description: string;
  source: string;
  steps: RoutineStep[];
  schedule: Schedule;
  budgetTokens: number;
  allowTools: string[];
  notify: boolean;
}

function Editor({
  routine,
  tools,
  client,
  onCancel,
  onSave,
}: {
  routine: Routine | null;
  tools: ToolInfo[];
  client: AxonClient;
  onCancel: () => void;
  onSave: (input: EditorInput) => void;
}) {
  const [source, setSource] = useState(routine?.source ?? '');
  const [name, setName] = useState(routine?.name ?? '');
  const [description, setDescription] = useState(routine?.description ?? '');
  const [steps, setSteps] = useState<RoutineStep[]>(routine?.steps ?? []);
  const [schedule, setSchedule] = useState<Schedule>(routine?.schedule ?? { kind: 'daily', time: '09:00' });
  const [budget, setBudget] = useState(String(routine?.budgetTokens ?? 20000));
  const [allowTools, setAllowTools] = useState<string[]>(routine?.allowTools ?? []);
  const [notify, setNotify] = useState(routine?.notify ?? true);

  const [compiling, setCompiling] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  // Безопасные инструменты рутине доступны и так — выбирать нужно только то,
  // что трогает внешние системы и машину.
  const risky = tools.filter((tool) => tool.tier !== 'safe' && tool.enabled);

  const compile = (): void => {
    if (!source.trim()) return;
    setCompiling(true);
    setProblem(null);
    void client
      .call('routine.compile', { source: source.trim(), allowTools })
      .then((result) => {
        setName(result.name);
        setDescription(result.description);
        setSteps(result.steps);
        setSchedule(result.schedule);
        setWarnings(result.warnings);
      })
      .catch((error: Error) => setProblem(error.message))
      .finally(() => setCompiling(false));
  };

  const ready = name.trim() && steps.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-2 sm:p-6"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-2xl max-h-[92vh] sm:max-h-[88vh] overflow-y-auto scrollbar p-3.5 sm:p-5 rise"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-semibold mb-4">
          {routine ? 'Изменить рутину' : 'Новая рутина'}
        </h3>

        <Label
          text="Что нужно делать"
          hint="Обычными словами. Axon соберёт из описания сценарий — вы увидите его целиком до того, как включите."
        >
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            rows={3}
            placeholder="Каждое утро в девять посмотри, что изменилось в папке проекта, и, если есть что сказать, напиши короткую сводку"
            className="input text-[13px] resize-none leading-relaxed scrollbar"
          />
          <button
            type="button"
            disabled={!source.trim() || compiling}
            onClick={compile}
            className="mt-2 h-9 px-4 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <i className={clsx('bi', compiling ? 'bi-hourglass-split' : 'bi-magic')} />
            {compiling ? 'Собираю…' : steps.length > 0 ? 'Собрать заново' : 'Собрать сценарий'}
          </button>
        </Label>

        {problem && (
          <p className="mb-4 text-[12px] text-danger leading-relaxed whitespace-pre-wrap">
            {problem}
          </p>
        )}

        {steps.length > 0 && (
          <>
            <Label text="Что будет сделано">
              <StepList steps={steps} />
            </Label>

            {warnings.length > 0 && (
              <div className="mb-4 flex flex-col gap-1">
                {warnings.map((warning, index) => (
                  <p key={index} className="text-[11px] text-warning leading-relaxed">
                    <i className="bi bi-info-circle mr-1.5" />
                    {warning}
                  </p>
                ))}
              </div>
            )}

            <Label text="Название">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input h-9 text-[13px]"
              />
            </Label>

            <Label text="Когда">
              <ScheduleEditor value={schedule} onChange={setSchedule} />
            </Label>

            <Label
              text="Потолок токенов"
              hint="Ограничивает только шаги, обращающиеся к модели. Обычные шаги ничего не стоят."
            >
              <input
                type="number"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="input h-9 text-[13px] font-mono"
              />
            </Label>

            {risky.length > 0 && (
              <Label
                text="Разрешить инструменты"
                hint="Рядом с рутиной не будет человека, который подтвердит опасное действие. Всё, кроме безопасного, она получает только отсюда — и только это сможет использовать сценарий."
              >
                <div className="flex flex-wrap gap-1.5">
                  {risky.map((tool) => {
                    const on = allowTools.includes(tool.name);
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        onClick={() =>
                          setAllowTools((list) =>
                            on ? list.filter((n) => n !== tool.name) : [...list, tool.name],
                          )
                        }
                        className={clsx(
                          'px-2 py-1 rounded-lg border text-[11px] font-mono transition-colors',
                          on
                            ? 'border-accent bg-accent/10 text-text'
                            : 'border-border text-text-dim hover:text-text',
                        )}
                      >
                        <i className={clsx('bi mr-1', TIER[tool.tier].icon, TIER[tool.tier].tone)} />
                        {tool.name}
                      </button>
                    );
                  })}
                </div>
              </Label>
            )}

            <label className="flex items-center gap-2.5 mb-5 cursor-pointer">
              <Toggle on={notify} onClick={() => setNotify((v) => !v)} />
              <span className="text-[12px] text-text-muted">Уведомлять, когда отработает</span>
            </label>
          </>
        )}

        <div className="flex gap-2 justify-end">
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
            onClick={() =>
              onSave({
                name: name.trim(),
                description,
                source: source.trim(),
                steps,
                schedule,
                budgetTokens: Math.max(1000, Number(budget) || 20000),
                allowTools,
                notify,
              })
            }
            className="h-9 px-4 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

function ScheduleEditor({
  value,
  onChange,
}: {
  value: Schedule;
  onChange: (schedule: Schedule) => void;
}) {
  const time = 'time' in value ? value.time : '09:00';

  return (
    <div className="flex flex-col gap-2">
      <div className="seg">
        {(
          [
            ['daily', 'каждый день'],
            ['weekly', 'по дням'],
            ['interval', 'через промежуток'],
            ['once', 'один раз'],
            ['manual', 'вручную'],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            type="button"
            className={clsx(value.kind === kind && 'active')}
            onClick={() => onChange(defaultFor(kind, time))}
          >
            {label}
          </button>
        ))}
      </div>

      {value.kind === 'daily' && (
        <input
          type="time"
          value={value.time}
          onChange={(e) => onChange({ kind: 'daily', time: e.target.value })}
          className="input h-9 text-[13px] font-mono w-32"
        />
      )}

      {value.kind === 'weekly' && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1">
            {DAYS.map((day, index) => {
              const number = DAY_NUMBER[index]!;
              const on = value.days.includes(number);
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...value,
                      days: on
                        ? value.days.filter((d) => d !== number)
                        : [...value.days, number].sort(),
                    })
                  }
                  className={clsx(
                    'w-8 h-8 rounded-lg border text-[11px] transition-colors',
                    on
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border text-text-dim hover:text-text',
                  )}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <input
            type="time"
            value={value.time}
            onChange={(e) => onChange({ ...value, time: e.target.value })}
            className="input h-9 text-[13px] font-mono w-32"
          />
        </div>
      )}

      {value.kind === 'interval' && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-text-muted">каждые</span>
          <input
            type="number"
            min={5}
            value={value.everyMinutes}
            onChange={(e) =>
              onChange({ kind: 'interval', everyMinutes: Math.max(5, Number(e.target.value) || 5) })
            }
            className="input h-9 text-[13px] font-mono w-24"
          />
          <span className="text-[12px] text-text-muted">минут (минимум 5)</span>
        </div>
      )}

      {value.kind === 'once' && (
        <input
          type="datetime-local"
          value={toLocalInput(value.at)}
          onChange={(e) => onChange({ kind: 'once', at: new Date(e.target.value).toISOString() })}
          className="input h-9 text-[13px] font-mono w-56"
        />
      )}

      {value.kind === 'manual' && (
        <p className="text-[11px] text-text-dim">
          Сама не запускается — только кнопкой «Запустить сейчас».
        </p>
      )}
    </div>
  );
}

function Label({
  text,
  hint,
  children,
}: {
  text: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <label className="block text-[12px] font-medium mb-1.5">{text}</label>
      {hint && <p className="text-[11px] text-text-dim mb-2 leading-relaxed">{hint}</p>}
      {children}
    </div>
  );
}

// ─── Мелочи ─────────────────────────────────────────────────────────────────

function defaultFor(kind: Schedule['kind'], time: string): Schedule {
  switch (kind) {
    case 'daily':
      return { kind: 'daily', time };
    case 'weekly':
      return { kind: 'weekly', days: [1, 2, 3, 4, 5], time };
    case 'interval':
      return { kind: 'interval', everyMinutes: 60 };
    case 'once':
      return { kind: 'once', at: new Date(Date.now() + 3600_000).toISOString() };
    case 'manual':
      return { kind: 'manual' };
  }
}

/** ISO → значение для `datetime-local`, которое работает в местном времени. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describe(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'daily':
      return `каждый день в ${schedule.time}`;
    case 'weekly': {
      const sorted = [...schedule.days].sort();
      const weekdays = sorted.length === 5 && sorted.every((d) => d >= 1 && d <= 5);
      const names = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
      return weekdays
        ? `по будням в ${schedule.time}`
        : `по ${sorted.map((d) => names[d]).join(', ')} в ${schedule.time}`;
    }
    case 'interval':
      return schedule.everyMinutes % 60 === 0
        ? `каждые ${schedule.everyMinutes / 60} ч`
        : `каждые ${schedule.everyMinutes} мин`;
    case 'once':
      return `один раз ${new Date(schedule.at).toLocaleString('ru-RU')}`;
    case 'manual':
      return 'только вручную';
  }
}

/** «через 12 минут», «завтра в 09:00» — понятнее, чем полная дата в списке. */
function when(iso: string): string {
  const target = new Date(iso);
  const minutes = Math.round((target.getTime() - Date.now()) / 60_000);

  if (minutes < 1) return 'вот-вот';
  if (minutes < 60) return `через ${minutes} мин`;

  const today = new Date();
  const time = target.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (target.toDateString() === today.toDateString()) return `сегодня в ${time}`;

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (target.toDateString() === tomorrow.toDateString()) return `завтра в ${time}`;

  return target.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
