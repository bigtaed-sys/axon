import type { Schedule } from '@axon/protocol';

/**
 * Когда расписание сработает в следующий раз после указанного момента.
 *
 * Считается наперёд и хранится в базе, а не держится таймером в памяти. Разница
 * принципиальная: ядро на личной машине выключают, усыпляют и обновляют.
 * Таймер это не переживает, а записанное «следующий запуск в 9:00» переживает —
 * ядро проснулось, увидело, что время прошло, и отработало.
 *
 * Своего разбора cron-строк здесь нет намеренно. `0 9 * * 1-5` — язык
 * системного администратора, а не человека, которому нужно напоминание по
 * будням; и он тянет за собой правила «или» между днём месяца и днём недели,
 * на которых ошибаются даже те, кто их писал. Четыре понятных вида покрывают
 * то, ради чего расписание вообще заводят.
 */
export function nextRun(schedule: Schedule, after: Date = new Date()): Date | null {
  switch (schedule.kind) {
    // Рутина «только вручную» не планируется вовсе: её запускают кнопкой.
    case 'manual':
      return null;

    case 'once': {
      const at = new Date(schedule.at);
      return at > after ? at : null;
    }

    case 'interval':
      return new Date(after.getTime() + schedule.everyMinutes * 60_000);

    case 'daily':
      // Сегодня, если время ещё впереди, иначе завтра.
      return dayAt(after, 0, schedule.time) > after
        ? dayAt(after, 0, schedule.time)
        : dayAt(after, 1, schedule.time);

    case 'weekly': {
      // Перебираем неделю вперёд. Восьмой день нужен на случай, когда сегодня
      // подходящий день недели, но время уже прошло: тогда ближайший — ровно
      // через неделю.
      const days = new Set(schedule.days);
      for (let offset = 0; offset <= 7; offset++) {
        const candidate = dayAt(after, offset, schedule.time);
        if (candidate > after && days.has(candidate.getDay())) return candidate;
      }
      return null;
    }
  }
}

/** Момент `time` в дне, отстоящем от `from` на `offsetDays`. */
function dayAt(from: Date, offsetDays: number, time: string): Date {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];

  const candidate = new Date(from);
  candidate.setDate(candidate.getDate() + offsetDays);
  candidate.setHours(hours, minutes, 0, 0);
  return candidate;
}

/** Расписание словами — для списка рутин и уведомлений. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'manual':
      return 'только вручную';
    case 'interval': {
      const minutes = schedule.everyMinutes;
      if (minutes % (60 * 24) === 0) {
        const days = minutes / (60 * 24);
        return `каждые ${days} ${plural(days, 'день', 'дня', 'дней')}`;
      }
      if (minutes % 60 === 0) {
        const hours = minutes / 60;
        return `каждые ${hours} ${plural(hours, 'час', 'часа', 'часов')}`;
      }
      return `каждые ${minutes} ${plural(minutes, 'минуту', 'минуты', 'минут')}`;
    }
    case 'daily':
      return `каждый день в ${schedule.time}`;
    case 'weekly': {
      const names = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
      const sorted = [...schedule.days].sort();
      const weekdays = sorted.length === 5 && sorted.every((day) => day >= 1 && day <= 5);
      const label = weekdays ? 'по будням' : `по ${sorted.map((day) => names[day]).join(', ')}`;
      return `${label} в ${schedule.time}`;
    }
    case 'once':
      return `один раз ${new Date(schedule.at).toLocaleString('ru-RU')}`;
  }
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
