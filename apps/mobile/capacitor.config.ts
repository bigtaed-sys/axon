import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Оболочка приложения.
 *
 * `androidScheme: 'https'` — страница живёт на защищённом источнике, иначе
 * браузерное окружение отбирает у неё часть возможностей. Отсюда и
 * `allowMixedContent`: ядро отвечает по обычному http (TLS у него нет
 * намеренно — это работа туннеля или обратного прокси), а страница на https
 * без явного разрешения к такому адресу не пойдёт.
 */
const config: CapacitorConfig = {
  appId: 'dev.axon.mobile',
  appName: 'Axon',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
