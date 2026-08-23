import os from 'node:os';
import type { SkillRegistry } from '../../skills/SkillRegistry.js';
import type { Store } from '../../storage/Store.js';
import type { EmbeddingIndex } from '../../memory/EmbeddingIndex.js';
import type { ToolDefinition } from '../types.js';
import { createFileTools } from './files.js';
import { createHttpTools } from './http.js';
import { createMemoryTools } from './memory.js';
import { createPersonaTools } from './persona.js';
import { createRecallTools } from './recall.js';
import { createShellTools } from './shell.js';
import { createSkillTools } from './skills.js';
import { createSystemTools } from './system.js';
import { PathGuard } from './paths.js';

export { createSkillTools } from './skills.js';
export { createMemoryTools } from './memory.js';
export { createPersonaTools } from './persona.js';
export { createRecallTools } from './recall.js';
export { createFileTools } from './files.js';
export { createShellTools } from './shell.js';
export { createHttpTools } from './http.js';
export { createSystemTools } from './system.js';
export { PathGuard, SKIP_DIRS } from './paths.js';

/** Ключ настройки со списком папок, к которым агенту разрешён доступ. */
export const FILE_ROOTS_SETTING = 'tools.files.roots';

/**
 * Встроенный набор инструментов.
 *
 * Разрешённые папки берутся из настроек и по умолчанию сводятся к домашней:
 * агент, которому можно всё от корня диска, опасен не потому, что злой, а
 * потому, что одна инъекция в прочитанном тексте уводит его куда угодно.
 * Сузить список — дело одной настройки, расширить до корня — осознанное
 * решение пользователя.
 */
export function createBuiltinTools(
  store: Store,
  skills: SkillRegistry,
  embeddings?: EmbeddingIndex,
): ToolDefinition[] {
  const roots = store.settings.get<string[]>(FILE_ROOTS_SETTING) ?? [os.homedir()];
  const guard = new PathGuard(roots);

  return [
    ...createMemoryTools(store),
    ...createPersonaTools(store),
    ...createRecallTools(store, embeddings),
    ...createSkillTools(skills),
    ...createFileTools(guard),
    ...createShellTools(guard),
    ...createHttpTools(),
    ...createSystemTools(),
  ];
}
