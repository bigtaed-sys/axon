/** @type {import('tailwindcss').Config} */
import preset from '@axon/ui/tailwind';

export default {
  presets: [preset],
  // Классы ищутся и в общем интерфейсе: он живёт в отдельном пакете, а
  // Tailwind выбрасывает всё, чего не увидел в разметке.
  content: [
    './src/renderer/index.html',
    './src/renderer/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};
