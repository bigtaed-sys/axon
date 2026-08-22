/**
 * Клиент Bot API — ровно те методы, которые нужны адаптеру.
 *
 * Своими руками, а не готовой библиотекой, и это осознанно. Телеграм-библиотеки
 * тянут с собой роутеры, сцены, машины состояний и middleware — целый каркас
 * приложения. Наше приложение уже есть, и оно называется ядром: адаптеру нужен
 * не каркас, а восемь HTTP-вызовов. Библиотека здесь добавила бы полсотни
 * зависимостей и свой взгляд на то, как устроен разговор, — второй, спорящий с
 * нашим.
 *
 * Long polling, а не webhook: публичный адрес есть не у всех, а ядро должно
 * работать и на домашнем мини-ПК за NATом. Webhook добавится рядом, когда
 * появится сервер с доменом, — это смена одного метода получения обновлений.
 */

const API = 'https://api.telegram.org';

/** Сколько телеграм держит запрос открытым, если обновлений нет. */
const POLL_TIMEOUT_SECONDS = 25;

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
}

export interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface Update {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: CallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    /** Сколько секунд просили подождать. Есть только у 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'TelegramError';
  }
}

export class BotApi {
  /** Смещение подтверждённых обновлений: без него телеграм шлёт одно и то же. */
  private offset = 0;

  constructor(private readonly token: string) {}

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {});
  }

  /**
   * Ждать обновлений.
   *
   * Возвращает пустой список, когда за отведённое время ничего не пришло, —
   * это норма, а не ошибка. Смещение двигается сразу: обновление, отданное
   * наружу, считается принятым, иначе упавший обработчик заставит телеграм
   * присылать одно и то же сообщение бесконечно.
   */
  async getUpdates(signal?: AbortSignal): Promise<Update[]> {
    const updates = await this.call<Update[]>(
      'getUpdates',
      {
        offset: this.offset,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
      (POLL_TIMEOUT_SECONDS + 10) * 1000,
    );

    for (const update of updates) {
      if (update.update_id >= this.offset) this.offset = update.update_id + 1;
    }
    return updates;
  }

  async sendMessage(
    chatId: number,
    text: string,
    options: {
      /** Разметка. Пусто — обычный текст, никакого разбора. */
      parseMode?: 'HTML';
      buttons?: InlineButton[][];
      replyTo?: number;
    } = {},
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
      ...(options.replyTo ? { reply_parameters: { message_id: options.replyTo } } : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string,
    options: { parseMode?: 'HTML'; buttons?: InlineButton[][] } = {},
  ): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options.parseMode ? { parse_mode: options.parseMode } : {}),
      reply_markup: options.buttons ? { inline_keyboard: options.buttons } : { inline_keyboard: [] },
      link_preview_options: { is_disabled: true },
    });
  }

  /** Погасить «часики» на нажатой кнопке. Без этого она крутится до таймаута. */
  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: id,
      ...(text ? { text } : {}),
    });
  }

  /** «Печатает…» — живёт пять секунд, поэтому шлётся повторно во время работы. */
  async sendTyping(chatId: number): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {
      // Индикатор — украшение. Не доехал — не повод ронять ответ.
    });
  }

  /** Скачать вложение. Двухшаговый: сначала путь, потом файл. */
  async downloadFile(fileId: string): Promise<{ bytes: Buffer; path: string }> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramError('Телеграм не отдал путь к файлу', 0);

    const response = await fetch(`${API}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      throw new TelegramError(`Файл не скачался: ${response.status}`, response.status);
    }
    return { bytes: Buffer.from(await response.arrayBuffer()), path: file.file_path };
  }

  private async call<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<T> {
    /**
     * Свой таймаут поверх переданной отмены.
     *
     * `fetch` без таймаута висит вечно, а зависший `getUpdates` — это адаптер,
     * который молча перестал работать: процесс жив, ошибок нет, сообщения не
     * приходят. Хуже явной ошибки, потому что не видно.
     */
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const onOuter = (): void => abort.abort();
    signal?.addEventListener('abort', onOuter);

    try {
      const response = await fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abort.signal,
      });

      const body = (await response.json()) as {
        ok: boolean;
        result?: T;
        description?: string;
        parameters?: { retry_after?: number };
      };

      if (!body.ok) {
        throw new TelegramError(
          body.description ?? `Телеграм отклонил ${method}`,
          response.status,
          body.parameters?.retry_after,
        );
      }
      return body.result as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuter);
    }
  }
}
