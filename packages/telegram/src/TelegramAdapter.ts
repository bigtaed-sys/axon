import type { Device, JournalEntry, PermissionRequest, Scope } from '@axon/protocol';
import type { Runtime } from '@axon/core';
import { BotApi, TelegramError, type TelegramMessage, type Update } from './BotApi.js';
import { split, toTelegramHtml } from './format.js';

/**
 * Телеграм-бот как ещё одно окно к ядру.
 *
 * Адаптер — клиент, а не плагин. У плагинов нет права писать в переписку, и это
 * правильно: плагин расширяет возможности агента, а не говорит от его имени.
 * Телеграм же по своей природе клиент — «рисует и вводит», ровно как десктоп,
 * только вместо окна у него чат.
 *
 * Разговор общий с десктопом. Закрыл ноутбук — продолжил с телефона с того же
 * места: контекст один, кэш промпта один, расход не умножается на число
 * экранов. Отдельная ветка «для телефона» сломала бы то единственное, ради чего
 * ядро вообще вынесено в отдельную программу.
 *
 * Работает внутри процесса ядра, а не через сокет к самому себе. Но
 * регистрируется настоящим устройством: видно в списке, отзывается кнопкой,
 * права проверяются наравне со всеми. Без этого телеграм оказался бы дырой
 * мимо модели доступа — а он как раз тот канал, где чужой человек напишет
 * первым.
 */

/** Ключ секрета с токеном бота. Токен — пароль от бота, ему место в секретах. */
export const BOT_TOKEN_SECRET = 'telegram.botToken';

/** Кому позволено писать: `{ [chatId]: deviceId }`. */
const CHATS_SETTING = 'telegram.chats';

/** Пауза после сетевой ошибки. Телеграм лежит редко, но лежит. */
const RETRY_MS = 5_000;

/** Как часто повторять «печатает…»: телеграм гасит его через пять секунд. */
const TYPING_MS = 4_000;

interface Bound {
  deviceId: string;
  name: string;
}

export interface TelegramDeps {
  runtime: Runtime;
  /** Обменять код привязки на устройство. Тот же механизм, что у десктопа. */
  pair(code: string, name: string): { device: Device } | null;
  /** Ответить на запрос разрешения. Отдельно, потому что это не часть ядра. */
  resolvePermission(requestId: string, allow: boolean, deviceId: string): void;
}

export class TelegramAdapter {
  private readonly api: BotApi;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private unsubscribe: (() => void) | null = null;

  /** Чат, куда ушёл последний вопрос: туда же уйдёт ответ и запрос разрешения. */
  private waiting = new Map<string, number>();
  /** Показанные запросы разрешений: id запроса → сообщение с кнопками. */
  private asked = new Map<string, { chatId: number; messageId: number }>();
  /** Последний ответ агента по разговорам — до конца прогона он ещё дописывается. */
  private said = new Map<string, string>();

  constructor(
    private readonly deps: TelegramDeps,
    token: string,
  ) {
    this.api = new BotApi(token);
  }

  async start(): Promise<{ username: string }> {
    const me = await this.api.getMe();

    this.unsubscribe = this.deps.runtime.store.journal.subscribe((entry) => {
      void this.onJournal(entry).catch(() => {
        // Ошибка отправки не должна ронять журнал: он общий для всех клиентов.
      });
    });

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
    this.unsubscribe?.();
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
          error instanceof TelegramError && error.retryAfter
            ? error.retryAfter * 1000
            : RETRY_MS;
        await sleep(wait);
      }
    }
  }

  private async handle(update: Update): Promise<void> {
    if (update.callback_query) return this.onButton(update.callback_query);

    const message = update.message;
    if (!message?.from || message.chat.type !== 'private') return;

    const text = (message.text ?? message.caption ?? '').trim();

    if (text.startsWith('/start')) return this.onStart(message, text);

    const bound = this.bindingOf(message.chat.id);
    if (!bound) {
      /**
       * Чужому — отказ, и ни одного обращения к модели.
       *
       * Бот виден по имени всякому, кто его угадал. Отвечать незнакомцу значило
       * бы тратить деньги владельца и показывать его память постороннему.
       */
      await this.api.sendMessage(
        message.chat.id,
        'Это личный агент, и мы незнакомы.\n\n' +
          'Если он ваш — откройте настройки Axon, раздел «Устройства», создайте код ' +
          'подключения и пришлите его командой <code>/start КОД</code>.',
        { parseMode: 'HTML' },
      );
      return;
    }

    if (!text) return;
    await this.ask(message, bound, text);
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
          'Настройки Axon → «Устройства» → создать код, потом сюда: ' +
          '<code>/start КОД</code>',
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
      'Готово, теперь мы знакомы. Разговор общий с десктопом: что начали там, ' +
        'можно продолжить здесь.',
    );
  }

  /** Вопрос агенту. Разговор — тот же, что у десктопа. */
  private async ask(message: TelegramMessage, bound: Bound, text: string): Promise<void> {
    const device = this.deps.runtime.store.devices.get(bound.deviceId);
    if (!device) {
      // Устройство отозвали из десктопа — связь разорвана, и молчать нельзя.
      this.unbind(message.chat.id);
      await this.api.sendMessage(message.chat.id, 'Доступ отозван.');
      return;
    }

    const conversation = this.conversation();
    const { runId } = this.deps.runtime.orchestrator.startRun({
      conversationId: conversation,
      parts: [{ type: 'text', text }],
      scopes: device.scopes as Scope[],
      platform: 'telegram',
    });

    this.waiting.set(runId, message.chat.id);
    void this.typing(runId, message.chat.id);
  }

  /** «Печатает…», пока идёт прогон. Телеграм гасит индикатор через пять секунд. */
  private async typing(runId: string, chatId: number): Promise<void> {
    while (this.waiting.has(runId) && !this.stopped) {
      await this.api.sendTyping(chatId);
      await sleep(TYPING_MS);
    }
  }

  // ─── Отправка ─────────────────────────────────────────────────────────────

  private async onJournal(entry: JournalEntry): Promise<void> {
    const event = entry.event;

    /**
     * Ответ собирается в два события, а не в одно.
     *
     * У сообщения нет ссылки на прогон — связать его с вопросом можно только
     * через разговор. Поэтому текст запоминается на `message.created`, а
     * отправляется на `run.finished`: до конца прогона агент может сходить в
     * инструменты и дописать ответ, и отправлять его раньше значило бы слать
     * человеку черновик, а следом ещё один.
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

      if (text) await this.say(chatId, text);
      else if (event.stopReason !== 'end_turn') {
        await this.api.sendMessage(chatId, `Прогон остановлен: ${event.stopReason}`);
      }
      return;
    }

    if (event.type === 'run.failed') {
      const chatId = this.waiting.get(event.runId);
      if (chatId === undefined) return;
      this.waiting.delete(event.runId);
      await this.api.sendMessage(chatId, `Не получилось: ${event.error}`);
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

  private async say(chatId: number, text: string): Promise<void> {
    if (!text.trim()) return;

    for (const chunk of split(toTelegramHtml(text))) {
      try {
        await this.api.sendMessage(chatId, chunk, { parseMode: 'HTML' });
      } catch (error) {
        /**
         * Разметка не понравилась телеграму — отправляем как есть.
         *
         * Молча потерять ответ нельзя: человек ждёт его и не узнает, что тот
         * был. Лучше показать текст со звёздочками, чем не показать ничего.
         */
        if (!(error instanceof TelegramError)) throw error;
        await this.api.sendMessage(chatId, stripTags(chunk));
      }
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

  private async onButton(query: { id: string; data?: string; from: { id: number } }): Promise<void> {
    const [action, requestId] = (query.data ?? '').split(':');
    if (!requestId || (action !== 'allow' && action !== 'deny')) return;

    const bound = this.bindingOf(query.from.id);
    if (!bound) return void this.api.answerCallback(query.id, 'Мы незнакомы');

    this.deps.resolvePermission(requestId, action === 'allow', bound.deviceId);
    await this.api.answerCallback(query.id, action === 'allow' ? 'Разрешено' : 'Отказано');

    await this.closeAsked(requestId, action === 'allow' ? '✓ Разрешено' : '✕ Отказано');
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
   * Разговор для телеграма — последний живой, тот же, что открыт в десктопе.
   *
   * Заводится новый, только если разговоров нет вовсе: писать в пустоту некуда.
   */
  private conversation(): string {
    const existing = this.deps.runtime.store.conversations.list(1)[0];
    if (existing) return existing.id;
    return this.deps.runtime.store.createConversation('Разговор').id;
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

function textOf(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Снять разметку, когда телеграм её не принял. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
