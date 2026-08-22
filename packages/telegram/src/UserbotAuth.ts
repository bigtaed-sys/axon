import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { computeCheck } from 'telegram/Password.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';

/**
 * Вход в телеграм под своим аккаунтом.
 *
 * Написано состоянием, а не колбэками, хотя у GramJS есть готовый `start` с
 * функциями «спроси телефон», «спроси код». Причина простая: те функции
 * рассчитаны на терминал, где можно заблокироваться и ждать ввода. У нас ввод
 * идёт из окна настроек через протокол, и блокирующее ожидание посреди ядра
 * означало бы висящую команду и таймаут на клиенте.
 *
 * Поэтому три отдельных шага, между которыми состояние живёт в памяти ядра:
 * телефон → код → пароль (если включена двухфакторка). Незавершённый вход
 * ничего не портит: сессия появляется только после успешного шага.
 *
 * Сессия — это полный доступ к аккаунту, а не «токен бота». Она ложится в
 * хранилище секретов рядом с ключами от моделей и наружу не отдаётся никогда.
 */

/** Чем закончился шаг входа. */
export type AuthStep =
  | { kind: 'code_sent'; hint: string }
  | { kind: 'password_needed' }
  | { kind: 'done'; session: string; name: string };

interface Pending {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
}

export class UserbotAuth {
  /** Начатые входы: телефон → незавершённое состояние. */
  private pending: Pending | null = null;

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
  ) {}

  /** Шаг первый: попросить телеграм прислать код. */
  async sendCode(phone: string): Promise<AuthStep> {
    await this.dropPending();

    const client = new TelegramClient(new StringSession(''), this.apiId, this.apiHash, {
      connectionRetries: 3,
      // Иначе GramJS пишет в консоль ядра целыми абзацами на каждый пакет.
      baseLogger: new Logger(LogLevel.NONE),
    });

    await client.connect();
    const sent = await client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone);

    this.pending = { client, phone, phoneCodeHash: sent.phoneCodeHash };
    return { kind: 'code_sent', hint: sent.isCodeViaApp ? 'в телеграме' : 'сообщением' };
  }

  /**
   * Шаг второй: код из телеграма.
   *
   * Двухфакторка отдаёт `SESSION_PASSWORD_NEEDED` — это не ошибка, а
   * продолжение, и обращаться с ней как с отказом значит терять начатый вход
   * там, где он идёт нормально.
   */
  async signIn(code: string): Promise<AuthStep> {
    const pending = this.require();

    try {
      await pending.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: pending.phone,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
    } catch (error) {
      if (!isPasswordNeeded(error)) throw error;
      return { kind: 'password_needed' };
    }

    return this.finish();
  }

  /** Шаг третий: пароль двухфакторки. */
  async checkPassword(password: string): Promise<AuthStep> {
    const pending = this.require();

    const settings = await pending.client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(settings, password);
    await pending.client.invoke(new Api.auth.CheckPassword({ password: check }));

    return this.finish();
  }

  /** Бросить незавершённый вход: человек передумал или начал заново. */
  async cancel(): Promise<void> {
    await this.dropPending();
  }

  private async finish(): Promise<AuthStep> {
    const pending = this.require();
    const me = (await pending.client.getMe()) as Api.User;

    const session = String(pending.client.session.save());
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ') || pending.phone;

    await pending.client.disconnect();
    this.pending = null;

    return { kind: 'done', session, name };
  }

  private require(): Pending {
    if (!this.pending) throw new Error('Вход не начат: сначала пришлите телефон');
    return this.pending;
  }

  private async dropPending(): Promise<void> {
    if (!this.pending) return;
    await this.pending.client.disconnect().catch(() => undefined);
    this.pending = null;
  }
}

/**
 * Двухфакторка сообщает о себе ошибкой, а не полем ответа.
 *
 * Проверяем по тексту, потому что GramJS отдаёт эту ошибку разными классами в
 * зависимости от того, где она возникла, и ловить по типу ненадёжнее.
 */
function isPasswordNeeded(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('SESSION_PASSWORD_NEEDED');
}
