import { z } from 'zod';

/**
 * Инициатива: когда агенту позволено заговорить первым.
 *
 * Справочная, куда звонят, — не собеседник. Собеседник иногда пишет сам:
 * вспомнил про обещанное, увидел, что срок подошёл, заметил, что вы давно
 * пропали. Без этого личность остаётся косметикой — характер есть, а прийти
 * с ним некуда, пока человек не начнёт разговор.
 *
 * Всё, что здесь описано, — это ограничения, а не возможности. Возможность
 * одна: написать. Остальное — рамки, в которых это не превращается в спам.
 * Агент, пишущий когда вздумается, выключается на второй день, и вместе с ним
 * выключается всё хорошее, что он мог принести.
 *
 * Поэтому по умолчанию инициатива **выключена**. Программа, которая начинает
 * писать сама сразу после установки, — это не забота, а неожиданность.
 */

const zTimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ');

export const zImpulse = z.object({
  enabled: z.boolean().default(false),

  /** Сколько раз за сутки агент может написать первым. */
  maxPerDay: z.number().int().min(1).max(12).default(3),

  /** Сколько ждать между двумя своими сообщениями. */
  minGapMinutes: z.number().int().min(30).max(24 * 60).default(180),

  /**
   * Сколько человек должен молчать, чтобы к нему имело смысл обращаться.
   *
   * Написать тому, кто ответил пять минут назад, — не инициатива, а помеха:
   * он и так здесь, и если бы хотел продолжить, продолжил бы сам.
   */
  idleMinutes: z.number().int().min(5).max(24 * 60).default(45),

  /** Начало тишины. По умолчанию ночь. */
  quietFrom: zTimeOfDay.default('23:00'),
  quietTo: zTimeOfDay.default('09:00'),
});
export type Impulse = z.infer<typeof zImpulse>;

/** Разобрать настройки инициативы, терпимо к отсутствующим и битым полям. */
export function readImpulse(values: Record<string, unknown>): Impulse {
  const raw: Record<string, unknown> = {};
  for (const field of Object.keys(zImpulse.shape) as Array<keyof Impulse>) {
    const value = values[`impulse.${field}`];
    if (value !== undefined && value !== null) raw[field] = value;
  }

  const parsed = zImpulse.safeParse(raw);
  if (parsed.success) return parsed.data;

  const safe: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(zImpulse.shape)) {
    const one = schema.safeParse(raw[field]);
    if (one.success) safe[field] = one.data;
  }
  return zImpulse.parse(safe);
}
