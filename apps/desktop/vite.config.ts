import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// @ts-expect-error — сборочный скрипт без объявлений типов, он общий для всех пакетов.
import { resolveVersion, buildStamp } from '../../scripts/version.mjs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  // Версия приложения — из git-тега, а не строкой в разметке и не из
  // package.json: и то и другое правят руками, а значит однажды забудут, и
  // отчёты об ошибках начнут приходить с неверным номером. Тег забыть нельзя.
  define: {
    __APP_VERSION__: JSON.stringify(resolveVersion(version)),
    __APP_BUILT_AT__: JSON.stringify(buildStamp()),
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
