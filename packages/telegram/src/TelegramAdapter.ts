import type {
  ContentPart,
  Device,
  JournalEntry,
  PermissionRequest,
  Scope,
  Signal,
} from '@axon/protocol';
import type { Runtime } from '@axon/core';
import {
  BotApi,
  TelegramError,
  type InlineButton,
  type TelegramMessage,
  type Update,
} from './BotApi.js';
import { split, toTelegramHtml } from './format.js';

/**
 * Телеграм-бот как ещё одно окно к ядру.
 *
 * Адаптер — клиент, а не плагин. У плагинов нет права писать в переписку, и это
 * правильно: плагин расширяет возможности агента, а не говорит от его имени.
 * Телеграм же по своей природе клиент — «рисует и вводит», ровно как десктоп,
 * только вместо окна у него чат.
 *
 * По умолчанию разговор общий с десктопом: закрыл ноутбук — продолжил с
 * телефона с того же места. Но его можно и закрепить командой, если с телефона
 * ведёшь своё, не мешаясь в рабочую переписку.
 *
 * Работает внутри процесса ядра, а не через сокет к самому себе. Но
 * регистрируется настоящим устройством: видно в списке, отзывается кнопкой,
 * права проверяются наравне со всеми. Без этого телеграм оказался бы дырой
 * мимо модели доступа — а он как раз тот канал, где чужой человек напишет
 * первым.
 */

/** Ключ секрета с токеном бота. Токен — пароль от бота, ему место в секретах. */
export const BOT_TOKEN_SECRET = 'telegram.botToken';

/** Кому позволено писать: `{ [chatId]: Bound }`. */
const CHATS_SETTING = 'telegram.chats';

/** Пауза после сетевой ошибки. Телеграм лежит редко, но лежит. */
const RETRY_MS = 5_000;

/**
 * Как часто дорисовывать растущий ответ.
 *
 * Реже, чем хочется: у правки сообщений своя частотная квота, и телеграм
 * начинает отвечать отказами задолго до того, как это станет заметно глазу.
 * Полторы секунды — компромисс между «видно, что пишет» и «не поругались».
 */
const EDIT_EVERY_MS = 1_500;

/** Сколько разговоров показывать в списке. Больше на телефоне не пролистать. */
const CHATS_SHOWN = 8;

/** Потолок вложения: Bot API всё равно не отдаёт файлы крупнее двадцати мегабайт. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Запас до предела сообщения: растущий черновик правится без разрезания. */
const DRAFT_LIMIT = 3800;

interface Bound {
  deviceId: string;
  name: string;
  /**
   * Закреплённый разговор. Пусто — идти за приложением, то есть за последним
   * живым. Умолчание именно такое: контекст один на все окна, и это главное
   * свойство всей конструкции. Закрепление — осознанный отказ от него.
   */
  conversationId?: string;
}

/** Живой ответ: сообщение, которое дорисовывается по мере генерации. */
interface Draft {
  chatId: number;
  messageId: number;
  text: string;
  shown: string;
  timer: NodeJS.Timeout | null;
}

export interface TelegramDeps {
  runtime: Runtime;
  /** Обменять код привязки на устройство. Тот же механизм, что у десктопа. */
  pair(code: string, name: string): { device: Device } | null;
  /** Ответить на запрос разрешения. Отдельно, потому что это не часть ядра. */
  resolvePermission(requestId: string, allow: boolean, deviceId: string): void;
  /** Подписка на эфемерику: куски ответа приходят сигналами, а не журналом. */
  onSignal(listener: (signal: Signal) => void): () => void;
}

export class TelegramAdapter {
  private readonly api: BotApi;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly unsubscribe: Array<() => void> = [];

  /** Прогоны, ответа которых ждут: runId → чат. */
  private readonly waiting = new Map<string, number>();
  /** Растущие ответы: runId → сообщение, которое дорисовывается. */
  private readonly drafts = new Map<string, Draft>();
  /** Показанные запросы разрешений: id запроса → сообщение с кнопками. */
  private readonly asked = new Map<string, { chatId: number; messageId: number }>();
  /** Последний ответ агента по разговорам — до конца прогона он ещё дописывается. */
  private readonly said = new Map<string, string>();

  constructor(
    private readonly deps: TelegramDeps,
    token: string,
  ) {
    this.api = new BotApi(token);
  }

  async start(): Promise<{ username: string }> {
    const me = await this.api.getMe();

    this.unsubscribe.push(
      this.deps.runtime.store.journal.subscribe((entry) => {
        void this.onJournal(entry).catch(() => {
          // Ошибка отправки не должна ронять журнал: он общий для всех клиентов.
        });
      }),
      this.deps.onSignal((signal) => this.onSignal(signal)),
    );

    this.loop = this.poll();
    return { username: me.username ?? 'бот' };
  }

  /**
   * Есть ли кому отвечать на запросы разрешений.
   *
   * Ядро на сервере часто работает вообще без открытого десктопа, и телеграм
   * там — единственный, кто может подтвердить действие. Без этого признака
   * ядро отказывало бы во всём опасном, считая, что спросить некого.
   */
  get hasAudience(): boolean {
    return this.chats().length > 0;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    for (const off of this.unsubscribe) off();
    for (const draft of this.drafts.values()) if (draft.timer) clearTimeout(draft.timer);
    this.drafts.clear();
    await this.loop?.catch(() => undefined);
  }

  // ─── Приём ────────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    while (!this.stopped) {
      try {
        const updates = await this.api.getUpdates(this.abort.signal);
        for (const update of updates) await this.handle(update);
      } catch (error) {
        if (this.stopped) return;

        /**
         * Пауза перед повтором обязательна.
         *
         * Без неё упавший запрос превращается в цикл без задержки: телеграм
         * недоступен, а мы жжём процессор и получаем бан по частоте на
         * восстановлении. При 429 телеграм сам говорит, сколько ждать.
         */
        const wait =
          error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : RETRY_MS;
        await sleep(wait);
      }
    }
  }

  private async handle(update: Update): Promise<void> {
    if (update.callback_query) return this.onButton(update.callback_query);

    const message = update.message;
    if (!message?.from) return;

    /**
     * Только личные чаты.
     *
     * В группе привязка теряет смысл: она по чату, а людей там много, и
     * привязав группу, владелец раздал бы всем участникам своего агента — с
     * памятью о себе и своим счётом за токены. Групповая работа — отдельное
     * решение, а не мелкая доработка.
     */
    if (message.chat.type !== 'private') return;

    const text = (message.text ?? message.caption ?? '').trim();

    if (text.startsWith('/start')) return this.onStart(message, text);

    const bound = this.bindingOf(message.chat.id);
    if (!bound) return this.refuse(message.chat.id);

    if (text.startsWith('/new')) return this.onNew(message.chat.id, bound, text);
    if (text.startsWith('/chats')) return this.onChats(message.chat.id, bound);
    if (text.startsWith('/help')) return this.onHelp(message.chat.id);

    const parts = await this.partsOf(message, text);
    if (parts.length === 0) return;

    await this.ask(message.chat.id, bound, parts);
  }

  /**
   * Чужому — отказ, и ни одного обращения к модели.
   *
   * Бот виден по имени всякому, кто его угадал. Отвечать незнакомцу значило бы
   * тратить деньги владельца и показывать его память постороннему.
   */
  private async refuse(chatId: number): Promise<void> {
    await this.api.sendMessage(
      chatId,
      'Это личный агент, и мы незнакомы.\n\n' +
        'Если он ваш — откройте настройки Axon, раздел «Устройства», создайте код ' +
        'подключения и пришлите его командой <code>/start КОД</code>.',
      { parseMode: 'HTML' },
    );
  }

  /** Привязка: `/start КОД` меняет код на устройство, как это делает десктоп. */
  private async onStart(message: TelegramMessage, text: string): Promise<void> {
    const code = text.slice('/start'.length).trim();

    if (this.bindingOf(message.chat.id)) {
      await this.api.sendMessage(message.chat.id, 'Уже на связи. Пишите.');
      return;
    }

    if (!code) {
      await this.api.sendMessage(
        message.chat.id,
        'Нужен код подключения.\n\n' +
          'Настройки Axon → «Устройства» → создать код, потом сюда: <code>/start КОД</code>',
        { parseMode: 'HTML' },
      );
      return;
    }

    const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ');
    const paired = this.deps.pair(code.toUpperCase(), `Телеграм: ${name || message.chat.id}`);

    if (!paired) {
      await this.api.sendMessage(message.chat.id, 'Код не подошёл — истёк или уже использован.');
      return;
    }

    this.bind(message.chat.id, { deviceId: paired.device.id, name });
    await this.api.sendMessage(
      message.chat.id,
      'Готово, теперь мы знакомы.\n\n' +
        'По умолчанию отвечаю в том же разговоре, что открыт в приложении, — начатое там ' +
        'можно продолжить здесь. <code>/chats</code> переключает разговор, <code>/new</code> ' +
        'заводит новый.',
      { parseMode: 'HTML' },
    );
  }

  private async onHelp(chatId: number): Promise<void> {
    await this.api.sendMessage(
      chatId,
      '<code>/chats</code> — выбрать разговор\n' +
        '<code>/new</code> — новый разговор\n' +
        '<code>/new название</code> — новый с названием\n\n' +
        'Можно присылать фото и файлы: картинку опишу и дальше буду помнить описанием.',
      { parseMode: 'HTML' },
    );
  }

  // ─── Выбор разговора ──────────────────────────────────────────────────────

  private async onNew(chatId: number, bound: Bound, text: string): Promise<void> {
    const title = text.slice('/new'.length).trim();
    const conversation = this.deps.runtime.store.createConversation(title || 'Разговор');

    this.bind(chatId, { ...bound, conversationId: conversation.id });
    await this.api.sendMessage(chatId, `Новый разговор: ${conversation.title}. Пишите.`);
  }

  /**
   * Список разговоров кнопками.
   *
   * Отдельным пунктом — «идти за приложением»: это возврат к умолчанию, и без
   * него закрепление оказалось бы дорогой в один конец. Человек, закрепивший
   * разговор однажды, иначе навсегда терял бы главное свойство — общий
   * контекст между окнами.
   */
  private async onChats(chatId: number, bound: Bound): Promise<void> {
    const conversations = this.deps.runtime.store.conversations.list(CHATS_SHOWN);
    if (conversations.length === 0) {
      await this.api.sendMessage(chatId, 'Разговоров пока нет. <code>/new</code> заведёт первый.', {
        parseMode: 'HTML',
      });
      return;
    }

    const active = this.conversationOf(bound);
    const buttons: InlineButton[][] = conversations.map((conversation) => [
      {
        text: `${conversation.id === active ? '● ' : ''}${conversation.title}`,
        callback_data: `chat:${conversation.id}`,
      },
    ]);

    if (bound.conversationId) {
      buttons.push([{ text: '↩ идти за приложением', callback_data: 'follow' }]);
    }

    await this.api.sendMessage(
      chatId,
      bound.conversationId
        ? 'Разговор закреплён за этим чатом.'
        : 'Иду за приложением — отвечаю там же, где открыто оно.',
      { buttons },
    );
  }

  // ─── Вложения ─────────────────────────────────────────────────────────────

  /**
   * Части сообщения: текст плюс вложения.
   *
   * Фото и файлы кладутся в блоб-хранилище ядра, как из десктопа. Картинку
   * потом опишет назначенная для этого модель, и описание останется в истории
   * текстом — то есть вложение стоит токенов один раз, а не переотправляется
   * на каждом следующем ходу.
   */
  private async partsOf(message: TelegramMessage, text: string): Promise<ContentPart[]> {
    const parts: ContentPart[] = [];

    // Из размеров фото берём последний: телеграм отдаёт их по возрастанию, и
    // модели нужен самый крупный — на мелком не разобрать, ради чего снимали.
    const photo = message.photo?.at(-1);
    if (photo) {
      const part = await this.download(photo.file_id, 'image/jpeg', 'фото.jpg', photo.file_size);
      if (part) parts.push(part);
    }

    if (message.document) {
      const part = await this.download(
        message.document.file_id,
        message.document.mime_type ?? 'application/octet-stream',
        message.document.file_name ?? 'файл',
        message.document.file_size,
      );
      if (part) parts.push(part);
    }

    if (message.voice) {
      const part = await this.download(
        message.voice.file_id,
        message.voice.mime_type ?? 'audio/ogg',
        'голосовое.ogg',
        message.voice.file_size,
      );
      if (part) parts.push(part);
    }

    if (text) parts.push({ type: 'text', text });
    return parts;
  }

  private async download(
    fileId: string,
    mime: string,
    name: string,
    size?: number,
  ): Promise<ContentPart | null> {
    if (size && size > MAX_ATTACHMENT_BYTES) return null;

    try {
      const file = await this.api.downloadFile(fileId);
      const blob = await this.deps.runtime.blobs.write({ data: file.bytes, mime, name });
      return { type: 'blob', blobId: blob.blobId, mime, bytes: blob.bytes, name };
    } catch {
      // Не скачалось — обидно, но текст сообщения всё равно надо обработать.
      return null;
    }
  }

  // ─── Вопрос и ответ ───────────────────────────────────────────────────────

  private async ask(chatId: number, bound: Bound, parts: ContentPart[]): Promise<void> {
    const device = this.deps.runtime.store.devices.get(bound.deviceId);
    if (!device) {
      // Устройство отозвали из десктопа — связь разорвана, и молчать нельзя.
      this.unbind(chatId);
      await this.api.sendMessage(chatId, 'Доступ отозван.');
      return;
    }

    const { runId } = this.deps.runtime.orchestrator.startRun({
      conversationId: this.conversationOf(bound),
      parts,
      scopes: device.scopes as Scope[],
      platform: 'telegram',
    });

    this.waiting.set(runId, chatId);

    /**
     * Пузырь заводится сразу.
     *
     * Ответ с инструментами идёт полминуты, и всё это время человек смотрит в
     * молчание, не зная, дошло ли сообщение вообще. Индикатор «печатает…» тут
     * не спасает: он гаснет через пять секунд и ничего не говорит о ходе дела.
     */
    try {
      const placeholder = await this.api.sendMessage(chatId, '…');
      this.drafts.set(runId, {
        chatId,
        messageId: placeholder.message_id,
        text: '',
        shown: '…',
        timer: null,
      });
    } catch {
      // Не завёлся — ответ придёт обычным сообщением в конце прогона.
    }
  }

  /** Кусок ответа от модели: копим и изредка дорисовываем. */
  private onSignal(signal: Signal): void {
    if (signal.type === 'run.delta') {
      const draft = this.drafts.get(signal.runId);
      if (!draft) return;
      draft.text += signal.text;
      this.scheduleEdit(signal.runId, draft);
      return;
    }

    if (signal.type === 'run.phase' && signal.phase === 'calling_tool') {
      const draft = this.drafts.get(signal.runId);
      if (!draft || draft.text) return;
      // Пока текста нет, показываем, чем занят: молчащий пузырь тревожнее,
      // чем честное «смотрю в файлы».
      void this.show(draft, `⚙ ${signal.detail ?? 'работаю'}…`);
    }
  }

  private scheduleEdit(runId: string, draft: Draft): void {
    if (draft.timer) return;

    draft.timer = setTimeout(() => {
      draft.timer = null;
      const current = this.drafts.get(runId);
      if (current) void this.show(current, plain(current.text));
    }, EDIT_EVERY_MS);
    draft.timer.unref?.();
  }

  private async show(draft: Draft, text: string): Promise<void> {
    const trimmed = text.trim().slice(0, DRAFT_LIMIT);
    if (!trimmed || trimmed === draft.shown) return;

    draft.shown = trimmed;
    // Черновик показываем без разметки: посреди генерации она почти всегда с
    // незакрытым тегом, и телеграм отверг бы правку целиком.
    await this.api.editMessage(draft.chatId, draft.messageId, trimmed).catch(() => undefined);
  }

  private async onJournal(entry: JournalEntry): Promise<void> {
    const event = entry.event;

    /**
     * Ответ собирается в два события, а не в одно.
     *
     * У сообщения нет ссылки на прогон — связать его с вопросом можно только
     * через разговор. Поэтому текст запоминается на `message.created`, а
     * отправляется на `run.finished`: до конца прогона агент может сходить в
     * инструменты и дописать ответ.
     */
    if (event.type === 'message.created' && event.message.role === 'assistant') {
      const text = textOf(event.message.parts);
      if (text.trim()) this.said.set(event.message.conversationId, text);
      return;
    }

    if (event.type === 'run.finished') {
      const chatId = this.waiting.get(event.runId);
      if (chatId === undefined) return;
      this.waiting.delete(event.runId);

      const text = this.said.get(event.conversationId);
      this.said.delete(event.conversationId);

      await this.finish(event.runId, chatId, text ?? '', event.stopReason);
      return;
    }

    if (event.type === 'run.failed') {
      const chatId = this.waiting.get(event.runId);
      if (chatId === undefined) return;
      this.waiting.delete(event.runId);
      await this.finish(event.runId, chatId, '', 'error', event.error);
      return;
    }

    if (event.type === 'permission.requested') {
      await this.askPermission(event.request);
      return;
    }

    if (event.type === 'permission.resolved') {
      // Ответили с другого устройства — кнопки здесь уже не нужны.
      await this.closeAsked(event.requestId, 'Решено на другом устройстве');
      return;
    }

    if (event.type === 'impulse.sent') {
      /**
       * Агент написал сам. Телеграм — единственный канал, где это доходит до
       * человека, не сидящего за компьютером; ради этого инициатива и делалась.
       */
      const message = this.deps.runtime.store.messages.get(event.messageId);
      if (!message) return;
      for (const chatId of this.chats()) await this.say(chatId, textOf(message.parts));
    }
  }

  /** Дорисовать черновик набело: разметка, разрезание, объяснение отказа. */
  private async finish(
    runId: string,
    chatId: number,
    text: string,
    stopReason: string,
    error?: string,
  ): Promise<void> {
    const draft = this.drafts.get(runId);
    if (draft?.timer) clearTimeout(draft.timer);
    this.drafts.delete(runId);

    const body = pickBody(text, stopReason, error);

    if (!body) {
      // Сказать нечего, а пузырь висит — убираем многоточие, чтобы оно не
      // осталось единственным следом разговора.
      if (draft) {
        await this.api.editMessage(draft.chatId, draft.messageId, '—').catch(() => undefined);
      }
      return;
    }

    const chunks = split(toTelegramHtml(body));
    const first = chunks.shift() ?? '';

    if (draft) {
      const edited = await this.api
        .editMessage(draft.chatId, draft.messageId, first, { parseMode: 'HTML' })
        .then(() => true)
        .catch(() => false);

      /**
       * Разметка не понравилась — показываем то же самое без неё.
       *
       * Потерять ответ нельзя: человек его ждёт и не узнает, что тот был.
       * Лучше текст со звёздочками, чем пустота.
       */
      if (!edited) {
        await this.api
          .editMessage(draft.chatId, draft.messageId, stripTags(first))
          .catch(() => undefined);
      }
    } else {
      await this.sendChunk(chatId, first);
    }

    for (const chunk of chunks) await this.sendChunk(chatId, chunk);
  }

  private async say(chatId: number, text: string): Promise<void> {
    if (!text.trim()) return;
    for (const chunk of split(toTelegramHtml(text))) await this.sendChunk(chatId, chunk);
  }

  private async sendChunk(chatId: number, chunk: string): Promise<void> {
    if (!chunk.trim()) return;

    try {
      await this.api.sendMessage(chatId, chunk, { parseMode: 'HTML' });
    } catch (error) {
      if (!(error instanceof TelegramError)) throw error;
      await this.api.sendMessage(chatId, stripTags(chunk));
    }
  }

  // ─── Разрешения ───────────────────────────────────────────────────────────

  /**
   * Опасное действие подтверждается кнопкой под сообщением.
   *
   * Здесь телеграм сильнее десктопа: inline-клавиатура — это готовый диалог
   * разрешения, а не выдумка ради канала. Поэтому ограничивать телеграм одними
   * безопасными инструментами не пришлось.
   */
  private async askPermission(request: PermissionRequest): Promise<void> {
    const chatId = this.waiting.get(request.runId);
    if (chatId === undefined) return;

    const sent = await this.api.sendMessage(
      chatId,
      `<b>${escapeHtml(request.toolName)}</b>\n${escapeHtml(request.reason)}`,
      {
        parseMode: 'HTML',
        buttons: [
          [
            { text: '✓ Разрешить', callback_data: `allow:${request.id}` },
            { text: '✕ Отказать', callback_data: `deny:${request.id}` },
          ],
        ],
      },
    );

    this.asked.set(request.id, { chatId, messageId: sent.message_id });
  }

  private async onButton(query: {
    id: string;
    data?: string;
    from: { id: number };
    message?: TelegramMessage;
  }): Promise<void> {
    const data = query.data ?? '';
    const bound = this.bindingOf(query.from.id);
    if (!bound) return void this.api.answerCallback(query.id, 'Мы незнакомы');

    if (data === 'follow') {
      const { conversationId: _pinned, ...rest } = bound;
      this.bind(query.from.id, rest);
      await this.api.answerCallback(query.id, 'Иду за приложением');
      await this.replace(query, 'Иду за приложением.');
      return;
    }

    if (data.startsWith('chat:')) {
      const id = data.slice('chat:'.length);
      const conversation = this.deps.runtime.store.conversations.get(id);
      if (!conversation) return void this.api.answerCallback(query.id, 'Разговор исчез');

      this.bind(query.from.id, { ...bound, conversationId: id });
      await this.api.answerCallback(query.id, conversation.title);
      await this.replace(query, `Разговор: ${conversation.title}`);
      return;
    }

    const [action, requestId] = data.split(':');
    if (!requestId || (action !== 'allow' && action !== 'deny')) return;

    this.deps.resolvePermission(requestId, action === 'allow', bound.deviceId);
    await this.api.answerCallback(query.id, action === 'allow' ? 'Разрешено' : 'Отказано');
    await this.closeAsked(requestId, action === 'allow' ? '✓ Разрешено' : '✕ Отказано');
  }

  /** Заменить сообщение с кнопками на итог: висящие кнопки читаются как незавершённость. */
  private async replace(
    query: { from: { id: number }; message?: TelegramMessage },
    text: string,
  ): Promise<void> {
    if (!query.message) return;
    await this.api
      .editMessage(query.from.id, query.message.message_id, text)
      .catch(() => undefined);
  }

  /**
   * Убрать кнопки у отвеченного запроса.
   *
   * Нажать второй раз всё равно нечего, а висящие кнопки выглядят так, будто
   * решение не приняли, — и человек жмёт снова, получая молчание.
   */
  private async closeAsked(requestId: string, verdict: string): Promise<void> {
    const shown = this.asked.get(requestId);
    if (!shown) return;

    this.asked.delete(requestId);
    await this.api.editMessage(shown.chatId, shown.messageId, verdict).catch(() => undefined);
  }

  // ─── Привязки ─────────────────────────────────────────────────────────────

  /**
   * Куда писать: закреплённый разговор или последний живой.
   *
   * Закреплённый мог быть удалён или заархивирован с десктопа — тогда молча
   * возвращаемся к умолчанию, вместо того чтобы писать в никуда.
   */
  private conversationOf(bound: Bound): string {
    if (bound.conversationId) {
      const pinned = this.deps.runtime.store.conversations.get(bound.conversationId);
      if (pinned && !pinned.archived) return pinned.id;
    }

    const last = this.deps.runtime.store.conversations.list(1)[0];
    return last ? last.id : this.deps.runtime.store.createConversation('Разговор').id;
  }

  private bindings(): Record<string, Bound> {
    return this.deps.runtime.store.settings.get<Record<string, Bound>>(CHATS_SETTING) ?? {};
  }

  private bindingOf(chatId: number): Bound | null {
    return this.bindings()[String(chatId)] ?? null;
  }

  private chats(): number[] {
    return Object.keys(this.bindings()).map(Number);
  }

  private bind(chatId: number, bound: Bound): void {
    this.deps.runtime.store.updateSettings({
      values: { [CHATS_SETTING]: { ...this.bindings(), [String(chatId)]: bound } },
    });
  }

  private unbind(chatId: number): void {
    const rest = { ...this.bindings() };
    delete rest[String(chatId)];
    this.deps.runtime.store.updateSettings({ values: { [CHATS_SETTING]: rest } });
  }
}

/**
 * Что показать в итоге: ответ, причину отказа или ничего.
 *
 * Вынесено из отправки, потому что это решение, а не оформление: у него три
 * ветки, и в теле метода они тонули среди правок сообщений.
 */
export function pickBody(text: string, stopReason: string, error?: string): string {
  if (text.trim()) return text;
  if (error) return `Не получилось: ${error}`;
  return stopReason === 'end_turn' ? '' : `Прогон остановлен: ${stopReason}`;
}

function textOf(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

/** Черновик показываем без разметки — посреди генерации она почти всегда рваная. */
export function plain(text: string): string {
  return text.replace(/[*_`~]/g, '');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Снять разметку, когда телеграм её не принял. */
export function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
