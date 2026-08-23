/** @type {import('tailwindcss').Config} */
import preset from '@axon/ui/tailwind';

export default {
  presets: [preset],
  content: ['./index.html', './src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};
