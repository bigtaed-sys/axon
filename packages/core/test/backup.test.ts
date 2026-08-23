import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackup, createRuntime, resolveConfig, restoreBackup, type Runtime } from '../src/index.js';

let runtime: Runtime;
let dataDir: string;
let workDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-backup-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-work-'));
  runtime = createRuntime({ config: { dataDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('резервная копия', () => {
  it('переживает всё, что накопил агент', async () => {
    const chat = runtime.store.createConversation('Про докер');
    runtime.store.appendMessage({
      conversationId: chat.id,
      role: 'user',
      parts: [{ type: 'text', text: 'не поднимается контейнер' }],
    });
    runtime.store.upsertFact('город', 'Варшава');
    runtime.store.notice('работает по ночам', 'habit');

    const archive = path.join(workDir, 'копия.axon-backup');
    await createBackup(runtime.config, archive);

    // Разворачиваем в чистое место — так же, как на новой машине.
    const restoredDir = path.join(workDir, 'restored');
    await restoreBackup(archive, restoredDir);

    const restored = createRuntime({ config: { dataDir: restoredDir } });
    try {
      expect(restored.store.conversations.list(10)[0]?.title).toBe('Про докер');
      expect(restored.store.facts.byKey('город')?.value).toBe('Варшава');
      expect(restored.store.observations.list()[0]?.text).toBe('работает по ночам');

      const messages = restored.store.messages.recent(chat.id, 10);
      expect(messages[0]?.parts[0]).toMatchObject({ text: 'не поднимается контейнер' });
    } finally {
      await restored.close();
    }
  });

  it('снимается с работающего ядра', async () => {
    // Простое копирование файла SQLite под живым процессом даёт битую копию:
    // часть данных в WAL, часть в основном файле. VACUUM INTO снимает
    // согласованный снимок, не мешая тем, кто в это время пишет.
    const chat = runtime.store.createConversation('Живой');
    runtime.store.appendMessage({
      conversationId: chat.id,
      role: 'user',
      parts: [{ type: 'text', text: 'пишем прямо сейчас' }],
    });

    const archive = path.join(workDir, 'живая.axon-backup');
    const result = await createBackup(runtime.config, archive);

    expect(result.files).toBeGreaterThan(0);
    expect(fs.existsSync(archive)).toBe(true);
    // Ядро продолжает работать после снятия копии.
    expect(() => runtime.store.createConversation('после копии')).not.toThrow();
  });

  it('по умолчанию не кладёт ключ шифрования', async () => {
    // Копию кладут туда, где безопасность ниже: в облако, на флешку. С ключом
    // она становится полноценной кражей API-ключей и сессии телеграма.
    const archive = path.join(workDir, 'без-ключа.axon-backup');
    const result = await createBackup(runtime.config, archive);

    expect(result.withSecretKey).toBe(false);

    const restoredDir = path.join(workDir, 'r1');
    const restored = await restoreBackup(archive, restoredDir);

    expect(restored.withSecretKey).toBe(false);
    expect(fs.existsSync(path.join(restoredDir, 'secret.key'))).toBe(false);
  });

  it('кладёт ключ, когда попросили явно', async () => {
    // Файл ключа заводится лениво — с первым записанным секретом.
    runtime.store.updateSettings({ secrets: { 'проба.ключ': 'значение' } });

    const archive = path.join(workDir, 'с-ключом.axon-backup');
    const result = await createBackup(runtime.config, archive, { includeSecretKey: true });

    expect(result.withSecretKey).toBe(true);

    const restoredDir = path.join(workDir, 'r2');
    expect((await restoreBackup(archive, restoredDir)).withSecretKey).toBe(true);
    expect(fs.existsSync(path.join(restoredDir, 'secret.key'))).toBe(true);
  });

  it('не разворачивает чужой архив', async () => {
    const notOurs = path.join(workDir, 'чужой.tar.gz');
    fs.writeFileSync(notOurs, require('node:zlib').gzipSync(Buffer.alloc(1024)));

    await expect(restoreBackup(notOurs, path.join(workDir, 'r3'))).rejects.toThrow();
  });

  it('журналы прежней базы не переживают восстановление', async () => {
    // Оставшийся WAL от старой базы SQLite попытается применить к новой —
    // и либо откажется её открывать, либо испортит.
    const archive = path.join(workDir, 'копия.axon-backup');
    await createBackup(runtime.config, archive);

    const restoredDir = path.join(workDir, 'r4');
    fs.mkdirSync(restoredDir, { recursive: true });
    fs.writeFileSync(path.join(restoredDir, 'axon.db-wal'), 'мусор от прежней базы');

    await restoreBackup(archive, restoredDir);
    expect(fs.existsSync(path.join(restoredDir, 'axon.db-wal'))).toBe(false);
  });

  it('конфиг разворачивания не зависит от места', () => {
    // Копия должна разворачиваться на другой машине с другим путём.
    const config = resolveConfig({ dataDir: '/куда/угодно' });
    expect(config.databasePath).toContain('axon.db');
  });
});
