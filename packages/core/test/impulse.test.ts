import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { zImpulse } from '@axon/protocol';
import { createRuntime, inQuietHours, parseReason, type Runtime } from '../src/index.js';

let runtime: Runtime;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-impulse-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Разговор с сообщением человека, отправленным за столько-то минут до `now`.
 *
 * Время отсчитывается от переданного момента, а не от настоящего: тесты про
 * рамки задают «сейчас» сами, и сообщение, поставленное относительно реального
 * времени, оказалось бы то в прошлом, то в будущем — в зависимости от того, в
 * котором часу запустили тесты.
 */
function conversationWithUserMessage(now: Date, minutesAgo: number): void {
  const chat = runtime.store.createConversation('Тест');
  const message = runtime.store.appendMessage({
    conversationId: chat.id,
    role: 'user',
    parts: [{ type: 'text', text: 'привет' }],
  });
  // Время создания не меняется через репозиторий — правим запись напрямую:
  // ждать в тесте сорок минут невозможно.
  runtime.db
    .prepare(`UPDATE messages SET created_at = ? WHERE id = ?`)
    .run(new Date(now.getTime() - minutesAgo * 60_000).toISOString(), message.id);
}

describe('тихие часы', () => {
  const settings = zImpulse.parse({ quietFrom: '23:00', quietTo: '09:00' });

  it('срабатывают ночью через полночь', () => {
    // Ровно тот случай, на котором ломается наивное `from <= t < to`:
    // интервал 23:00–09:00 при таком сравнении пуст, то есть тишина не
    // работает именно в те часы, ради которых её включали.
    expect(inQuietHours(settings, at('23:30'))).toBe(true);
    expect(inQuietHours(settings, at('03:00'))).toBe(true);
    expect(inQuietHours(settings, at('08:59'))).toBe(true);
  });

  it('не срабатывают днём', () => {
    expect(inQuietHours(settings, at('09:00'))).toBe(false);
    expect(inQuietHours(settings, at('14:00'))).toBe(false);
    expect(inQuietHours(settings, at('22:59'))).toBe(false);
  });

  it('обычный дневной интервал тоже работает', () => {
    const daytime = zImpulse.parse({ quietFrom: '10:00', quietTo: '12:00' });
    expect(inQuietHours(daytime, at('11:00'))).toBe(true);
    expect(inQuietHours(daytime, at('09:00'))).toBe(false);
    expect(inQuietHours(daytime, at('13:00'))).toBe(false);
  });

  it('совпадающие границы означают «тишины нет»', () => {
    const none = zImpulse.parse({ quietFrom: '00:00', quietTo: '00:00' });
    expect(inQuietHours(none, at('00:00'))).toBe(false);
    expect(inQuietHours(none, at('12:00'))).toBe(false);
  });
});

describe('разбор ответа о поводе', () => {
  it('понимает согласие с поводом', () => {
    expect(parseReason('да: он обещал вернуться к переносу базы')).toBe(
      'он обещал вернуться к переносу базы',
    );
    expect(parseReason('Да — подошёл срок, о котором шла речь')).toBe(
      'подошёл срок, о котором шла речь',
    );
  });

  it('всё непонятное считает отказом', () => {
    // Ошибиться в сторону молчания дёшево, в сторону сообщения — нет.
    expect(parseReason('нет')).toBeNull();
    expect(parseReason('')).toBeNull();
    expect(parseReason('Пожалуй, стоило бы написать про базу')).toBeNull();
    expect(parseReason('да')).toBeNull();
    expect(parseReason('да:   ')).toBeNull();
  });

  it('берёт только первую строку', () => {
    expect(parseReason('да: срок вышел\nа ещё можно спросить, как дела')).toBe('срок вышел');
  });
});

describe('рамки инициативы', () => {
  it('по умолчанию выключена', async () => {
    // Программа, которая начинает писать сама сразу после установки, — это не
    // забота, а неожиданность.
    const outcome = await runtime.impulse.consider();
    expect(outcome).toEqual({ kind: 'skipped', why: 'выключено' });
  });

  it('молчит, пока человек не написал ни разу', async () => {
    runtime.store.updateSettings({ values: { 'impulse.enabled': true } });
    runtime.store.createConversation('Пустой');

    const outcome = await runtime.impulse.consider(at('14:00'));
    expect(outcome).toEqual({ kind: 'skipped', why: 'человек ещё ничего не писал' });
  });

  it('не лезет к тому, кто только что писал', async () => {
    const now = at('14:00');
    runtime.store.updateSettings({ values: { 'impulse.enabled': true } });
    conversationWithUserMessage(now, 5);

    const outcome = await runtime.impulse.consider(now);
    expect(outcome).toEqual({ kind: 'skipped', why: 'человек только что писал' });
  });

  it('молчит в тихие часы, даже когда повод мог бы найтись', async () => {
    const now = at('03:00');
    runtime.store.updateSettings({ values: { 'impulse.enabled': true } });
    conversationWithUserMessage(now, 600);

    const outcome = await runtime.impulse.consider(now);
    expect(outcome).toEqual({ kind: 'skipped', why: 'тихие часы' });
  });

  it('держит паузу между своими сообщениями', async () => {
    const now = at('14:00');
    const recently = new Date(now.getTime() - 10 * 60_000).toISOString();
    runtime.store.updateSettings({ values: { 'impulse.enabled': true } });
    runtime.store.settings.set('impulse.state.lastAt', recently, recently);
    conversationWithUserMessage(now, 600);

    const outcome = await runtime.impulse.consider(now);
    expect(outcome).toEqual({ kind: 'skipped', why: 'слишком рано' });
  });

  it('уважает дневную норму', async () => {
    const now = at('14:00');
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    runtime.store.updateSettings({
      values: { 'impulse.enabled': true, 'impulse.maxPerDay': 2 },
    });
    runtime.store.settings.set('impulse.state.day', day, now.toISOString());
    runtime.store.settings.set('impulse.state.count', 2, now.toISOString());
    conversationWithUserMessage(now, 600);

    const outcome = await runtime.impulse.consider(now);
    expect(outcome).toEqual({ kind: 'skipped', why: 'дневная норма исчерпана' });
  });

  it('вчерашний счётчик сегодня не мешает', async () => {
    const now = at('14:00');
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const day = `${yesterday.getFullYear()}-${yesterday.getMonth() + 1}-${yesterday.getDate()}`;
    runtime.store.updateSettings({
      values: { 'impulse.enabled': true, 'impulse.maxPerDay': 1 },
    });
    runtime.store.settings.set('impulse.state.day', day, now.toISOString());
    runtime.store.settings.set('impulse.state.count', 5, now.toISOString());
    conversationWithUserMessage(now, 600);

    // Норма не исчерпана — значит, дошли до обращения к модели. Провайдер в
    // тесте не настроен, поэтому заход упадёт, но упадёт уже за рамками.
    await expect(runtime.impulse.consider(now)).rejects.toThrow();
  });
});

/** Сегодняшняя дата с заданным временем: тесты про часы не должны зависеть от даты. */
function at(time: string): Date {
  const [hours, minutes] = time.split(':');
  const date = new Date();
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date;
}
