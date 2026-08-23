import { useCallback, useEffect, useState } from 'react';
import { host } from './host.js';

export type ThemeId = 'mono-dark' | 'mono-light' | 'indigo-dark' | 'indigo-light';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  icon: string;
}

export const THEMES: ThemeMeta[] = [
  { id: 'mono-dark', label: 'Моно · тёмная', icon: 'bi-circle-half' },
  { id: 'mono-light', label: 'Моно · светлая', icon: 'bi-sun' },
  { id: 'indigo-dark', label: 'Индиго · тёмная', icon: 'bi-moon-stars' },
  { id: 'indigo-light', label: 'Индиго · светлая', icon: 'bi-brightness-high' },
];

const STORAGE_KEY = 'axon.theme';

/**
 * Тема живёт атрибутом `data-theme` на <html>, а не классами: все цвета
 * заданы CSS-переменными, поэтому переключение — это одна смена атрибута,
 * без перерисовки разметки и без мигания.
 */
export function useTheme(): { theme: ThemeId; setTheme: (theme: ThemeId) => void } {
  const [theme, setThemeState] = useState<ThemeId>(
    () => (localStorage.getItem(STORAGE_KEY) as ThemeId | null) ?? 'mono-dark',
  );

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);

    // Кнопки окна рисует система, и их цвет живёт вне CSS. Забираем значения
    // из тех же переменных, что и шапка, и отдаём в main — иначе они остаются
    // от прошлой темы. Через кадр: переменные должны успеть примениться.
    requestAnimationFrame(() => {
      const style = getComputedStyle(document.documentElement);
      host().titlebar?.({
        color: toHex(style.getPropertyValue('--c-surface')),
        symbolColor: toHex(style.getPropertyValue('--c-text-muted')),
      });
    });
  }, [theme]);

  const setTheme = useCallback((next: ThemeId) => {
    localStorage.setItem(STORAGE_KEY, next);
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}

/** «20 20 24» → «#141418»: Electron ждёт именно hex, не CSS-цвет. */
function toHex(rgbTriplet: string): string {
  const parts = rgbTriplet.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return '#141418';
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
