import { describe, expect, it } from 'vitest';
import { decideRetry, ProviderError, sleep } from '../src/index.js';

const limit = (retryAfterMs?: number) =>
  new ProviderError('rate_limit', 'Превышен лимит', {
    provider: 'test',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

describe('повтор обращения к модели', () => {
  it('повторяет лимит запросов и обрыв сети', () => {
    expect(decideRetry(limit(), 0, true)).not.toBeNull();
    expect(decideRetry(new ProviderError('network', 'соединение закрылось'), 0, true)).not.toBeNull();
  });

  it('не повторяет то, что повтором не чинится', () => {
    // Неверный ключ и отсутствующая модель от повтора не исправятся, а вот
    // денег и времени человека отнимут.
    expect(decideRetry(new ProviderError('auth', 'ключ неверен'), 0, true)).toBeNull();
    expect(decideRetry(new ProviderError('model_not_found', 'нет модели'), 0, true)).toBeNull();
    expect(decideRetry(new Error('что-то своё'), 0, true)).toBeNull();
  });

  it('не повторяет, если ответ уже начал приходить', () => {
    // Куски ответа уже ушли клиенту сигналами. Вторая попытка напечатала бы
    // половину ответа дважды — это хуже, чем честно оборванный ответ.
    expect(decideRetry(limit(), 0, false)).toBeNull();
  });

  it('сдаётся после трёх попыток', () => {
    expect(decideRetry(limit(), 2, true)).not.toBeNull();
    expect(decideRetry(limit(), 3, true)).toBeNull();
  });

  it('паузы растут', () => {
    const first = decideRetry(limit(), 0, true)!.waitMs;
    const third = decideRetry(limit(), 2, true)!.waitMs;
    expect(third).toBeGreaterThan(first);
  });

  it('уважает Retry-After, когда он больше плановой паузы', () => {
    const decision = decideRetry(limit(30_000), 0, true)!;
    expect(decision.waitMs).toBeGreaterThanOrEqual(30_000);
  });

  it('не ждёт неприлично долго', () => {
    // Просьба подождать десять минут неотличима от зависания. Лучше честно
    // сдаться и дать человеку решить самому.
    expect(decideRetry(limit(10 * 60_000), 0, true)).toBeNull();
  });

  it('паузу можно прервать отменой прогона', async () => {
    const abort = new AbortController();
    const waiting = sleep(60_000, abort.signal);
    abort.abort();

    await expect(waiting).rejects.toThrow();
  });
});
