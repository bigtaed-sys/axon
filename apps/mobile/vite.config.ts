import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error — сборочный скрипт без объявлений типов, он общий для всех пакетов.
import { resolveVersion, buildStamp } from '../../scripts/version.mjs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(resolveVersion(version)),
    __APP_BUILT_AT__: JSON.stringify(buildStamp()),
  },
  build: { outDir: 'dist', emptyOutDir: true },
  // Телефон в той же сети открывает страницу разработки по адресу машины —
  // иначе проверять приходится только в браузере на самом компьютере.
  server: { host: true, port: 5174, strictPort: true },
});
