import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  // Версия приложения — из package.json, а не строкой в разметке: зашитая
  // однажды разойдётся с настоящей, и отчёты об ошибках начнут приходить с
  // неверным номером.
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
