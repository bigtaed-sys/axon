import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import type { Conversation } from '@axon/protocol';

interface Hit {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: string;
  createdAt: string;
  snippet: string;
}

export function ChatList({
  conversations,
  activeId,
  client,
  onSelect,
  onCreate,
  onArchive,
}: {
  conversations: Conversation[];
  activeId: string | null;
  client: AxonClient;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onArchive: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const needle = query.trim();

  const byTitle = useMemo(() => {
    if (!needle) return conversations;
    const lower = needle.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(lower));
  }, [conversations, needle]);

  /**
   * Поиск по тексту идёт в ядро и потому с задержкой: набирать «раз» и слать
   * запрос на каждую букву — значит гонять индекс вхолостую. Названия при этом
   * фильтруются мгновенно и локально, поэтому пауза не ощущается.
   */
  useEffect(() => {
    if (needle.length < 2) {
      setHits(null);
      return;
    }

    let alive = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void client
        .call('message.search', { query: needle })
        .then((res) => {
          if (alive) setHits(res.hits as Hit[]);
        })
        .catch(() => {
          if (alive) setHits([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 220);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [needle, client]);

  // Находки в разговорах, которые уже видны по названию, не дублируем.
  const titleIds = new Set(byTitle.map((c) => c.id));
  const extraHits = (hits ?? []).filter((hit) => !titleIds.has(hit.conversationId));
  const nothing = needle && byTitle.length === 0 && extraHits.length === 0 && !searching;

  return (
    // Ширина и рамка — дело того, кто ставит список: на компьютере это
    // колонка слева, на телефоне — шторка во весь экран.
    <div className="w-full h-full flex flex-col bg-surface">
      <div className="p-3">
        <button
          type="button"
          onClick={onCreate}
          className="w-full h-10 rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover flex items-center justify-center gap-2 text-[13px] font-medium transition-colors"
        >
          <i className="bi bi-plus-lg" />
          Новый чат
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="relative">
          <i className="bi bi-search absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-text-dim pointer-events-none" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по чатам и тексту…"
            className="input pl-8 pr-8 h-9 text-[12px]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded text-text-dim hover:text-text transition-colors"
            >
              <i className="bi bi-x-lg text-[10px]" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar px-2 pb-3">
        {nothing && <p className="px-2 py-8 text-center text-[12px] text-text-dim">Ничего не нашлось</p>}
        {!needle && conversations.length === 0 && (
          <p className="px-2 py-8 text-center text-[12px] text-text-dim">Пока пусто</p>
        )}

        {byTitle.map((conversation) => (
          <div
            key={conversation.id}
            className={clsx(
              'group mb-0.5 flex items-center gap-2 rounded-lg px-2.5 h-9 text-[13px] cursor-pointer transition-colors',
              conversation.id === activeId
                ? 'bg-bg-hover text-text'
                : 'text-text-muted hover:bg-bg-hover hover:text-text',
            )}
            onClick={() => onSelect(conversation.id)}
          >
            <i className="bi bi-chat-left-text text-[12px] shrink-0 text-text-dim" />
            <span className="truncate flex-1">{conversation.title}</span>

            {conversation.totalTokens > 0 && (
              <span
                className="shrink-0 font-mono text-[10px] text-text-dim group-hover:hidden"
                title={`${conversation.totalTokens.toLocaleString('ru')} токенов в этом разговоре`}
              >
                {compact(conversation.totalTokens)}
              </span>
            )}

            <button
              type="button"
              title="В архив"
              onClick={(e) => {
                e.stopPropagation();
                onArchive(conversation.id);
              }}
              className="shrink-0 hidden group-hover:flex w-5 h-5 items-center justify-center rounded text-text-dim hover:text-danger transition-colors"
            >
              <i className="bi bi-archive text-[12px]" />
            </button>
          </div>
        ))}

        {extraHits.length > 0 && (
          <p className="px-2.5 pt-3 pb-1.5 text-[10px] uppercase tracking-wider text-text-dim">
            В переписке
          </p>
        )}

        {extraHits.map((hit) => (
          <button
            key={hit.messageId}
            type="button"
            onClick={() => onSelect(hit.conversationId)}
            className="w-full mb-1 text-left rounded-lg px-2.5 py-2 hover:bg-bg-hover transition-colors"
          >
            <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <i
                className={clsx(
                  'bi text-[10px] shrink-0',
                  hit.role === 'user' ? 'bi-person' : 'bi-robot',
                )}
              />
              <span className="truncate">{hit.conversationTitle}</span>
            </span>
            <span className="mt-0.5 block text-[11px] leading-snug text-text-dim line-clamp-3">
              <Snippet text={hit.snippet} />
            </span>
          </button>
        ))}

        {searching && extraHits.length === 0 && needle.length >= 2 && (
          <p className="px-2.5 py-2 text-[11px] text-text-dim">Ищу…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Ядро помечает найденные слова «ёлочками» — обычным текстом, а не разметкой.
 * Так подсветка не зависит от того, чем клиент рисует, и не даёт вставить в
 * интерфейс ничего лишнего из переписки.
 */
function Snippet({ text }: { text: string }) {
  return (
    <>
      {text.split(/«([^»]*)»/g).map((chunk, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="bg-transparent text-accent font-medium">
            {chunk}
          </mark>
        ) : (
          <span key={index}>{chunk}</span>
        ),
      )}
    </>
  );
}

function compact(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
