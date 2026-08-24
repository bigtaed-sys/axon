import { useEffect, useMemo, useState } from 'react';
import { compareVersions, readPersona } from '@axon/protocol';
import type {
  Conversation,
  ContentPart,
  Device,
  Fact,
  Message,
  Observation,
  Persona,
  PermissionRequest,
  PluginInfo,
  Routine,
  ToolInfo,
} from '@axon/protocol';
import type { AxonClient, ConnectionStatus, RunStream } from '@axon/client-sdk';
import type { Screen } from './components/Sidebar.js';
import { useMotion, type MotionId } from './motion.js';
import { useTheme, type ThemeId } from './theme.js';
import { useAxon } from './useAxon.js';
import { host, type Connection } from './host.js';

/**
 * Вся обвязка приложения: подключение, состояние, действия.
 *
 * Раньше она жила внутри десктопного `App` вперемешку с его разметкой. У
 * телефона разметка своя — раскладка в три колонки на экране шириной в ладонь
 * не работает никак, — но выбор чата, отправка сообщения, разбор ошибок
 * прогона и уведомления у них общие до последней строчки. Разделение сделано
 * ровно по этому шву: здесь поведение, в оболочках — расположение.
 *
 * Хук намеренно возвращает много: это не «объект-бог», а честный перечень
 * того, из чего состоит одно приложение. Прятать половину за вторым хуком
 * значило бы делить по алфавиту, а не по смыслу.
 */
export interface AppState {
  client: AxonClient | null;
  status: ConnectionStatus;
  connection: Connection | null;
  /** Почему нет подключения. Отдельно от `banner`: экран подключения показывает именно её. */
  error: string | null;
  /** Растёт на любое изменение состояния — на нём держится перерисовка. */
  version: number;
  reconnect: () => void;
  restartCore: () => Promise<void>;

  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  motion: MotionId;
  setMotion: (motion: MotionId) => void;

  screen: Screen;
  setScreen: (screen: Screen) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  runId: string | null;
  showContext: boolean;
  setShowContext: (open: boolean) => void;
  showToolCalls: boolean;
  toggleToolCalls: () => void;
  setupDone: boolean;
  finishSetup: () => void;

  conversations: Conversation[];
  messages: Message[];
  stream: RunStream | null;
  permission: PermissionRequest | null;
  tools: ToolInfo[];
  facts: Fact[];
  observations: Observation[];
  devices: Device[];
  plugins: PluginInfo[];
  routines: Routine[];

  activeTitle: string;
  providerId: string;
  modelId: string;
  seesImages: boolean;
  persona: Persona;

  /** Ядро отстало от приложения и это чинится перезапуском. */
  coreStale: boolean;
  coreBehind: boolean;
  coreVersion: string;
  /** Что показать красной полосой: отказ подключения или отказ прогона. */
  banner: string | null;
  clearFailure: () => void;

  createChat: () => Promise<void>;
  send: (parts: ContentPart[]) => Promise<void>;
}

/** Заголовок чата до первого сообщения. */
const PLACEHOLDER_TITLE = 'Новый чат';


/**
 * Причины остановки, о которых пользователю нужно сказать. `end_turn` —
 * обычное завершение, `cancelled` — его собственное действие: молчим.
 */
const STOP_REASON = {
  budget_exhausted: 'Прогон остановлен: исчерпан бюджет токенов. Поднимите его в настройках.',
  max_iterations: 'Прогон остановлен: слишком много вызовов инструментов подряд.',
  permission_denied: 'Прогон остановлен: не выдано разрешение на инструмент.',
  refusal: 'Модель отказалась отвечать на этот запрос.',
  error: 'Прогон завершился ошибкой.',
} as const;

/** Про какие прогоны рутин уже сообщали — чтобы не звенеть на каждое событие. */
const notified = new Set<string>();

/**
 * Сказать, что рутина отработала.
 *
 * Смысл рутины в том, что человека рядом нет. Значит, единственный способ
 * узнать результат — уведомление системы, а не подпись в окне, которое, скорее
 * всего, свёрнуто. Событий `routine.changed` приходит много (включили,
 * переименовали, пересчитали расписание) — звеним только на завершённый прогон
 * и только один раз на прогон.
 */
function notifyFinished(routine: Routine): void {
  if (!routine.lastRunAt || !routine.lastStatus) return;
  // «Сообщать было не о чем» — не повод будить человека.
  if (routine.lastStatus === 'skipped') return;

  const key = `${routine.id}:${routine.lastRunAt}`;
  if (notified.has(key)) return;
  notified.add(key);

  notify(
    routine.name,
    routine.lastSummary ?? (routine.lastStatus === 'ok' ? 'Готово' : 'Не получилось'),
    routine.lastStatus === 'ok',
  );
}

function notify(title: string, body: string, silent = false): void {
  if (Notification.permission === 'default') void Notification.requestPermission();
  if (Notification.permission !== 'granted') return;
  new Notification(title, { body, silent });
}

/** Первая строка сообщения — достаточно хороший заголовок, и он бесплатный. */
function titleFrom(text: string): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || PLACEHOLDER_TITLE;
}


export function useApp(): AppState {
  const { client, status, error, connection, version, coreOutdated, reconnect, restartCore } =
    useAxon();
  const { theme, setTheme } = useTheme();
  const { motion, setMotion } = useMotion();

  const [screen, setScreen] = useState<Screen>('chat');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [showToolCalls, setShowToolCalls] = useState(
    () => localStorage.getItem('axon.showToolCalls') !== 'false',
  );
  const [setupDone, setSetupDone] = useState(
    () => localStorage.getItem('axon.setupDone') === 'true',
  );

  const finishSetup = (): void => {
    localStorage.setItem('axon.setupDone', 'true');
    setSetupDone(true);
    setScreen('chat');
  };

  const toggleToolCalls = (): void => {
    setShowToolCalls((visible) => {
      localStorage.setItem('axon.showToolCalls', String(!visible));
      return !visible;
    });
  };

  const state = client?.state ?? null;

  // Пересчитываем при каждом изменении состояния: version меняется на любое
  // журнальное событие и на любую дельту стрима.
  const conversations = useMemo(() => state?.conversationList() ?? [], [state, version]);
  const messages = useMemo(
    () => (state && activeId ? state.messagesOf(activeId) : []),
    [state, activeId, version],
  );
  const stream = useMemo(
    () => (state && runId ? (state.streams.get(runId) ?? null) : null),
    [state, runId, version],
  );
  const permission = useMemo(
    () => (state ? ([...state.permissions.values()][0] ?? null) : null),
    [state, version],
  );
  const tools = useMemo(() => [...(state?.tools.values() ?? [])], [state, version]);
  const facts = useMemo(() => [...(state?.facts.values() ?? [])], [state, version]);
  const observations = useMemo(
    () => [...(state?.observations.values() ?? [])].sort((a, b) => b.weight - a.weight),
    [state, version],
  );
  const devices = useMemo(() => [...(state?.devices.values() ?? [])], [state, version]);
  const plugins = useMemo(() => [...(state?.plugins.values() ?? [])], [state, version]);
  const routines = useMemo(() => [...(state?.routines.values() ?? [])], [state, version]);

  // Заголовок чата берём из состояния, поэтому переименование с другого
  // устройства доезжает само.
  const activeTitle = conversations.find((c) => c.id === activeId)?.title ?? 'Новый чат';

  // Один эффект на выбор активного чата: и первичный выбор, и случай, когда
  // текущий разговор уехал в архив или удалён с другого устройства. Без
  // второй половины `activeId` продолжал указывать на невидимый чат, и
  // сообщения уходили туда же — с виду в никуда.
  useEffect(() => {
    if (activeId && conversations.some((c) => c.id === activeId)) return;
    setActiveId(conversations[0]?.id ?? null);
  }, [conversations, activeId]);

  // История не приходит ни снапшотом, ни журналом — она грузится, когда
  // разговор открыли.
  useEffect(() => {
    if (!client || !activeId || status !== 'ready') return;
    void client.loadHistory(activeId).catch((e) => setFailure((e as Error).message));
  }, [client, activeId, status]);

  // Ошибка прогона обязана быть видимой: иначе ответ просто не появляется,
  // и понять, что случилось, неоткуда.
  useEffect(() => {
    if (!client) return;
    return client.onEvent((entry) => {
      const event = entry.event;
      if (event.type === 'run.failed') {
        setFailure(event.error);
      } else if (event.type === 'run.finished' && event.stopReason in STOP_REASON) {
        setFailure(STOP_REASON[event.stopReason as keyof typeof STOP_REASON]);
      } else if (event.type === 'impulse.sent') {
        // Агент написал сам. Уведомление здесь важнее, чем у ответа на вопрос:
        // ответа человек ждёт и сам вернётся, а про это он не знает вовсе.
        const said = client.state
          .messagesOf(event.conversationId)
          .find((message) => message.id === event.messageId);
        const text = said?.parts
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => part.text)
          .join(' ');
        notify('Axon написал', text || event.reason);
      } else if (event.type === 'routine.notified') {
        // Уведомление просит сама рутина шагом `notify` — показываем как есть.
        notify(event.title, event.body ?? '');
      } else if (event.type === 'routine.changed' && event.routine.notify) {
        notifyFinished(event.routine);
      }
    });
  }, [client]);

  useEffect(() => {
    if (!client || status !== 'ready') return;
    void client.call('settings.get', {}).then((result) => setSettings(result.values));
  }, [client, status, version]);

  // Ядро, где уже задан ключ, настраивать заново незачем: визард нужен новым
  // установкам, а не тем, кто просто переустановил приложение.
  useEffect(() => {
    if (setupDone || !client || status !== 'ready') return;
    void client.call('settings.get', {}).then((result) => {
      if (result.secrets.some((secret) => secret.set)) {
        localStorage.setItem('axon.setupDone', 'true');
        setSetupDone(true);
      }
    });
  }, [client, status, setupDone]);

  const providerId = String(settings['provider.active'] ?? 'anthropic');
  const modelId = String(settings[`provider.${providerId}.model`] ?? 'по умолчанию');

  // Назначена ли модель для распознавания картинок. Если нет — вложение
  // поедет прямо в основную модель, и она вполне может отказать.
  const seesImages = Boolean(settings['vision.provider'] && settings['vision.model']);
  const persona = readPersona(settings);

  /**
   * Ядро отстало от приложения.
   *
   * Две разные причины, одно следствие. `coreOutdated` — расхождение ревизии
   * протокола: ядро не знает команд, которые шлёт клиент. `coreBehind` —
   * расхождение версии сборки: контракт тот же, а код старый, и правка,
   * которую вы только что сделали, в нём не работает.
   *
   * Второе ловит то, чего первое не видит в принципе: правка промпта или
   * логики протокол не меняет, поэтому по ревизии всё выглядит согласованным.
   */
  const coreVersion = client?.coreInfo?.version ?? '';
  const coreBehind = coreVersion ? compareVersions(coreVersion, host().app.version) < 0 : false;
  const coreStale = (coreOutdated || coreBehind) && connection?.mode === 'embedded';

  const createChat = async (): Promise<void> => {
    if (!client) return;
    const { conversation } = await client.call('conversation.create', {
      title: PLACEHOLDER_TITLE,
    });
    setActiveId(conversation.id);
    setScreen('chat');
  };

  const send = async (parts: ContentPart[]): Promise<void> => {
    if (!client || parts.length === 0) return;
    setFailure(null);

    // Заголовок берём из текста; сообщение из одних вложений называем по
    // первому файлу — «Новый чат» рядом с картинкой не говорит ничего.
    const firstText = parts.find((part) => part.type === 'text');
    const firstBlob = parts.find((part) => part.type === 'blob');
    const title = firstText
      ? titleFrom(firstText.text)
      : (firstBlob?.name ?? PLACEHOLDER_TITLE);

    try {
      // Активный чат мог уехать в архив или быть удалён — тогда заводим новый,
      // а не пишем в невидимый.
      const existing = conversations.find((c) => c.id === activeId) ?? null;
      let conversationId = existing?.id ?? null;

      if (!conversationId) {
        const { conversation } = await client.call('conversation.create', { title });
        conversationId = conversation.id;
        setActiveId(conversationId);
      } else if (
        existing!.title === PLACEHOLDER_TITLE &&
        client.state.messagesOf(conversationId).length === 0
      ) {
        // Чат, созданный кнопкой, до первого сообщения безымянный. Называем его
        // по первой реплике — иначе список зарастает одинаковыми «Новыми чатами».
        await client.call('conversation.rename', { id: conversationId, title });
      }

      const started = await client.call('message.send', { conversationId, parts });
      setRunId(started.runId);
    } catch (e) {
      setFailure((e as Error).message);
    }
  };


  const banner = error ?? failure;

  return {
    client,
    status,
    connection,
    error,
    version,
    reconnect,
    restartCore,
    theme,
    setTheme,
    motion,
    setMotion,
    screen,
    setScreen,
    activeId,
    setActiveId,
    runId,
    showContext,
    setShowContext,
    showToolCalls,
    toggleToolCalls,
    setupDone,
    finishSetup,
    conversations,
    messages,
    stream,
    permission,
    tools,
    facts,
    observations,
    devices,
    plugins,
    routines,
    activeTitle,
    providerId,
    modelId,
    seesImages,
    persona,
    coreStale,
    coreBehind,
    coreVersion,
    banner,
    clearFailure: () => setFailure(null),
    createChat,
    send,
  };
}
