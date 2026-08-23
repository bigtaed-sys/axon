import { useEffect, useMemo, useRef } from 'react';
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
}: {
  messages: Message[];
  stream: RunStream | null;
  showToolCalls: boolean;
  client: AxonClient;
  persona: Persona;
  onSuggest: (text: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);

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
    <div ref={container} className="flex-1 overflow-y-auto scrollbar px-6 py-6">
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
}: {
  message: Message;
  results: Map<string, Message>;
  showToolCalls: boolean;
  client: AxonClient;
}) {
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

        {text && (
          <div
            className={clsx(
              'rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed break-words',
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
          </div>
        )}

        {showToolCalls &&
          calls.map((call) => (
            <ToolCallRow key={call.id} call={call} result={results.get(call.id) ?? null} />
          ))}
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
