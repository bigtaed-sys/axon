/**
 * Плагин для тестов. Ровно то, что напишет автор: обычный JS без сборки,
 * без зависимостей, с одним экспортом `activate`.
 */
export async function activate(api) {
  await api.tools.register({
    name: 'say',
    title: 'Сказать',
    description: 'Вернуть переданный текст с приставкой из настроек.',
    tier: 'safe',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    execute: async (args) => `${api.settings.get('prefix')}: ${args.text}`,
  });

  await api.tools.register({
    name: 'risky',
    title: 'Опасное',
    description: 'Спрашивает разрешение прямо посреди выполнения.',
    tier: 'safe',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      const granted = await ctx.requestPermission('Хочу сделать что-то важное');
      return granted ? 'разрешили' : 'отказали';
    },
  });

  await api.context.contribute('подсказка', 'stable', () => 'Плагин эхо на связи.');

  await api.skills.add({
    name: 'Динамический скилл',
    description: 'Добавлен из кода, а не из файла',
    body: 'Тело динамического скилла.',
  });
}

export function deactivate() {}
