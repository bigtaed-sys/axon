import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseMcpConfig } from '@axon/protocol';
import { createRuntime, type Runtime } from '../src/index.js';
import type { ToolContext } from '../src/tools/types.js';

/**
 * Тесты идут против настоящего рантайма и настоящих дочерних процессов:
 * подменять RPC здесь бессмысленно, потому что именно граница процессов и есть
 * то, что может сломаться.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

let runtime: Runtime;
let tmpDir: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    conversationId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    runId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302',
    signal: new AbortController().signal,
    logger: console,
    requestPermission: async () => true,
    ...overrides,
  } as ToolContext;
}

/**
 * Проверить, что плагин поднялся, показав причину, если нет.
 *
 * Без этого падение выглядит как «ожидали ready, получили failed» — то есть не
 * сообщает ничего, и на разбор уходит отдельный заход с отладкой.
 */
function expectReady(info: { status: string; error?: string }): void {
  expect(`${info.status} ${info.error ?? ''}`.trim()).toBe('ready');
}

/** То же для вызова инструмента: текст ошибки виден прямо в отчёте. */
function preview(result: { ok: boolean; preview?: string; error?: string }): string {
  return result.ok ? (result.preview ?? '') : `ОШИБКА: ${result.error}`;
}

async function until(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('условие не наступило');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-plugins-'));
  runtime = createRuntime({ config: { dataDir: tmpDir } });
});

afterEach(async () => {
  await runtime.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('плагин с кодом', () => {
  it('приносит инструменты, вклад в контекст и скиллы, и всё уходит при выключении', async () => {
    const info = await runtime.plugins.install({
      type: 'link',
      path: path.join(fixtures, 'echo-plugin'),
    });

    expectReady(info);
    // Имя с приставкой id плагина: два плагина с инструментом `say` не должны
    // затирать друг друга.
    expect(runtime.tools.get('echo_say')).not.toBeNull();
    expect(info.tools.map((t) => t.name)).toContain('echo_say');

    // Инструмент выполняется в чужом процессе, но снаружи это обычный вызов.
    const result = await runtime.executor.execute({
      name: 'echo_say',
      args: { text: 'привет' },
      ctx: ctx(),
      access: { scopes: ['tools.safe'] },
    });
    expect(preview(result)).toBe('эхо: привет');

    // Скилл из файла и скилл из кода — оба в оглавлении.
    const catalog = runtime.skills.catalogText();
    expect(catalog).toContain('Приветствие');
    expect(catalog).toContain('Динамический скилл');

    // Тело скилла достаётся отдельным вызовом, а не висит в промпте.
    const skill = await runtime.executor.execute({
      name: 'read_skill',
      args: { name: 'Приветствие' },
      ctx: ctx(),
      access: { scopes: ['tools.safe'] },
    });
    expect(preview(skill)).toContain('Здоровайся коротко');

    // Вклад в контекст доехал до системного блока.
    const conversation = runtime.store.createConversation('Тест');
    const built = await runtime.context.build({
      conversationId: conversation.id,
      userText: 'привет',
    });
    expect(JSON.stringify(built.messages)).toContain('Плагин эхо на связи');

    await runtime.plugins.setEnabled('echo', false);
    expect(runtime.tools.get('echo_say')).toBeNull();
    expect(runtime.skills.catalogText()).toBeNull();
  });

  it('запрос разрешения изнутри плагина доходит до пользователя', async () => {
    const info = await runtime.plugins.install({
      type: 'link',
      path: path.join(fixtures, 'echo-plugin'),
    });
    expectReady(info);

    const asked: string[] = [];
    const denied = await runtime.executor.execute({
      name: 'echo_risky',
      args: {},
      ctx: ctx({
        requestPermission: async (ask) => {
          asked.push(ask.reason);
          return false;
        },
      }),
      access: { scopes: ['tools.safe'] },
    });

    expect(asked).toContain('Хочу сделать что-то важное');
    expect(preview(denied)).toBe('отказали');
  });

  it('настройки едут в плагин и меняются на лету', async () => {
    const info = await runtime.plugins.install({
      type: 'link',
      path: path.join(fixtures, 'echo-plugin'),
    });
    expectReady(info);

    await runtime.plugins.configure('echo', { prefix: 'ответ' }, {});
    await until(() => runtime.plugins.list()[0]?.status === 'ready');

    const result = await runtime.executor.execute({
      name: 'echo_say',
      args: { text: 'раз' },
      ctx: ctx(),
      access: { scopes: ['tools.safe'] },
    });
    expect(preview(result)).toBe('ответ: раз');
  });

  it('секрет не уезжает в состояние, а только признак «задан»', async () => {
    await runtime.plugins.install({ type: 'link', path: path.join(fixtures, 'echo-plugin') });
    await runtime.plugins.configure('echo', {}, { token: 'очень-секретно' });

    const info = runtime.plugins.list().find((p) => p.id === 'echo')!;
    expect(info.settingValues['token']).toBe(true);
    expect(JSON.stringify(info)).not.toContain('очень-секретно');
  });
});

describe('падение плагина', () => {
  it('не роняет ядро и убирает за собой инструменты', async () => {
    const info = await runtime.plugins.install({
      type: 'link',
      path: path.join(fixtures, 'crasher-plugin'),
    });
    expectReady(info);
    expect(runtime.tools.get('crasher_boom')).not.toBeNull();

    // Процесс убивает себя через 50 мс после активации.
    await until(() => runtime.plugins.list().find((p) => p.id === 'crasher')?.status === 'failed');

    // Главное: инструмента больше нет. Иначе модель вызвала бы его и упёрлась
    // в мёртвый процесс посреди прогона.
    expect(runtime.tools.get('crasher_boom')).toBeNull();
    // Ядро при этом живо и остальными инструментами пользоваться можно.
    expect(runtime.tools.get('remember')).not.toBeNull();
  });
});

describe('установка', () => {
  it('плагин переживает перезапуск ядра', async () => {
    await runtime.plugins.install({ type: 'link', path: path.join(fixtures, 'echo-plugin') });
    await runtime.plugins.configure('echo', { prefix: 'после' }, {});
    await runtime.close();

    runtime = createRuntime({ config: { dataDir: tmpDir } });
    await runtime.startPlugins();

    const info = runtime.plugins.list().find((p) => p.id === 'echo');
    expectReady(info!);
    expect(info?.settingValues['prefix']).toBe('после');
    expect(runtime.tools.get('echo_say')).not.toBeNull();
  });

  it('удаление уносит настройки и папку данных, но не исходники разработчика', async () => {
    const source = path.join(fixtures, 'echo-plugin');
    await runtime.plugins.install({ type: 'link', path: source });
    await runtime.plugins.configure('echo', { prefix: 'что-то' }, {});

    await runtime.plugins.remove('echo');

    expect(runtime.plugins.list()).toHaveLength(0);
    expect(runtime.tools.get('echo_say')).toBeNull();
    expect(runtime.store.settings.get('plugin.echo.prefix')).toBeUndefined();
    // Подключённая папка — это чужие исходники, её трогать нельзя.
    expect(fs.existsSync(path.join(source, 'index.js'))).toBe(true);
  });

  it('дважды один и тот же плагин не ставится', async () => {
    const source = { type: 'link' as const, path: path.join(fixtures, 'echo-plugin') };
    await runtime.plugins.install(source);
    await expect(runtime.plugins.install(source)).rejects.toThrow(/уже установлен/);
  });

  it('манифест с ошибкой отклоняется с внятным текстом', async () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'axon-broken-'));
    fs.writeFileSync(
      path.join(broken, 'axon.plugin.json'),
      JSON.stringify({ id: 'Плохой ID', name: 'Плохой', main: './нет.js' }),
    );

    await expect(runtime.plugins.install({ type: 'link', path: broken })).rejects.toThrow(
      /заполнен неверно/,
    );
    fs.rmSync(broken, { recursive: true, force: true });
  });

  it('адрес репозитория, который git принял бы за команду, отклоняется', async () => {
    await expect(runtime.plugins.install({ type: 'git', url: 'ext::sh -c whoami' })).rejects.toThrow(
      /ext::/,
    );
    await expect(
      runtime.plugins.install({ type: 'git', url: '--upload-pack=touch /tmp/pwned' }),
    ).rejects.toThrow(/не может начинаться/);
  });
});

/**
 * Обёртка вокруг MCP.
 *
 * Команда сервера здесь — мгновенно завершающийся `node -e 0`, а не настоящий
 * пакет через `npx`. Проверяется установка: манифест, права, отсутствие кода.
 * Тянуть чужой сервер из реестра ради этого значит поставить сеть между тестом
 * и его смыслом — а в CI ещё и получить то падающий, то проходящий прогон.
 */
describe('свой MCP-сервер', () => {
  it('конфигурация из README сервера разбирается во всех ходовых формах', () => {
    // Так пишут в README под Claude Desktop.
    expect(
      parseMcpConfig('{"mcpServers":{"github":{"command":"node","args":["-e","0"]}}}'),
    ).toEqual([
      {
        name: 'github',
        transport: { type: 'stdio', command: 'node', args: ['-e', '0'], env: {} },
      },
    ]);

    // Так — под VS Code.
    expect(parseMcpConfig('{"servers":{"docs":{"url":"https://mcp.example.com/mcp"}}}')).toEqual([
      { name: 'docs', transport: { type: 'http', url: 'https://mcp.example.com/mcp', headers: {} } },
    ]);

    // А так человек скопировал только внутренность, без обёртки и без имени.
    const bare = parseMcpConfig(
      '{"command":"npx","args":["-y","@modelcontextprotocol/server-memory"]}',
    );
    expect(bare[0]!.name).toBe('server-memory');

    // Мусор должен объяснять, что не так, а не падать типом.
    expect(() => parseMcpConfig('не json')).toThrow(/не JSON/i);
    expect(() => parseMcpConfig('{"srv":{"нет":"ничего"}}')).toThrow(/command/);
  });

  it('ставится плагином-обёрткой без всякого кода', async () => {
    const [server] = parseMcpConfig(
      '{"mcpServers":{"my-server":{"command":"node","args":["-e","0"],"env":{"TOKEN":"t"}}}}',
    );

    const info = await runtime.plugins.install({
      type: 'mcp',
      name: server!.name,
      transport: server!.transport,
    });

    expect(info.id).toBe('my-server');
    expect(info.mcpServers.map((s) => s.name)).toEqual(['my-server']);
    // Права заявляем честно: stdio — это чужой процесс на машине ядра.
    expect(info.permissions).toEqual(['shell', 'net']);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'plugins', 'my-server', 'axon.plugin.json'), 'utf8'),
    ) as { main?: string; mcpServers: Record<string, { command: string }> };
    expect(manifest.main).toBeUndefined();
    expect(manifest.mcpServers['my-server']!.command).toBe('node');
  });
});

describe('провайдеры', () => {
  it('описание приходит из ядра, а не зашито в клиенте', async () => {
    const providers = await runtime.providers.describe();

    const anthropic = providers.find((p) => p.id === 'anthropic')!;
    expect(anthropic.source).toBe('builtin');
    expect(anthropic.requiresKey).toBe(true);
    // Ключа нет — значит провайдер не готов, и интерфейс это покажет.
    expect(anthropic.configured).toBe(false);

    // Локальные модели работают без ключа.
    expect(providers.find((p) => p.id === 'ollama')?.configured).toBe(true);
  });

  it('провайдер от плагина попадает в тот же список', async () => {
    runtime.providers.registerExternal(
      {
        id: 'weather:fast',
        title: 'Быстрая модель',
        requiresKey: false,
        secretKey: 'plugin.weather.apiKey',
        defaultModel: 'fast-1',
        supportsPromptCache: false,
      },
      {
        id: 'weather:fast',
        supportsPromptCache: false,
        chat: () => ({ async *[Symbol.asyncIterator]() {} }),
        listModels: async () => [{ id: 'fast-1', name: 'Fast 1' }],
      },
    );

    const providers = await runtime.providers.describe();
    const external = providers.find((p) => p.id === 'weather:fast');

    expect(external?.source).toBe('plugin:weather');
    // Ключами провайдера плагина распоряжается сам плагин — ядро считает его
    // готовым и не требует секрета, которого у него нет.
    expect(external?.configured).toBe(true);
    expect(external?.models.map((m) => m.id)).toEqual(['fast-1']);
  });
});

describe('обновление плагина', () => {
  it('обёртку вокруг MCP обновлять нечем — и это сказано словами', async () => {
    await runtime.plugins.install({
      type: 'mcp',
      name: 'wrapped',
      transport: { type: 'http', url: 'https://example.com/mcp', headers: {} },
    });

    await expect(runtime.plugins.update('wrapped')).rejects.toThrow(/из репозитория/);
  });

  it('связанная папка обновляется перечитыванием с диска', async () => {
    await runtime.plugins.install({ type: 'link', path: path.join(fixtures, 'echo-plugin') });
    const updated = await runtime.plugins.update('echo');

    expectReady(updated);
    expect(runtime.tools.get('echo_say')).not.toBeNull();
  });
});

describe('каталог', () => {
  it('плагин из каталога собирается в обёртку вокруг MCP-сервера', async () => {
    // Сервер не поднимется — команда заведомо несуществующая, — но проверяется
    // здесь другое: что ядро само собрало плагин и записало настройки.
    const info = await runtime.plugins.install({
      type: 'catalog',
      id: 'github',
      values: { token: 'ghp_проверка' },
    });

    expect(info.id).toBe('github');
    expect(info.mcpServers.map((s) => s.name)).toEqual(['github']);
    expect(info.settingValues['token']).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'plugins', 'github', 'axon.plugin.json'))).toBe(true);
  });

  it('обязательное поле каталога нельзя пропустить', async () => {
    await expect(
      runtime.plugins.install({ type: 'catalog', id: 'github', values: {} }),
    ).rejects.toThrow(/Не заполнено/);
  });
});

describe('список инструментов у клиентов', () => {
  it('меняется сигналом, а не только в снапшоте', async () => {
    // Плагин поднимается через секунды после старта ядра. Пока об изменении
    // никто не сообщал, человек видел его инструменты лишь после перезапуска
    // приложения — снапшот берётся один раз, при подключении.
    const seen: number[] = [];
    const runtime = createRuntime({
      config: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'axon-toolsig-')) },
      sink: {
        emit: (signal) => {
          if (signal.type === 'tools.changed') seen.push(signal.tools.length);
        },
      },
    });

    try {
      const before = runtime.tools.list().length;
      seen.length = 0;

      runtime.tools.register({
        name: 'проба',
        title: 'Проба',
        description: 'Появилась на лету',
        tier: 'safe',
        source: 'plugin:проба',
        schema: z.object({}),
        execute: async () => ({ text: 'ок' }),
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(seen).toEqual([before + 1]);
      expect(seen[0]).toBe(runtime.tools.list().length);
    } finally {
      await runtime.close();
    }
  });

  it('десяток инструментов подряд — один сигнал, а не десять', async () => {
    const seen: number[] = [];
    const runtime = createRuntime({
      config: { dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'axon-toolsig2-')) },
      sink: {
        emit: (signal) => {
          if (signal.type === 'tools.changed') seen.push(signal.tools.length);
        },
      },
    });

    try {
      seen.length = 0;
      for (let i = 0; i < 10; i += 1) {
        runtime.tools.register({
          name: `проба${i}`,
          title: 'Проба',
          description: 'Одна из многих',
          tier: 'safe',
          source: 'plugin:проба',
          schema: z.object({}),
          execute: async () => ({ text: 'ок' }),
        });
      }

      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
});
