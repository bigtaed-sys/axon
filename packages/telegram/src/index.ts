/**
 * @axon/telegram — телеграм как ещё одно окно к ядру.
 *
 * Пакет без зависимостей: Bot API — это восемь HTTP-вызовов, и `fetch` из
 * Node справляется с ними лучше, чем библиотека со своим каркасом приложения.
 */

export { TelegramAdapter, BOT_TOKEN_SECRET } from './TelegramAdapter.js';
export type { TelegramDeps } from './TelegramAdapter.js';
export { BotApi, TelegramError } from './BotApi.js';
export type { Update, TelegramMessage, TelegramUser } from './BotApi.js';
export { toTelegramHtml, split } from './format.js';
export {
  Userbot,
  parseCommand,
  SESSION_SECRET,
  API_ID_SETTING,
  API_HASH_SECRET,
  TRIGGER_SETTING,
} from './Userbot.js';
export type { UserbotDeps, Command } from './Userbot.js';
export { UserbotAuth } from './UserbotAuth.js';
export type { AuthStep } from './UserbotAuth.js';
