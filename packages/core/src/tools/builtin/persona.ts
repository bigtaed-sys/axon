import { z } from 'zod';
import { readPersona } from '@axon/protocol';
import type { Store } from '../../storage/Store.js';
import { defineTool, type ToolDefinition } from '../types.js';

/**
 * Инструмент, которым агент правит собственную личность.
 *
 * Без него «зови меня Саша» живёт ровно до тех пор, пока эта фраза остаётся в
 * окне контекста: сорок сообщений спустя история свернётся в сводку, и агент
 * снова начнёт обращаться никак. Записанное настройкой переживает и сводку, и
 * перезапуск ядра, и переход в другой разговор — а заодно видно и правится на
 * экране настроек, потому что это те же самые ключи.
 *
 * Границы жёсткие и намеренные: только поля личности, ничего больше, и только
 * по прямой просьбе человека. Агент, самовольно переписывающий себе характер,
 * — это не личность, а побег; человек должен узнавать о переменах в поведении
 * от себя самого, а не обнаруживать их.
 */
export function createPersonaTools(store: Store): ToolDefinition[] {
  const setPersona = defineTool({
    name: 'set_persona',
    title: 'Изменить свою личность',
    description:
      'Сохранить, как тебя зовут, как обращаться к человеку и как себя вести. ' +
      'Вызывай, когда человек об этом прямо сказал: «зови меня Сашей», «давай ' +
      'на ты», «отвечай покороче», «хватит шутить», «твоё имя теперь Кузя» — ' +
      'а также когда он отвечает на твои вопросы при знакомстве. Передавай ' +
      'только те поля, о которых шла речь; остальные останутся как были. ' +
      'НЕ вызывай по собственному почину: менять характер без просьбы нельзя, ' +
      'даже если кажется, что так будет лучше.',
    tier: 'safe',
    source: 'builtin',
    schema: z.object({
      name: z.string().min(1).max(40).optional().describe('Как зовут тебя'),
      userName: z.string().max(40).optional().describe('Как зовут человека'),
      address: z.enum(['ты', 'вы']).optional().describe('Обращение к человеку'),
      humor: z
        .enum(['none', 'dry', 'playful'])
        .optional()
        .describe('none — без шуток, dry — сухая ирония, playful — шутит охотно'),
      verbosity: z
        .enum(['short', 'normal', 'detailed'])
        .optional()
        .describe('Длина ответов по умолчанию'),
      initiative: z
        .enum(['low', 'normal', 'high'])
        .optional()
        .describe('Насколько сам предлагает следующий шаг и высказывает мнение'),
      emoji: z.boolean().optional().describe('Использовать ли эмодзи'),
      preset: z
        .enum(['calm', 'warm', 'blunt', 'custom'])
        .optional()
        .describe(
          'Базовый характер: calm — спокойный и прямой, warm — тёплый и ' +
            'участливый, blunt — резкий и предельно краткий. Меняй только если ' +
            'человек описал желаемый характер целиком, а не одну черту.',
        ),
      custom: z
        .string()
        .max(4000)
        .optional()
        .describe(
          'Личные правила словами: язык, область работы, чего не делать. ' +
            'Заменяет прежний текст целиком, поэтому дописывая новое — повтори ' +
            'то, что уже было и остаётся верным.',
        ),
    }),
    async execute(input) {
      const before = readPersona(store.settings.all());

      const patch: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(input)) {
        if (value !== undefined) patch[`persona.${field}`] = value;
      }

      if (Object.keys(patch).length === 0) {
        return { text: 'Нечего менять: ни одно поле не передано' };
      }

      /**
       * Любая осознанная правка означает, что знакомство состоялось.
       *
       * Иначе агент, которому только что сказали, как его зовут, продолжил бы
       * получать задание познакомиться — и спросил бы то же самое ещё раз.
       */
      patch['persona.configured'] = true;

      store.updateSettings({ values: patch });
      const after = readPersona(store.settings.all());

      const changes = describe(before, after);
      return { text: changes.length > 0 ? `Записано: ${changes.join(', ')}` : 'Ничего не изменилось' };
    },
  });

  return [setPersona];
}

/**
 * Чем новое отличается от прежнего — человеческими словами.
 *
 * Возвращать модели «сохранено» недостаточно: она должна увидеть, что именно
 * записалось, чтобы подтвердить это человеку не наугад. Сравнение идёт по
 * разобранной персоне, а не по присланному куску, поэтому отсекаются правки,
 * которые ничего не поменяли.
 */
function describe(before: ReturnType<typeof readPersona>, after: ReturnType<typeof readPersona>) {
  const labels: Partial<Record<keyof typeof after, string>> = {
    name: 'имя',
    userName: 'обращение к человеку',
    address: 'на ты/вы',
    humor: 'юмор',
    verbosity: 'длина ответов',
    initiative: 'инициатива',
    emoji: 'эмодзи',
    preset: 'характер',
    custom: 'личные правила',
  };

  const changes: string[] = [];
  for (const [field, label] of Object.entries(labels) as Array<
    [keyof typeof after, string]
  >) {
    if (before[field] === after[field]) continue;
    const value = after[field];
    changes.push(typeof value === 'string' && value.length <= 40 ? `${label} — ${value}` : label);
  }
  return changes;
}
