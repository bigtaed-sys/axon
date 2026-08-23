/**
 * @axon/core — headless-рантайм Axon.
 *
 * Ничего из Electron, ничего из браузера: пакет должен одинаково запускаться
 * внутри десктопа, отдельным демоном на сервере и в тестах.
 */

export { defaultDataDir, resolveConfig } from './config.js';
export type { CoreConfig } from './config.js';
export { logger } from './logger.js';
export type { Logger } from './logger.js';

export { openDatabase } from './storage/db.js';
export type { Db, OpenDatabaseOptions } from './storage/db.js';
export { migrations } from './storage/migrations.js';
export type { Migration } from './storage/migrations.js';
export { Journal } from './storage/Journal.js';
export type { JournalListener } from './storage/Journal.js';
export { SearchIndex, INDEXED_UP_TO_SETTING } from './storage/SearchIndex.js';
export type { SearchHit } from './storage/SearchIndex.js';
export { SecretStore } from './storage/SecretStore.js';
export { Store } from './storage/Store.js';
export { createBackup, restoreBackup } from './storage/Backup.js';
export type { BackupOptions, BackupResult, RestoreResult } from './storage/Backup.js';
export { BlobStore } from './storage/BlobStore.js';
export type { BlobMeta } from './storage/BlobStore.js';
export { createRuntime } from './Runtime.js';
export type { Runtime, RuntimeOptions } from './Runtime.js';
export type { StoreOptions } from './storage/Store.js';
export * from './storage/repos.js';

export * from './providers/index.js';
export * from './tools/index.js';
export * from './agent/index.js';
export { selectFacts } from './memory/Facts.js';
export {
  effectiveWeight,
  evictionCandidates,
  OBSERVATION_CAPACITY,
  reinforcedWeight,
  selectForPrompt,
} from './memory/Observations.js';
export * from './plugins/index.js';
export { Scheduler, RoutineError } from './routines/Scheduler.js';
export type { SchedulerDeps } from './routines/Scheduler.js';
export { Executor, fill, evaluate } from './routines/Executor.js';
export type { ExecutorDeps, RunOutcome } from './routines/Executor.js';
export { Compiler, CompileError } from './routines/Compiler.js';
export type { CompilerDeps, CompiledRoutine } from './routines/Compiler.js';
export { nextRun, describeSchedule } from './routines/schedule.js';
export { SkillRegistry, DISABLED_SKILLS_SETTING, readSkillsFromDir } from './skills/SkillRegistry.js';
export type { Skill } from './skills/SkillRegistry.js';
export { McpClient, McpError } from './mcp/McpClient.js';
export { McpConnection } from './mcp/McpConnection.js';
