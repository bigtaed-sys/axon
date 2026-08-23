/**
 * Интерфейс Axon — общий для всех приложений.
 *
 * Здесь всё, что рисует и вводит; ничего про то, где оно запущено. Разницу
 * между Electron и телефоном держит `Host`, который приложение задаёт при
 * запуске, — см. `host.ts`.
 */
export { App } from './App.js';
export { setHost, host } from './host.js';
export type { Host, LocalCoreHost, Connection, CoreProbe, AutostartState } from './host.js';
export { useTheme, THEMES } from './theme.js';
export type { ThemeId } from './theme.js';
