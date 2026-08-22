import { readImpulse, type Conversation, type Impulse as ImpulseSettings } from '@axon/protocol';
import { logger } from '../logger.js';
import { selectForPrompt } from '../memory/Observations.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { Store } from '../storage/Store.js';
import type { ContextBuilder } from './ContextBuilder.js';
import { estimateTokens } from './tokens.js';

/**
 * Инициатива: агент решает написать сам.
 *
 * Устроено в два шага, и это главное решение здесь.
 *
 * Первый шаг — дешёвый: маленький запрос без истории и без инструментов,
 * который отвечает «нет» или «да, потому что». Он выполняется каждые несколько
 * минут и почти всегда возвращает «нет» — за это и платим копейками.
 *
 * Второй шаг — настоящий: полный контекст с личностью, памятью и историей, из
 * которого рождается сообщение тем же голосом, что и в обычном разговоре.
 * Он случается редко, поэтому может себе позволить быть дорогим.
 *
 * Слить их в один запрос не выйдет: чтобы написать хорошее сообщение, нужен
 * весь контекст, а гонять весь контекст раз в пять минут ради ответа «нет» —
 * это счёт, который человек увидит раньше, чем первое сообщение.
 */

/** Как часто проверять, не пора ли. */
const TICK_MS = 5 * 60_000;

/** Потолок дешёвой проверки: ответ — одна строка. */
const GATE_TOKENS = 120;

/** Потолок самого сообщения. Это реплика в разговоре, а не рассылка. */
const MESSAGE_TOKENS = 500;

/**
 * Ключи счётчиков.
 *
 * Пишутся мимо `updateSettings` — то есть без журнального события. Счётчик,
 * меняющийся несколько раз в сутки, не должен будить всех подключённых
 * клиентов уведомлением «настройки изменились»: они начнут перечитывать
 * настройки на каждый порыв агента.
 */
const STATE_LAST_AT = 'impulse.state.lastAt';
const STATE_DAY = 'impulse.state.day';
const STATE_COUNT = 'impulse.state.count';

const GATE_SYSTEM =
  'Ты решаешь, есть ли у агента повод написать человеку первым, не дожидаясь ' +
  'вопроса. Ты не разговариваешь с человеком и не пишешь ему — ты только ' +
  'решаешь.\n\n' +
  'Молчание — нормальный и самый частый ответ. Повод должен быть настоящим: ' +
  'агент обещал вернуться к теме и не вернулся; подошёл срок, о котором шла ' +
  'речь; выяснилось что-то, меняющее прежний вывод; человек давно пропал после ' +
  'незаконченного дела. Не поводы: желание напомнить о себе, дежурный вопрос ' +
  '«как дела», пересказ уже сказанного, предложение помощи без причины.\n\n' +
  'Ответь ровно одной строкой. Либо «нет», либо «да: <повод одной фразой>».';

export interface ImpulseDeps {
  store: Store;
  context: ContextBuilder;
  providers: ProviderRegistry;
}

/** Что решил очередной заход. Наружу — только для тестов и логов. */
export type ImpulseOutcome =
  | { kind: 'skipped'; why: string }
  | { kind: 'silent' }
  | { kind: 'sent'; reason: string; text: string };

export class Impulse {
  private timer: NodeJS.Timeout | null = null;
  /** Идёт проверка: второй заход поверх первого не нужен. */
  private busy = false;

  constructor(private readonly deps: ImpulseDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const outcome = await this.consider();
      if (outcome.kind === 'sent') {
        logger.info({ reason: outcome.reason }, 'агент написал сам');
      }
    } catch (e) {
      // Порыв — не обязанность. Упавшая проверка не должна оставлять следов
      // ни в разговоре, ни в счётчиках: молча ждём следующего захода.
      logger.warn({ err: (e as Error).message }, 'проверка повода не удалась');
    } finally {
      this.busy = false;
    }
  }

  /**
   * Один заход целиком: рамки, повод, сообщение.
   *
   * Вынесено из таймера отдельным методом, потому что иначе это невозможно
   * проверить: тест не станет ждать пять минут, а подмена таймера проверяет
   * таймер, а не решение.
   */
  async consider(now = new Date()): Promise<ImpulseOutcome> {
    const settings = readImpulse(this.deps.store.settings.all());

    const blocked = this.blockedBy(settings, now);
    if (blocked) return { kind: 'skipped', why: blocked };

    const conversation = this.target();
    if (!conversation) return { kind: 'skipped', why: 'нет ни одного разговора' };

    const reason = await this.findReason(conversation, now);
    if (!reason) return { kind: 'silent' };

    const text = await this.compose(conversation, reason);
    if (!text) return { kind: 'silent' };

    this.deliver(conversation, text, reason, now);
    return { kind: 'sent', reason, text };
  }

  // ─── Рамки ────────────────────────────────────────────────────────────────

  /**
   * Почему сейчас нельзя. Пусто — можно.
   *
   * Все проверки бесплатны и идут до единого обращения к модели. Порядок от
   * самой дешёвой к самой редкой, но это второстепенно: важно, что ни одна из
   * них не стоит денег, поэтому таймер может тикать хоть каждую минуту.
   */
  private blockedBy(settings: ImpulseSettings, now: Date): string | null {
    if (!settings.enabled) return 'выключено';
    if (inQuietHours(settings, now)) return 'тихие часы';

    const lastAt = this.deps.store.settings.get<string>(STATE_LAST_AT);
    if (lastAt) {
      const passed = (now.getTime() - Date.parse(lastAt)) / 60_000;
      if (Number.isFinite(passed) && passed < settings.minGapMinutes) return 'слишком рано';
    }

    if (this.todayCount(now) >= settings.maxPerDay) return 'дневная норма исчерпана';

    const idle = this.idleMinutes(now);
    if (idle === null) return 'человек ещё ничего не писал';
    if (idle < settings.idleMinutes) return 'человек только что писал';

    return null;
  }

  /** Сколько минут назад человек писал в последний раз. `null` — никогда. */
  private idleMinutes(now: Date): number | null {
    const last = this.deps.store.messages.lastByRole('user');
    if (!last) return null;
    return (now.getTime() - Date.parse(last.createdAt)) / 60_000;
  }

  private todayCount(now: Date): number {
    const day = this.deps.store.settings.get<string>(STATE_DAY);
    if (day !== dayKey(now)) return 0;
    return this.deps.store.settings.get<number>(STATE_COUNT) ?? 0;
  }

  /**
   * Куда писать: последний живой разговор.
   *
   * Не новый: порыв — это продолжение отношений, а не начало знакомства.
   * Сообщение «помнишь, ты хотел вернуться к X» в пустом разговоре без всякой
   * истории читается как рассылка.
   */
  private target(): Conversation | null {
    return this.deps.store.conversations.list(1)[0] ?? null;
  }

  // ─── Повод ────────────────────────────────────────────────────────────────

  /** Дешёвый вопрос: есть ли о чём писать. Возвращает повод или `null`. */
  private async findReason(conversation: Conversation, now: Date): Promise<string | null> {
    const selection = this.deps.providers.impulse() ?? this.deps.providers.current();

    let answer = '';
    for await (const event of selection.provider.chat({
      model: selection.model,
      messages: [
        { role: 'system', parts: [{ type: 'text', text: GATE_SYSTEM }] },
        { role: 'user', parts: [{ type: 'text', text: this.situation(conversation, now) }] },
      ],
      maxTokens: GATE_TOKENS,
    })) {
      if (event.type === 'text') answer += event.delta;
    }

    return parseReason(answer);
  }

  /**
   * Обстановка для дешёвой проверки.
   *
   * Нарочно без полной истории: она стоит дорого, а для ответа «есть ли повод»
   * хватает хвоста. Зато с наблюдениями — именно в них живёт то, ради чего
   * стоит писать: незакрытые дела и обещания.
   */
  private situation(conversation: Conversation, now: Date): string {
    const lines: string[] = [
      `Сейчас ${now.toLocaleString('ru-RU', { dateStyle: 'full', timeStyle: 'short' })}.`,
    ];

    const idle = this.idleMinutes(now);
    if (idle !== null) lines.push(`Человек последний раз писал ${humanGap(idle)} назад.`);

    const observations = selectForPrompt(this.deps.store.observations.list());
    if (observations.length > 0) {
      lines.push('', 'Что агент о нём знает:');
      for (const observation of observations) lines.push(`- ${observation.text}`);
    }

    const tail = this.deps.store.messages.recent(conversation.id, 6);
    if (tail.length > 0) {
      lines.push('', 'Чем кончился последний разговор:');
      for (const message of tail) {
        const text = message.parts
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => part.text)
          .join(' ')
          .slice(0, 400);
        if (text) lines.push(`${message.role === 'user' ? 'Человек' : 'Агент'}: ${text}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Сообщение ────────────────────────────────────────────────────────────

  /**
   * Написать сообщение полным контекстом.
   *
   * Инструментов здесь нет намеренно. Порыв — это реплика, а не задача: агент,
   * которому позволили сходить в интернет по собственному почину, посреди ночи
   * и без человека рядом, — совсем другой разговор про доверие, и заводить его
   * заодно с инициативой не стоит.
   */
  private async compose(conversation: Conversation, reason: string): Promise<string | null> {
    const built = await this.deps.context.build({
      conversationId: conversation.id,
      userText: reason,
    });

    built.messages.push({
      role: 'user',
      parts: [
        {
          type: 'text',
          text:
            'Служебная вставка, человек её не видит и на неё не отвечал.\n\n' +
            `Ты сам решил написать ему, без вопроса с его стороны. Повод: ${reason}\n\n` +
            'Напиши одно короткое сообщение — так, как написал бы живой человек, ' +
            'который вспомнил о деле. Сразу по существу: без «привет», без ' +
            '«решил написать», без объяснений, почему ты пишешь. Не извиняйся за ' +
            'беспокойство. Если по здравом размышлении писать всё-таки не о чем — ' +
            'ответь одним словом: молчу.',
        },
      ],
    });

    const selection = this.deps.providers.current();

    let text = '';
    for await (const event of selection.provider.chat({
      model: selection.model,
      messages: built.messages,
      maxTokens: MESSAGE_TOKENS,
    })) {
      if (event.type === 'text') text += event.delta;
    }

    const said = text.trim();
    if (!said || /^молчу[.!]?$/i.test(said)) return null;
    return said;
  }

  /** Положить сообщение в разговор и отметить расход рамок. */
  private deliver(conversation: Conversation, text: string, reason: string, now: Date): void {
    const stamp = now.toISOString();

    this.deps.store.transact(() => {
      const message = this.deps.store.appendMessage({
        conversationId: conversation.id,
        role: 'assistant',
        parts: [{ type: 'text', text }],
      });

      this.deps.store.record({
        type: 'impulse.sent',
        conversationId: conversation.id,
        messageId: message.id,
        reason,
      });

      const previous = this.todayCount(now);
      this.deps.store.settings.set(STATE_LAST_AT, stamp, stamp);
      this.deps.store.settings.set(STATE_DAY, dayKey(now), stamp);
      this.deps.store.settings.set(STATE_COUNT, previous + 1, stamp);
    });
  }
}

// ─── Мелочи ───────────────────────────────────────────────────────────────

/**
 * Тихие часы с переходом через полночь.
 *
 * Обычный интервал `from <= t < to` здесь не работает: тишина почти всегда
 * задаётся как 23:00–09:00, то есть с переходом через полночь, и наивное
 * сравнение делает её пустой ровно в те часы, ради которых её и включали.
 */
export function inQuietHours(settings: ImpulseSettings, now: Date): boolean {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const from = toMinutes(settings.quietFrom);
  const to = toMinutes(settings.quietTo);

  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function dayKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

/**
 * Разобрать ответ дешёвой проверки.
 *
 * Модель просили ответить одной строкой, и обычно она слушается — но не
 * всегда. Поэтому разбор устроен так, что любое непонятное считается отказом:
 * ошибиться в сторону молчания дёшево, в сторону сообщения — нет.
 */
export function parseReason(answer: string): string | null {
  const line = answer.trim().split('\n')[0]?.trim() ?? '';
  if (!line) return null;

  const match = /^да\s*[:—-]\s*(.+)$/i.exec(line);
  if (!match) return null;

  const reason = match[1]?.trim() ?? '';
  return reason.length > 0 ? reason : null;
}

function humanGap(minutes: number): string {
  if (minutes < 90) return `${Math.round(minutes)} мин`;
  const hours = minutes / 60;
  if (hours < 36) return `${Math.round(hours)} ч`;
  return `${Math.round(hours / 24)} дн`;
}

/** Оценка расхода одной проверки — для логов и для отчёта о цене. */
export function gateCost(situation: string): number {
  return estimateTokens(GATE_SYSTEM) + estimateTokens(situation) + GATE_TOKENS;
}
