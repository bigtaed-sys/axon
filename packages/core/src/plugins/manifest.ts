import fs from 'node:fs';
import path from 'node:path';
import { zPluginManifest, type PluginManifest } from '@axon/protocol';
import { PLUGIN_API_VERSION } from './host.js';

export const MANIFEST_FILE = 'axon.plugin.json';

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

/**
 * Прочитать и проверить манифест.
 *
 * Проверяется всё сразу и с внятными сообщениями, потому что читать это будет
 * автор плагина в момент, когда у него ничего не работает. «Invalid manifest» —
 * бесполезный ответ; «нет файла index.js, указанного в main» — ответ, после
 * которого понятно, что делать.
 */
export function readManifest(dir: string): PluginManifest {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) {
    throw new ManifestError(`В ${dir} нет ${MANIFEST_FILE} — это не плагин Axon`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ManifestError(
      `${MANIFEST_FILE} не разбирается как JSON: ${(error as Error).message}`,
    );
  }

  const parsed = zPluginManifest.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(корень)'} — ${issue.message}`)
      .join('; ');
    throw new ManifestError(`${MANIFEST_FILE} заполнен неверно: ${issues}`);
  }
  const manifest = parsed.data;

  if (manifest.api > PLUGIN_API_VERSION) {
    throw new ManifestError(
      `Плагин рассчитан на API версии ${manifest.api}, а это ядро умеет ${PLUGIN_API_VERSION}. ` +
        'Обнови Axon.',
    );
  }

  if (manifest.main && !fs.existsSync(path.resolve(dir, manifest.main))) {
    throw new ManifestError(`Нет файла ${manifest.main}, указанного в main`);
  }

  if (manifest.skills && !fs.existsSync(path.resolve(dir, manifest.skills))) {
    throw new ManifestError(`Нет папки ${manifest.skills}, указанной в skills`);
  }

  // Плагин, который ничего не делает, — почти всегда следствие опечатки, а не
  // замысла. Лучше сказать об этом при установке, чем оставить человека
  // гадать, почему в списке инструментов пусто.
  const empty =
    !manifest.main &&
    Object.keys(manifest.mcpServers).length === 0 &&
    !manifest.skills;
  if (empty) {
    throw new ManifestError(
      'Плагин ничего не приносит: нет ни main, ни mcpServers, ни skills',
    );
  }

  return manifest;
}

/** Есть ли в папке плагин — без выбрасывания исключений. */
export function looksLikePlugin(dir: string): boolean {
  return fs.existsSync(path.join(dir, MANIFEST_FILE));
}
