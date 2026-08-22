/**
 * Публичный контракт плагина.
 *
 * Определения живут в @axon-assistant/plugin-sdk, а не здесь, и это не
 * формальность: тот пакет автор плагина ставит себе, и если бы ядро держало
 * собственную копию тех же интерфейсов, они разошлись бы на первой же правке —
 * причём молча, потому что ни один компилятор не видит обе стороны сразу.
 * Здесь только реэкспорт.
 */
export type {
  Fact,
  PluginApi,
  PluginChatEvent,
  PluginContributeInput,
  PluginJournalEntry,
  PluginModelInfo,
  PluginModule,
  PluginProvider,
  PluginStability,
  PluginTool,
  PluginToolContext,
  RiskTier,
} from '@axon-assistant/plugin-sdk';
