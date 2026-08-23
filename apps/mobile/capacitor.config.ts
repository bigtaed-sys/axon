import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Оболочка приложения.
 *
 * `androidScheme: 'http'` — страница живёт на обычном источнике, и это не
 * упрощение, а следствие. Ядру TLS не положен намеренно, значит приложение
 * разговаривает с ним по http; со страницы на https такие запросы — смешанное
 * содержимое, и WebView режет их даже с явным разрешением. Своими глазами:
 * запрос не уходит, ошибка пустая.
 *
 * Плата за это — незащищённый источник: браузер не даёт такой странице
 * `navigator.clipboard`. Кнопки «скопировать» работают запасным путём, см.
 * `copyText` в общем интерфейсе.
 */
const config: CapacitorConfig = {
  appId: 'dev.axon.mobile',
  appName: 'Axon',
  webDir: 'dist',
  android: {
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'http',
  },
};

export default config;
