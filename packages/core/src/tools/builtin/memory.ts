import { z } from 'zod';
import { normalizeObservation } from '../../storage/repos.js';
import type { Store } from '../../storage/Store.js';
import { defineTool, type ToolDefinition } from '../types.js';

/**
 * Инструменты памяти — единственный safe-набор, который агент использует
 * постоянно. Описания написаны предписывающе: когда вызывать, а не только
 * что делает. Модели заметно лучше попадают в нужный инструмент, когда в
 * описании есть условие срабатывания.
 */
export function createMemoryTools(store: Store): ToolDefinition[] {
  const remember = defineTool({
    name: 'remember',
    title: 'Запомнить факт',
    description:
      'Сохранить факт о пользователе или его окружении на будущее. Вызывай, когда ' +
      'пользователь сообщает что-то устойчивое: имена людей и мест, параметры ' +
      'окружения, договорённости по работе. Не сохраняй сиюминутное — то, что ' +
      'верно только внутри текущего разговора. И не дублируй сюда то, что ' +
      'относится к вашему общению: как тебя зовут, как обращаться к человеку, ' +
      'на «ты» или на «вы», насколько подробно отвечать — это живёт в ' +
      'set_persona, и запись того же самого фактом рано или поздно разойдётся ' +
      'с настоящей настройкой.',
    tier: 'safe',
    source: 'builtin',
    schema: z.object({
      key: z
        .string()
        .min(1)
        .max(200)
        .describe('Короткий ключ факта, например "рабочий язык" или "часовой пояс"'),
      value: z.string().min(1).max(4000).describe('Значение факта'),
    }),
    async execute({ key, value }) {
      const fact = store.upsertFact(key, value, 'inferred');
      return { text: `Запомнено: ${fact.key} — ${fact.value}` };
    },
  });

  const forget = defineTool({
    name: 'forget',
    title: 'Забыть факт',
    description:
      'Удалить ранее сохранённый факт по ключу. Вызывай, когда пользователь ' +
      'говорит, что информация устарела или неверна.',
    tier: 'safe',
    source: 'builtin',
    schema: z.object({
      key: z.string().min(1).max(200).describe('Ключ факта, который нужно удалить'),
    }),
    async execute({ key }) {
      const fact = store.facts.byKey(key);
      if (!fact) return { text: `Факта "${key}" в памяти нет` };
      store.forgetFact(fact.id);
      return { text: `Забыто: ${key}` };
    },
  });

  const recall = defineTool({
    name: 'recall',
    title: 'Вспомнить факты',
    description:
      'Показать сохранённые факты о пользователе. Вызывай только когда нужно ' +
      'свериться с памятью по конкретному поводу — основные факты и так ' +
      'подставляются в контекст автоматически.',
    tier: 'safe',
    source: 'builtin',
    // Редко нужен: схему в контекст сразу не грузим.
    deferred: true,
    schema: z.object({
      search: z.string().max(200).optional().describe('Подстрока для фильтрации по ключу'),
    }),
    async execute({ search }) {
      const facts = store.facts
        .list()
        .filter((f) => !search || f.key.toLowerCase().includes(search.toLowerCase()));

      if (facts.length === 0) return { text: 'В памяти пусто' };
      return { text: facts.map((f) => `- ${f.key}: ${f.value}`).join('\n') };
    },
  });

  /**
   * Наблюдение — отдельный инструмент от `remember`, и это принципиально.
   *
   * Один инструмент с полем «тип» модель использовала бы почти всегда с
   * умолчанием: выбирать между значениями перечисления она не любит и лишний
   * раз не станет. Два инструмента с разными описаниями заставляют решить, что
   * именно перед ней — проверенный факт или собственная догадка, — а от этого
   * зависит, будет ли агент спорить с человеком, ссылаясь на прошлый вторник.
   */
  const notice = defineTool({
    name: 'notice',
    title: 'Отметить наблюдение',
    description:
      'Записать наблюдение о человеке или о том, как идёт общение: что ему ' +
      'нравится и что раздражает, над чем он работает эти недели, чем кончился ' +
      'прошлый заход на ту же задачу, в каком он настроении. Вызывай, когда ' +
      'заметил что-то, чего человек прямо не говорил, — в отличие от remember, ' +
      'который для проверенных фактов. Заметил то же самое второй раз — вызывай ' +
      'снова: повтор укрепляет наблюдение, дубля не будет.',
    tier: 'safe',
    source: 'builtin',
    schema: z.object({
      text: z
        .string()
        .min(1)
        .max(400)
        .describe('Наблюдение одной фразой, от первого лица о человеке'),
      kind: z
        .enum(['habit', 'preference', 'context', 'mood', 'relationship'])
        .describe(
          'habit — устойчивая привычка; preference — вкус или предпочтение; ' +
            'context — чем занят сейчас; mood — состояние на эти дни; ' +
            'relationship — как складывается общение с тобой',
        ),
    }),
    async execute({ text, kind }) {
      const observation = store.notice(text, kind);
      return {
        text:
          observation.hits > 1
            ? `Наблюдение подтверждено (${observation.hits}-й раз): ${observation.text}`
            : `Отмечено: ${observation.text}`,
      };
    },
  });

  const unnotice = defineTool({
    name: 'unnotice',
    title: 'Отбросить наблюдение',
    description:
      'Удалить своё наблюдение, которое оказалось неверным. Вызывай, когда ' +
      'человек прямо возразил против того, что ты о нём предполагал.',
    tier: 'safe',
    source: 'builtin',
    deferred: true,
    schema: z.object({
      text: z.string().min(1).max(400).describe('Текст наблюдения, которое нужно отбросить'),
    }),
    async execute({ text }) {
      const norm = normalizeObservation(text);
      const observation = store.observations.byNorm(norm);
      if (!observation) return { text: 'Такого наблюдения нет' };

      store.forgetObservation(observation.id);
      return { text: `Отброшено: ${observation.text}` };
    },
  });

  return [remember, forget, recall, notice, unnotice];
}
