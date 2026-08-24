import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Message, Persona } from '@axon/protocol';
import type { AxonClient, RunStream } from '@axon/client-sdk';
import { MarkdownBody } from './MarkdownBody.js';
import { Attachments } from './Attachments.js';
import { ToolCallRow } from './ToolCallRow.js';

const PHASE: Record<RunStream['phase'], string> = {
  thinking: 'думает',
  calling_tool: 'вызывает инструмент',
  awaiting_permission: 'ждёт разрешения',
  summarizing: 'сворачивает историю',
  retrying: 'пробует снова',
};

export function MessageList({
  messages,
  stream,
  showToolCalls,
  client,
  persona,
  onSuggest,
  inset,
}: {
  messages: Message[];
  stream: RunStream | null;
  showToolCalls: boolean;
  client: AxonClient;
  persona: Persona;
  onSuggest: (text: string) => void;
  /**
   * Класс для отступов прокручиваемой области.
   *
   * На телефоне шапка висит поверх разговора, и без верхнего отступа первое
   * сообщение начинается под ней. Отступ задаёт тот, кто ставит список: он
   * один знает, что у него плавает сверху.
   */
  inset?: string;
}) {
  const container = useRef<HTMLDivElement>(null);

  /**
   * Последнее сообщение разговора.
   *
   * Переписать можно только его: ответ в середине держит на себе всё, что
   * выросло дальше, и подменять его молча значило бы показать человеку
   * разговор, которого не было.
   */
  const lastId = messages.at(-1)?.id;

  useEffect(() => {
    container.current?.scrollTo({ top: container.current.scrollHeight });
  }, [messages.length, stream?.text]);

  /**
   * Результаты инструментов не рисуются отдельными записями: каждый
   * привязывается к своему вызову и показывается вместе с ним.
   */
  const results = useMemo(() => {
    const map = new Map<string, Message>();
    for (const message of messages) {
      if (message.role === 'tool' && message.toolCallId) map.set(message.toolCallId, message);
    }
    return map;
  }, [messages]);

  const visible = messages.filter((m) => m.role !== 'tool' && m.role !== 'system');
  const empty = visible.length === 0 && !stream;

  return (
    <div ref={container} className={clsx('flex-1 overflow-y-auto scrollbar px-6 py-6', inset)}>
      {empty ? (
        <Welcome persona={persona} onSuggest={onSuggest} />
      ) : (
        <div className="flex flex-col gap-3 max-w-3xl mx-auto">
          {visible.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              results={results}
              showToolCalls={showToolCalls}
              client={client}
              last={message.id === lastId}
            />
          ))}
          {stream && <StreamBubble stream={stream} />}
        </div>
      )}
    </div>
  );
}

/**
 * Пустой разговор.
 *
 * До знакомства и после — это два разных экрана. Пока агент не знает, как его
 * зовут и как обращаться к человеку, полезнее показать, с чего начать
 * знакомство, чем перечислять возможности: возможности никуда не денутся, а
 * первое сообщение человек пишет ровно один раз.
 *
 * Подсказки отправляются нажатием, а не подставляются в поле ввода. Текст,
 * молча появившийся в поле, приходится дочитывать и решать, что с ним делать;
 * нажатие — это ответ, а не заготовка.
 */
function Welcome({ persona, onSuggest }: { persona: Persona; onSuggest: (text: string) => void }) {
  if (!persona.configured) return <FirstMeeting onSuggest={onSuggest} />;

  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6">
      <div className="w-16 h-16 rounded-2xl bg-surface-elev border border-border flex items-center justify-center text-3xl text-accent animate-float">
        <i className="bi bi-stars" />
      </div>
      <h2 className="mt-6 text-xl font-semibold tracking-tight">Чем помочь?</h2>
      <p className="mt-2 text-[13px] text-text-muted max-w-sm leading-relaxed">
        Ядро работает рядом и хранит всё у вас.
      </p>
      <div className="mt-8 grid grid-cols-2 gap-2 max-w-lg w-full">
        <HintCard icon="bi-folder2-open" text="«покажи, что лежит в папке проекта»" />
        <HintCard icon="bi-shield-check" text="опасные действия — только с подтверждением" />
        <HintCard icon="bi-speedometer2" text="бюджет токенов на каждый ответ" />
        <HintCard icon="bi-hdd-network" text="история и ключи не покидают машину" />
      </div>
    </div>
  );
}

function FirstMeeting({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center px-6">
      <div className="w-16 h-16 rounded-2xl bg-surface-elev border border-border flex items-center justify-center text-3xl text-accent animate-float">
        <i className="bi bi-person-badge" />
      </div>

      <h2 className="mt-6 text-xl font-semibold tracking-tight">Вы ещё не знакомы</h2>
      <p className="mt-2 text-[13px] text-text-muted max-w-md leading-relaxed">
        У него пока нет ни имени, ни представления о вас. Напишите первым: он спросит, как его
        звать, как обращаться к вам и как себя вести, — и запомнит ответ. Или начните с дела,
        познакомитесь по ходу.
      </p>

      <div className="mt-7 flex flex-col gap-2 max-w-md w-full">
        <Suggestion onSuggest={onSuggest} text="Привет. Давай знакомиться." />
        <Suggestion
          onSuggest={onSuggest}
          text="Привет. Тебя теперь зовут Кузя, меня — Саша, общаемся на ты."
        />
        <Suggestion onSuggest={onSuggest} text="Отвечай покороче и без шуток." />
      </div>

      <p className="mt-6 text-[11px] text-text-dim max-w-sm leading-relaxed">
        Всё то же самое есть в настройках, на экране «Личность», — если удобнее выкрутить руками.
      </p>
    </div>
  );
}

function HintCard({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="card px-3 py-2.5 text-[12px] text-text-muted flex items-center gap-2 hover:border-border-strong transition-colors">
      <i className={clsx('bi', icon, 'text-accent')} />
      <span className="truncate">{text}</span>
    </div>
  );
}

function Suggestion({ text, onSuggest }: { text: string; onSuggest: (text: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSuggest(text)}
      className="card px-3.5 py-2.5 text-[13px] text-left flex items-center gap-2.5 hover:border-accent transition-colors group"
    >
      <i className="bi bi-chat-left-text text-accent text-[13px]" />
      <span className="flex-1 min-w-0">{text}</span>
      <i className="bi bi-arrow-return-left text-text-dim group-hover:text-text transition-colors text-[12px]" />
    </button>
  );
}

function Bubble({
  message,
  results,
  showToolCalls,
  client,
  last,
}: {
  message: Message;
  results: Map<string, Message>;
  showToolCalls: boolean;
  client: AxonClient;
  last: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isUser = message.role === 'user';
  const text = textOf(message);
  const calls = message.toolCalls ?? [];
  const blobs = message.parts.filter((part) => part.type === 'blob');

  // Ход, в котором модель только вызвала инструмент и ничего не сказала:
  // пузыря нет, показываем один ряд вызова.
  if (!isUser && !text && calls.length > 0) {
    if (!showToolCalls) return null;
    return (
      <div className="flex gap-2.5 animate-msg-in items-start">
        <Avatar isUser={false} />
        <div className="flex flex-col gap-1.5 max-w-[78%] min-w-0 flex-1">
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} result={results.get(call.id) ?? null} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx(
        'flex gap-2.5 animate-msg-in items-start',
        isUser ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      <Avatar isUser={isUser} />

      <div className={clsx('flex flex-col gap-1.5 max-w-[78%] min-w-0', isUser && 'items-end')}>
        {blobs.length > 0 && <Attachments parts={blobs} client={client} />}

        {editing ? (
          <Editing
            value={draft}
            onChange={setDraft}
            onCancel={() => setEditing(false)}
            onSend={() => {
              setEditing(false);
              void client.call('message.edit', {
                id: message.id,
                parts: [{ type: 'text', text: draft }],
              });
            }}
          />
        ) : (
          text && (
          <div
            className={clsx(
              'group rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed break-words relative',
              isUser
                ? 'bg-accent text-accent-fg rounded-br-md whitespace-pre-wrap'
                : 'bg-surface-elev border border-border text-text rounded-bl-md',
            )}
          >
            {/* Ответ агента — Markdown; реплика пользователя остаётся как набрана. */}
            {isUser ? text : <MarkdownBody content={text} />}

            {message.usage && (
              <div className="mt-2 pt-2 border-t border-border text-[10px] text-text-dim font-mono">
                {message.usage.inputTokens + message.usage.outputTokens} токенов
                {message.usage.cachedInputTokens > 0 &&
                  ` · ${cacheShare(message.usage.inputTokens, message.usage.cachedInputTokens)}% из кэша`}
              </div>
            )}

            {/*
              Кнопки появляются по наведению и только там, где действие имеет
              смысл: свой вопрос можно переписать любой, ответ — переписать
              заново только последний.
            */}
            <div
              className={clsx(
                'absolute -bottom-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity',
                isUser ? 'right-2' : 'left-2',
              )}
            >
              {isUser && (
                <Tiny
                  icon="bi-pencil"
                  title="Изменить"
                  onClick={() => {
                    setDraft(text);
                    setEditing(true);
                  }}
                />
              )}
              {!isUser && last && (
                <Tiny
                  icon="bi-arrow-clockwise"
                  title="Ответить заново"
                  onClick={() =>
                    void client.call('message.regenerate', {
                      conversationId: message.conversationId,
                    })
                  }
                />
              )}
            </div>
          </div>
        ))}

        {showToolCalls &&
          calls.map((call) => (
            <ToolCallRow key={call.id} call={call} result={results.get(call.id) ?? null} />
          ))}
      </div>
    </div>
  );
}

/** Кнопка у пузыря: заметна при наведении, не мешает чтению в покое. */
function Tiny({
  icon,
  title,
  onClick,
}: {
  icon: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="w-6 h-6 rounded-md bg-surface border border-border text-text-dim hover:text-text hover:border-border-strong transition-colors flex items-center justify-center shadow-sm"
    >
      <i className={clsx('bi', icon, 'text-[11px]')} />
    </button>
  );
}

/**
 * Правка вопроса на месте.
 *
 * Пузырь заменяется полем ввода, а не открывается окно: человек правит то же
 * самое сообщение там же, где оно лежит, и видит его в ряду с остальными.
 */
function Editing({
  value,
  onChange,
  onCancel,
  onSend,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSend: () => void;
}) {
  return (
    <div className="w-full min-w-[280px] rounded-2xl border border-accent bg-surface p-2">
      <textarea
        autoFocus
        rows={Math.min(8, value.split('\n').length + 1)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && !e.shiftKey && value.trim()) {
            e.preventDefault();
            onSend();
          }
        }}
        className="w-full bg-transparent text-[14px] leading-relaxed outline-none resize-none scrollbar"
      />
      <div className="flex justify-end gap-1.5 mt-1">
        <button
          type="button"
          onClick={onCancel}
          className="h-7 px-2.5 rounded-lg text-[12px] text-text-muted hover:text-text transition-colors"
        >
          Отмена
        </button>
        <button
          type="button"
          disabled={!value.trim()}
          onClick={onSend}
          className="h-7 px-3 rounded-lg bg-accent text-accent-fg text-[12px] font-medium disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          Переспросить
        </button>
      </div>
    </div>
  );
}

function StreamBubble({ stream }: { stream: RunStream }) {
  return (
    <div className="flex gap-2.5 animate-msg-in items-start">
      <Avatar isUser={false} />
      <div className="max-w-[78%] min-w-0 rounded-2xl rounded-bl-md px-4 py-2.5 text-[14px] leading-relaxed break-words bg-surface-elev border border-border">
        {stream.text ? (
          <MarkdownBody content={stream.text} />
        ) : (
          <span className="flex items-center gap-2 text-text-muted text-[13px]">
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
            {PHASE[stream.phase]}
            {stream.detail ? `: ${stream.detail}` : ''}
          </span>
        )}

        {stream.tokensSpent > 0 && (
          <div className="mt-2 pt-2 border-t border-border text-[10px] text-text-dim font-mono">
            {stream.tokensSpent} токенов
            {stream.budgetRemaining !== null && ` · осталось ${stream.budgetRemaining}`}
          </div>
        )}
      </div>
    </div>
  );
}

function Avatar({ isUser }: { isUser: boolean }) {
  if (isUser) {
    return (
      <div className="w-8 h-8 shrink-0 rounded-full bg-accent text-accent-fg flex items-center justify-center text-sm">
        <i className="bi bi-person-fill" />
      </div>
    );
  }
  return (
    <div className="w-8 h-8 shrink-0 rounded-full bg-surface-high border border-border text-accent flex items-center justify-center text-sm">
      <i className="bi bi-robot" />
    </div>
  );
}

/**
 * Текст сообщения. Вложения сюда не попадают — они рисуются отдельно, а не
 * подписью «[файл.png]» посреди реплики.
 */
function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function cacheShare(input: number, cached: number): number {
  const total = input + cached;
  return total === 0 ? 0 : Math.round((cached / total) * 100);
}
