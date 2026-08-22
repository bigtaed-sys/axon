/**
 * Регистрирует инструмент и тут же убивает себя. Проверяет главное обещание
 * вынесения плагинов в процесс: ядро это переживает, а инструмент исчезает из
 * реестра, а не остаётся висеть указателем в никуда.
 */
export async function activate(api) {
  await api.tools.register({
    name: 'boom',
    title: 'Бум',
    description: 'Существует ровно до того момента, как процесс умрёт.',
    tier: 'safe',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'не дождётесь',
  });

  setTimeout(() => process.exit(7), 50);
}
