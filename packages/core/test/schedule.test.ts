import { describe, expect, it } from 'vitest';
import { describeSchedule, nextRun } from '../src/routines/schedule.js';

/** Понедельник, 10 августа 2026, 08:00 по местному времени. */
const monday = new Date(2026, 7, 10, 8, 0, 0, 0);

describe('расписание', () => {
  it('ежедневное срабатывает сегодня, если время ещё не прошло', () => {
    const at = nextRun({ kind: 'daily', time: '09:30' }, monday)!;
    expect(at.getDate()).toBe(10);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(30);
  });

  it('ежедневное переносится на завтра, если время уже прошло', () => {
    const at = nextRun({ kind: 'daily', time: '07:00' }, monday)!;
    expect(at.getDate()).toBe(11);
    expect(at.getHours()).toBe(7);
  });

  it('недельное находит ближайший подходящий день', () => {
    // Понедельник утром, расписание — среда и пятница.
    const at = nextRun({ kind: 'weekly', days: [3, 5], time: '10:00' }, monday)!;
    expect(at.getDay()).toBe(3);
    expect(at.getDate()).toBe(12);
  });

  it('недельное сегодня, если сегодня подходящий день и время впереди', () => {
    const at = nextRun({ kind: 'weekly', days: [1], time: '18:00' }, monday)!;
    expect(at.getDate()).toBe(10);
    expect(at.getHours()).toBe(18);
  });

  it('недельное переносится на следующую неделю, если сегодня уже поздно', () => {
    const at = nextRun({ kind: 'weekly', days: [1], time: '07:00' }, monday)!;
    expect(at.getDay()).toBe(1);
    expect(at.getDate()).toBe(17);
  });

  it('интервал считается от текущего момента', () => {
    const at = nextRun({ kind: 'interval', everyMinutes: 90 }, monday)!;
    expect(at.getTime() - monday.getTime()).toBe(90 * 60_000);
  });

  it('разовое расписание в прошлом больше не срабатывает', () => {
    const past = new Date(2026, 7, 9, 12, 0).toISOString();
    expect(nextRun({ kind: 'once', at: past }, monday)).toBeNull();

    const future = new Date(2026, 7, 11, 12, 0).toISOString();
    expect(nextRun({ kind: 'once', at: future }, monday)).not.toBeNull();
  });

  it('описание читается человеком', () => {
    expect(describeSchedule({ kind: 'daily', time: '09:00' })).toBe('каждый день в 09:00');
    expect(describeSchedule({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' })).toBe(
      'по будням в 09:00',
    );
    expect(describeSchedule({ kind: 'weekly', days: [6, 0], time: '12:00' })).toBe(
      'по вс, сб в 12:00',
    );
    expect(describeSchedule({ kind: 'interval', everyMinutes: 30 })).toBe('каждые 30 минут');
    expect(describeSchedule({ kind: 'interval', everyMinutes: 120 })).toBe('каждые 2 часа');
    expect(describeSchedule({ kind: 'interval', everyMinutes: 1440 })).toBe('каждые 1 день');
  });
});
