import os from 'node:os';
import path from 'node:path';

/**
 * Куда ядро кладёт свои данные. Одна папка на всё: БД, блобы, ключ шифрования,
 * логи. Переносится копированием, бэкапится целиком, удаляется одним rm.
 */
export function defaultDataDir(): string {
  const env = process.env['AXON_DATA_DIR'];
  if (env) return path.resolve(env);

  const home = os.homedir();
  switch (process.platform) {
    case 'win32': {
      const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'Axon');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Axon');
    default: {
      const xdg = process.env['XDG_DATA_HOME'];
      return xdg ? path.join(xdg, 'axon') : path.join(home, '.local', 'share', 'axon');
    }
  }
}

export interface CoreConfig {
  /** Корневая папка данных. */
  dataDir: string;
  /** Путь к файлу БД. По умолчанию `<dataDir>/axon.db`. Для тестов — `:memory:`. */
  databasePath: string;
  /** Куда складывать блобы. По умолчанию `<dataDir>/blobs`. */
  blobDir: string;
  /** Файл с ключом шифрования секретов. По умолчанию `<dataDir>/secret.key`. */
  secretKeyPath: string;
}

export function resolveConfig(partial: Partial<CoreConfig> = {}): CoreConfig {
  const dataDir = partial.dataDir ?? defaultDataDir();
  return {
    dataDir,
    databasePath: partial.databasePath ?? path.join(dataDir, 'axon.db'),
    blobDir: partial.blobDir ?? path.join(dataDir, 'blobs'),
    secretKeyPath: partial.secretKeyPath ?? path.join(dataDir, 'secret.key'),
  };
}
