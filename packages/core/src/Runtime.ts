import fs from 'node:fs';
import { readPersona } from '@axon/protocol';
import { ContextBuilder } from './agent/ContextBuilder.js';
import { Orchestrator, type RunSink } from './agent/Orchestrator.js';
import { StoredPermissions, type PermissionBroker } from './agent/permissions.js';
import { Summarizer } from './agent/Summarizer.js';
import { Impulse } from './agent/Impulse.js';
import { Vision } from './agent/Vision.js';
import { resolveConfig, type CoreConfig } from './config.js';
import { logger } from './logger.js';
import type { Routine, RoutineRun } from '@axon/protocol';
import { PluginHost } from './plugins/PluginHost.js';
import { Compiler } from './routines/Compiler.js';
import { Executor } from './routines/Executor.js';
import { Scheduler } from './routines/Scheduler.js';
import { ProviderRegistry } from './providers/ProviderRegistry.js';
import { DISABLED_SKILLS_SETTING, SkillRegistry } from './skills/SkillRegistry.js';
import { BlobStore } from './storage/BlobStore.js';
import { openDatabase, type Db } from './storage/db.js';
import { Store } from './storage/Store.js';
import { ToolExecutor } from './tools/ToolExecutor.js';
import { DISABLED_TOOLS_SETTING, ToolRegistry } from './tools/ToolRegistry.js';
import { createBuiltinTools } from './tools/builtin/index.js';

export interface RuntimeOptions {
  config?: Partial<CoreConfig>;
  /** Куда уходит эфемерика. По умолчанию — в никуда (ядро без клиентов). */
  sink?: RunSink;
  /** Кто отвечает на запросы разрешений. По умолчанию — отказ. */
  permissions?: PermissionBroker;
  /** Рабочее состояние плагина изменилось — уходит клиентам сигналом. */
  onPluginStatus?: PluginHostOptions['onStatus'];
  /** Рутина отработала — повод показать уведомление. */
  onRoutineFinished?: (routine: Routine, run: RoutineRun) => void;
}

type PluginHostOptions = ConstructorParameters<typeof PluginHost>[0];

/**
 * Собранное ядро.
 *
 * Сборка живёт здесь, а не в демоне, потому что режимов запуска два —
 * отдельным сервисом и встроенным в десктоп — и оба должны получать
 * одинаково собранное ядро. Разъезд этих двух сборок означал бы, что баг
 * воспроизводится только у половины пользователей.
 */
export interface Runtime {
  config: CoreConfig;
  db: Db;
  store: Store;
  blobs: BlobStore;
  providers: ProviderRegistry;
  tools: ToolRegistry;
  skills: SkillRegistry;
  plugins: PluginHost;
  executor: ToolExecutor;
  context: ContextBuilder;
  summarizer: Summarizer;
  orchestrator: Orchestrator;
  scheduler: Scheduler;
  impulse: Impulse;
  coreId: string;
  /** Поднять плагины. Отдельно от сборки: это долго и может не получиться. */
  startPlugins(): Promise<void>;
  close(): Promise<void>;
}

const NOOP_SINK: RunSink = { emit: () => {} };

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const config = resolveConfig(options.config);
  fs.mkdirSync(config.blobDir, { recursive: true });

  const db = openDatabase({ databasePath: config.databasePath });
  const store = new Store({ db, secretKeyPath: config.secretKeyPath });
  const blobs = new BlobStore(db, config.blobDir);

  const providers = new ProviderRegistry(store.settings, store.secrets);
  const tools = new ToolRegistry(store.settings.get<string[]>(DISABLED_TOOLS_SETTING) ?? []);
  const skills = new SkillRegistry(store.settings.get<string[]>(DISABLED_SKILLS_SETTING) ?? []);
  tools.registerAll(createBuiltinTools(store, skills));

  const executor = new ToolExecutor(tools, new StoredPermissions(store));
  const context = new ContextBuilder(store, { blobs });

  // Оглавление скиллов — стабильный вклад: его состав меняется только при
  // установке плагина, а не от хода к ходу, и потому ему место в кэшируемом
  // префиксе промпта.
  context.addContributor({
    name: 'скиллы',
    stability: 'stable',
    contribute: () => skills.catalogText(),
  });

  /**
   * Задание познакомиться — пока знакомство не состоялось.
   *
   * Это вклад в промпт, а не отдельный режим и не сценарий с вопросами по
   * списку. Скриптованный диалог — тот же визард, только в чате: его нельзя
   * ни пропустить, ни переиграть, а восемь вопросов подряд превращают
   * знакомство в анкету, набранную в мессенджере.
   *
   * Вклад стабильный: он меняется ровно один раз за всю жизнь ядра — в тот
   * момент, когда агент записал первое поле личности. Одно обнуление кэша на
   * установку.
   */
  context.addContributor({
    name: 'знакомство',
    stability: 'stable',
    contribute: () => {
      if (readPersona(store.settings.all()).configured) return null;

      return (
        'Вы ещё не знакомы — это ваш первый разговор.\n\n' +
        'Со временем тебе нужно узнать три вещи: как тебя называть, как ' +
        'обращаться к человеку и как ему удобнее с тобой общаться — короче или ' +
        'подробнее, с шутками или без, на «ты» или на «вы».\n\n' +
        'Спрашивай спокойно и по одному вопросу за раз. Не торопи и не торопись ' +
        'сам: на это есть весь разговор и все следующие, выяснять всё сразу ' +
        'некуда. Не объявляй, что сейчас будешь знакомиться, и не предлагай ' +
        '«быстро сориентироваться» — это не анкета, которую надо поскорее ' +
        'закрыть. Дождись ответа на заданный вопрос, прежде чем задавать ' +
        'следующий.\n\n' +
        'Если человек пришёл с делом — сначала сделай дело, знакомься попутно. ' +
        'Если он отмахнулся — не возвращайся к этому.\n\n' +
        'Всё, что узнал, сразу записывай инструментом set_persona: без этого ' +
        'оно забудется вместе с этим разговором.'
      );
    },
  });

  const plugins = new PluginHost({
    store,
    tools,
    context,
    providers,
    skills,
    blobs,
    dataDir: config.dataDir,
    ...(options.onPluginStatus ? { onStatus: options.onPluginStatus } : {}),
  });

  // Плагины с правом `journal` слушают то же, что и клиенты: один источник
  // событий, а не отдельная шина «для плагинов», которая рано или поздно
  // начнёт отставать от настоящей.
  store.journal.subscribe((entry) => plugins.deliver([entry]));

  /**
   * Где идёт разговор.
   *
   * Изменчивый вклад, и это принципиально: разговор один, а окон несколько, и
   * человек переходит между ними посреди дела. Положи это в системный блок —
   * и кэш промпта будет обнуляться на каждом переходе с телефона на десктоп.
   *
   * Нужно ровно затем, чтобы ответ подходил месту. Без этого агент рисует
   * таблицу, которую телеграм не покажет, отвечает на три экрана, которые
   * там режутся на пять сообщений, и советует «посмотреть разбор контекста в
   * заголовке чата» человеку, у которого никакого заголовка нет.
   */
  context.addContributor({
    name: 'канал',
    stability: 'volatile',
    contribute: (input) => {
      if (input.platform !== 'telegram') return null;

      return (
        'Этот вопрос задан из телеграма, а не из приложения.\n' +
        '- Отвечай короче обычного: читают с телефона.\n' +
        '- Не рисуй таблицы и широкие блоки кода — они там не помещаются и ' +
        'превращаются в кашу. Перечисление строками читается лучше.\n' +
        '- Не отсылай к тому, чего в телеграме нет: экранам настроек, ' +
        'разбору контекста, спискам чатов.'
      );
    },
  });

  // Текущее время обязано быть изменчивым вкладом. Положи его в системный
  // блок — и кэш промпта будет обнуляться на каждом ходу, потому что префикс
  // меняется каждую минуту. Это ровно тот случай, ради которого у вкладов
  // вообще есть разделение на стабильные и изменчивые.
  context.addContributor({
    name: 'время',
    stability: 'volatile',
    contribute: () => {
      const now = new Date();
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return `Сейчас ${now.toLocaleString('ru-RU')} (${zone}).`;
    },
  });
  const summarizer = new Summarizer(store, providers);

  const orchestrator = new Orchestrator({
    store,
    context,
    providers,
    tools,
    executor,
    summarizer,
    blobs,
    vision: new Vision({ providers, blobs }),
    sink: options.sink ?? NOOP_SINK,
    ...(options.permissions ? { permissions: options.permissions } : {}),
  });

  // Индекс поиска — производная величина: догоняем его при каждом старте.
  // Когда догонять нечего, это один запрос, который ничего не находит.
  const indexed = store.search.catchUp();
  if (indexed > 0) logger.info({ indexed }, 'индекс поиска дополнен');

  const scheduler = new Scheduler({
    store,
    executor: new Executor({
      store,
      orchestrator,
      providers,
      tools,
      toolExecutor: executor,
      blobs,
    }),
    compiler: new Compiler({ providers, tools }),
    ...(options.onRoutineFinished ? { onFinished: options.onRoutineFinished } : {}),
  });

  /**
   * Инициатива поднимается всегда, но по умолчанию выключена настройкой.
   * Проверять флаг здесь, при сборке, было бы ошибкой: человек включит её в
   * настройках, а работать она начнёт со следующего запуска ядра.
   */
  const impulse = new Impulse({ store, context, providers });

  const coreId = store.coreId();
  logger.info({ coreId, dataDir: config.dataDir }, 'ядро собрано');

  return {
    config,
    db,
    store,
    blobs,
    providers,
    tools,
    skills,
    plugins,
    executor,
    context,
    summarizer,
    orchestrator,
    scheduler,
    impulse,
    coreId,
    startPlugins: async () => {
      await plugins.startAll();
      // Планировщик поднимаем после плагинов: рутина может опираться на
      // инструмент, который принёс плагин, и запускать её раньше — значит
      // получить «инструмент не найден» на первом же прогоне после старта.
      scheduler.start();
      impulse.start();
    },
    close: async () => {
      scheduler.stop();
      impulse.stop();
      // Сначала гасим чужие процессы, потом закрываем базу: плагин, которому
      // разрешили писать факты, не должен наткнуться на закрытое соединение.
      await plugins.stopAll();
      db.close();
    },
  };
}
