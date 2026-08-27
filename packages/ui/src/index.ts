/**
 * Интерфейс Axon — общий для всех приложений.
 *
 * Здесь всё, что рисует и вводит; ничего про то, где оно запущено. Разницу
 * между Electron и телефоном держит `Host`, который приложение задаёт при
 * запуске, — см. `host.ts`.
 */
export { App } from './App.js';
export { useApp } from './useApp.js';
export type { AppState } from './useApp.js';
export { setHost, host } from './host.js';
export type { Host, LocalCoreHost, Connection, CoreProbe, AutostartState } from './host.js';
export { useTheme, THEMES } from './theme.js';
export type { ThemeId } from './theme.js';

/**
 * Части интерфейса — для оболочек, которые собирают из них свою раскладку.
 *
 * Десктоп берёт их через `App`, телефон складывает по-своему: три колонки на
 * экране шириной в ладонь не работают никак.
 */
export { ChatList } from './components/ChatList.js';
export { ChatHeader } from './components/ChatHeader.js';
export { MessageList } from './components/MessageList.js';
export { MessageInput } from './components/MessageInput.js';
export { ConnectScreen } from './components/ConnectScreen.js';
export { SetupWizard } from './components/SetupWizard.js';
export { SettingsPanel } from './components/SettingsPanel.js';
export { PluginsPanel } from './components/PluginsPanel.js';
export { RoutinesPanel } from './components/RoutinesPanel.js';
export { ContextReport } from './components/ContextReport.js';
export { PermissionModal } from './components/PermissionModal.js';
export type { UserDecision } from './components/PermissionModal.js';
export { DevicesPanel, Empty, MemoryPanel, ToolsPanel, UsagePanel } from './components/Panels.js';
export type { Screen } from './components/Sidebar.js';
export { useMotion } from './motion.js';
export { checkForUpdate, dailyChecks, dueForCheck, setDailyChecks } from './updates.js';
export type { Release } from './updates.js';
export type { MotionId } from './motion.js';
