import { z } from 'zod';
import { zTimestamp } from './primitives.js';

/**
 * Настройки делятся на две несмешиваемые категории.
 *
 * Обычные значения ездят по проводу как есть. Секреты — API-ключи, токены,
 * пароли — не покидают ядро **никогда**: ни по WS, ни по REST, ни владельцу.
 * Наружу отдаётся только статус «задан / не задан» и хвост из нескольких
 * символов, чтобы человек узнал свой ключ, не получив его.
 *
 * Подсмотреть значение целиком можно единственным способом — локальной CLI
 * ядра на той же машине. У кого физический доступ к машине, у того и так есть
 * и файл БД, и всё остальное; а вот украденный токен устройства не должен
 * давать доступ к ключам.
 */
export const zSecretStatus = z.object({
  key: z.string(),
  set: z.boolean(),
  /** Последние символы значения. Присутствует, только если секрет задан. */
  hint: z.string().max(8).optional(),
  updatedAt: zTimestamp.optional(),
  /**
   * Значение лежит, но расшифровать его нечем.
   *
   * Так бывает после переноса: база приехала, а ключ шифрования рядом с ней —
   * нет (`axon backup` не кладёт его в архив без спроса). Снаружи это выглядело
   * как «ключ на месте», хотя ни один запрос с ним не проходит.
   */
  unreadable: z.boolean().optional(),
});
export type SecretStatus = z.infer<typeof zSecretStatus>;

export const zSettingsGetReq = z.object({
  /** Какие ключи вернуть. Пусто — все, к которым у устройства есть доступ. */
  keys: z.array(z.string()).optional(),
});
export const zSettingsGetRes = z.object({
  values: z.record(z.unknown()),
  secrets: z.array(zSecretStatus),
});

export const zSettingsSetReq = z.object({
  values: z.record(z.unknown()).optional(),
  /**
   * Секреты пишутся только в одну сторону. `null` — стереть.
   * Прочитать записанное через протокол нельзя в принципе.
   */
  secrets: z.record(z.string().nullable()).optional(),
});
