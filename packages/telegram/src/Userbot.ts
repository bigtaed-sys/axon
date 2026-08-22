import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import type { JournalEntry, Scope } from '@axon/protocol';
import { logger, type Runtime } from '@axon/core';

/**
 * Агент под твоим аккаунтом, по явной команде.
 *
 * Это не «второе лицо в переписке» и не фоновый читатель чатов. Ровно одна
 * возможность: ты пишешь `.axon переведи это` в любом чате — и твоё же
 * сообщение заменяется ответом. Всё остальное время юзербот не делает ничего.
 *
 * Разница с ботом принципиальная, и её стоит держать в голове при каждой
 * правке этого файла:
 *
 * - **Сообщения пишутся от твоего имени.** Собеседник видит тебя, а не бота.
 *   Поэтому срабатывание только на явный префикс и только на твои сообщения:
 *   всё, что агент здесь скажет, скажешь как бы ты.
 * - **Подтверждать опасное некому.** Ты посреди чужого чата, а не у экрана,
 *   поэтому инструменты только безопасные.
 * - **Чужая переписка не попадает в память.** Наблюдения — это про тебя, а не
 *   про то, что написал собеседник.
 */

/** Ключ секрета с сессией. Сессия — полный доступ к аккаунту, ей место здесь. */
export const SESSION_SECRET = 'telegram.userSession';

/** Реквизиты приложения с my.telegram.org. Не секрет, но и не на виду. */
export const API_ID_SETTING = 'telegram.apiId';
export const API_HASH_SECRET = 'telegram.apiHash';

/** С чего начинается команда. Меняется в настройках. */
export const TRIGGER_SETTING = 'telegram.trigger';
const DEFAULT_TRIGGER = '.axon';

/** Название разговора, куда складываются команды из чужих чатов. */
const CONVERSATION_TITLE = 'Команды из телеграма';

/** Потолок ответа: одно сообщение телеграма. Длиннее в чужой чат и не надо. */
const MAX_ANSWER = 3800;

export interface UserbotDeps {
  runtime: Runtime;
}

/** Разобранная команда: что просят и к чему это относится. */
export interface Command {
  request: string;
}

/** Сообщение, на которое отвечают, вместе с автором. */
export interface Quoted {
  /** Как зовут написавшего. Пусто — сам человек. */
  author: string;
  text: string;
}

/**
 * Задание для модели.
 *
 * Главное здесь — не формат, а два факта, без которых ответ выходит не тем.
 *
 * Первый: **написанное станет сообщением человека в этом чате**. Без этого
 * модель отвечает так, будто разговаривает с ним, — «вот перевод:», «конечно,
 * сейчас сделаю», — и всё это уезжает собеседнику от его имени.
 *
 * Второй: **цитату написал не он**. Первая версия подставляла текст без автора,
 * и модель считала, что это реплика самого человека, — то есть отвечала ему на
 * то, что сказал его друг.
 */
export function buildPrompt(request: string, quoted: Quoted | null): string {
  const lines = [
    'Ты пишешь от имени человека в его переписке в телеграме. Всё, что ты ' +
      'ответишь, отправится в чат как его собственное сообщение.',
    '',
  ];

  if (quoted) {
    lines.push(
      quoted.author
        ? `Собеседник (${quoted.author}) написал:`
        : 'Человек, от чьего имени ты пишешь, написал ранее:',
      `«${quoted.text}»`,
      '',
    );
  }

  lines.push(
    `Что он просит сделать: ${request}`,
    '',
    'Ответь текстом, который уйдёт в чат как есть. Не обращайся к человеку, ' +
      'который тебя позвал, — он твой ответ не читает, читает собеседник. Без ' +
      'вступлений вроде «вот перевод» и без пояснений о том, что ты сделал.',
  );

  return lines.join('\n');
}

/**
 * Выделить команду из текста сообщения.
 *
 * Отдельной функцией, потому что здесь легко ошибиться в обе стороны: не
 * сработать на своей команде обидно, а сработать на чужом тексте — значит
 * заменить собственное сообщение посреди разговора с человеком.
 *
 * Требуем, чтобы префикс стоял в самом начале и после него шёл пробел или
 * конец строки: иначе `.axonometry` в разговоре про черчение превратится в
 * команду.
 */
export function parseCommand(text: string, trigger: string): Command | null {
  const trimmed = text.trimStart();
  const lower = trimmed.toLowerCase();
  const prefix = trigger.toLowerCase();

  if (!lower.startsWith(prefix)) return null;

  const rest = trimmed.slice(trigger.length);
  if (rest && !/^[\s\n]/.test(rest)) return null;

  const request = rest.trim();
  return request ? { request } : null;
}

export class Userbot {
  private client: TelegramClient | null = null;
  private readonly unsubscribe: Array<() => void> = [];

  /**
   * Прогоны в работе: runId → сообщение, которое надо переписать.
   *
   * Держим сам объект сообщения, а не пару «peer + id». Разница не
   * косметическая: `client.editMessage` требует входной peer, а у свежей
   * сессии кэш сущностей пуст, и сырой `PeerUser` в него не превращается —
   * правка отказывает. У самого сообщения peer уже есть.
   */
  private readonly waiting = new Map<string, Api.Message>();
  /** Ответ агента по разговорам: до конца прогона он ещё дописывается. */
  private readonly said = new Map<string, string>();

  constructor(private readonly deps: UserbotDeps) {}

  async start(session: string, apiId: number, apiHash: string): Promise<{ name: string }> {
    const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
      baseLogger: new Logger(LogLevel.NONE),
    });

    await client.connect();
    const me = (await client.getMe()) as Api.User;

    /**
     * Слушаем только исходящие.
     *
     * Входящие нам не нужны вовсе, и не подписываться на них — не оптимизация,
     * а обещание: агент физически не видит того, что пишут другие, пока его не
     * позвали.
     */
    client.addEventHandler(
      (event: NewMessageEvent) => void this.onOwnMessage(event).catch(() => undefined),
      new NewMessage({ outgoing: true, incoming: false }),
    );

    this.unsubscribe.push(
      this.deps.runtime.store.journal.subscribe((entry) => {
        void this.onJournal(entry).catch(() => undefined);
      }),
    );

    this.client = client;
    return { name: [me.firstName, me.lastName].filter(Boolean).join(' ') || 'аккаунт' };
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    await this.client?.disconnect().catch(() => undefined);
    this.client = null;
  }

  get running(): boolean {
    return this.client !== null;
  }

  // ─── Команда ──────────────────────────────────────────────────────────────

  private async onOwnMessage(event: NewMessageEvent): Promise<void> {
    const message = event.message;
    const text = message.text ?? '';

    const command = parseCommand(text, this.trigger());
    if (!command) return;

    /**
     * Сообщение, на которое отвечаешь, — единственный контекст.
     *
     * Хвост чата не читаем принципиально: команда «переведи это» относится к
     * конкретному сообщению, а не к разговору вообще, и брать двадцать строк
     * чужой переписки ради одной — значит отправлять модели чужое без нужды.
     */
    await this.answer(message, command.request, await quotedOf(message));
  }

  private async answer(
    message: Api.Message,
    request: string,
    quoted: Quoted | null,
  ): Promise<void> {
    const client = this.client;
    if (!client) return;

    const { runId } = this.deps.runtime.orchestrator.startRun({
      conversationId: this.conversation(),
      parts: [{ type: 'text', text: buildPrompt(request, quoted) }],
      /**
       * Только безопасные инструменты.
       *
       * Подтвердить опасное действие некому: ты в чужом чате, а не у экрана.
       * Спросить — значит повесить прогон до таймаута, промолчав в переписке.
       */
      scopes: ['chat.read', 'chat.write', 'tools.safe'] as Scope[],
      platform: 'telegram',
    });

    this.waiting.set(runId, message);

    /**
     * Многоточие вместо растущего черновика.
     *
     * В боте ответ дорисовывается по мере генерации, здесь — нет: это чужой
     * чат, и правка каждые полторы секунды означала бы мельтешение в переписке
     * живого человека, у которого при каждой правке всплывает «изменено».
     * Одна правка в начале, одна в конце.
     */
    await this.show(message, '…');
  }

  private async onJournal(entry: JournalEntry): Promise<void> {
    const event = entry.event;

    if (event.type === 'message.created' && event.message.role === 'assistant') {
      const text = event.message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
      if (text.trim()) this.said.set(event.message.conversationId, text);
      return;
    }

    if (event.type === 'run.finished' || event.type === 'run.failed') {
      const target = this.waiting.get(event.runId);
      if (!target) return;
      this.waiting.delete(event.runId);

      const text =
        event.type === 'run.failed'
          ? `Не получилось: ${event.error}`
          : (this.said.get(event.conversationId) ?? '');
      this.said.delete(event.conversationId);

      /**
       * Пустой ответ заменяем прочерком, а не оставляем многоточие.
       *
       * Это чужой чат: висящее «…» собеседник прочтёт как начатую и брошенную
       * мысль, и переспросит.
       */
      await this.show(target, text.trim() || '—');
    }
  }

  /**
   * Вписать текст в своё же сообщение.
   *
   * Правка, а не новое сообщение: команда исчезает, в переписке остаётся один
   * ответ. Разметку не накладываем — в чужом чате она чаще мешает, чем
   * помогает, а незакрытый тег заставил бы телеграм отвергнуть правку целиком,
   * и на месте команды навсегда осталось бы многоточие.
   */
  private async show(message: Api.Message, text: string): Promise<void> {
    try {
      await message.edit({ text: text.slice(0, MAX_ANSWER) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      // Текст не изменился — телеграм считает это ошибкой, а для нас это
      // норма: попросили вписать то, что уже вписано.
      if (reason.includes('MESSAGE_NOT_MODIFIED')) return;

      /**
       * Молчать здесь нельзя.
       *
       * Именно проглоченная ошибка правки сделала первую версию юзербота
       * необъяснимой: прогон шёл, ответ появлялся в приложении, а в чате не
       * менялось ничего — и понять, почему, было неоткуда.
       */
      logger.warn({ err: reason }, 'не удалось переписать сообщение в телеграме');
    }
  }

  // ─── Мелочи ───────────────────────────────────────────────────────────────

  private trigger(): string {
    const set = this.deps.runtime.store.settings.get<string>(TRIGGER_SETTING);
    return set?.trim() || DEFAULT_TRIGGER;
  }

  /**
   * Отдельный разговор, не общий с десктопом.
   *
   * Команды из чужих чатов засорили бы рабочую переписку обрывками без начала
   * и конца. И главное: то, что агент сказал от твоего имени, должно быть
   * собрано в одном месте — это вопрос доверия, а не порядка.
   */
  private conversation(): string {
    const existing = this.deps.runtime.store.conversations
      .list(50)
      .find((conversation) => conversation.title === CONVERSATION_TITLE);

    return existing ? existing.id : this.deps.runtime.store.createConversation(CONVERSATION_TITLE).id;
  }
}

/**
 * Сообщение, на которое отвечают, вместе с именем автора.
 *
 * Имя обязательно: без него модель принимает цитату за реплику самого
 * человека и отвечает ему на то, что написал его собеседник.
 */
async function quotedOf(message: Api.Message): Promise<Quoted | null> {
  const replied = await message.getReplyMessage().catch(() => null);
  const text = replied?.text?.trim();
  if (!replied || !text) return null;

  // Ответ на собственное сообщение — законный случай: «переведи то, что я
  // написал». Тогда автор не называется, иначе модель решит, что это третий.
  if (replied.out) return { author: '', text };

  const sender = await replied.getSender().catch(() => null);
  return { author: nameOf(sender), text };
}

/** Как зовут отправителя. Человек, канал или неизвестно — три разных случая. */
function nameOf(sender: unknown): string {
  if (!sender || typeof sender !== 'object') return 'собеседник';

  const it = sender as { firstName?: string; lastName?: string; username?: string; title?: string };
  const person = [it.firstName, it.lastName].filter(Boolean).join(' ');

  return person || it.title || it.username || 'собеседник';
}
