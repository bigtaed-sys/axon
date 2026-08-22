import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { readPersona } from '@axon/protocol';
import type { ContentPart, Routine } from '@axon/protocol';
import { ChatHeader } from './components/ChatHeader.js';
import { ChatList } from './components/ChatList.js';
import { MessageInput } from './components/MessageInput.js';
import { MessageList } from './components/MessageList.js';
import { ConnectScreen } from './components/ConnectScreen.js';
import {
  DevicesPanel,
  Empty,
  MemoryPanel,
  ToolsPanel,
  UsagePanel,
} from './components/Panels.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { ContextReport } from './components/ContextReport.js';
import { PluginsPanel } from './components/PluginsPanel.js';
import { RoutinesPanel } from './components/RoutinesPanel.js';
import { PermissionModal, type UserDecision } from './components/PermissionModal.js';
import { SetupWizard } from './components/SetupWizard.js';
import { Sidebar, type Screen } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { useMotion } from './motion.js';
import { useTheme } from './theme.js';
import { useAxon } from './useAxon.js';

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

export function App() {
  const { client, status, error, connection, version, coreOutdated, reconnect, restartCore } =
    useAxon();
  const { theme, setTheme } = useTheme();
  const { motion, setMotion } = useMotion();

  const [screen, setScreen] = useState<Screen>('chat');
  const [expanded, setExpanded] = useState(false);
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

  /**
   * Что показать в главной области.
   *
   * Отдельной функцией с ранними возвратами, а не цепочкой тернарников в JSX.
   * Причина не косметическая: каждый экран добавлял в разметку ещё один
   * уровень вложенности, и на девятом сборка стала падать — rollup обходит
   * дерево рекурсивно и упирался в стек. Плоский список читается лучше и не
   * растёт в глубину от добавления экрана.
   */
  function body(): React.ReactNode {
    // Экран подключения показываем и по требованию, и когда ядро не
    // отозвалось: иначе человек упирается в пустое окно без выхода.
    if (screen === 'connect' || (!client && error)) {
      return (
        <ConnectScreen
          current={connection}
          error={error}
          onConnected={() => {
            setScreen('chat');
            reconnect();
          }}
        />
      );
    }

    if (!client) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <Empty icon="bi-hourglass-split" text="Подключаемся к ядру…" />
        </div>
      );
    }

    switch (screen) {
      case 'chat':
        return (
          <>
            <ChatHeader
              title={activeTitle}
              provider={providerId}
              model={modelId}
              toolCount={tools.filter((t) => t.enabled).length}
              showToolCalls={showToolCalls}
              onToggleToolCalls={toggleToolCalls}
              onOpenTools={() => setScreen('tools')}
              onOpenSettings={() => setScreen('settings')}
              onOpenContext={() => setShowContext(true)}
            />
            <MessageList
              messages={messages}
              stream={stream}
              showToolCalls={showToolCalls}
              client={client}
              persona={persona}
              onSuggest={(text) => void send([{ type: 'text', text }])}
            />
            <MessageInput
              disabled={status !== 'ready'}
              streaming={Boolean(stream)}
              client={client}
              seesImages={seesImages}
              onOpenSettings={() => setScreen('settings')}
              onSend={(parts) => void send(parts)}
              onCancel={() => {
                if (runId) void client.call('run.cancel', { runId });
              }}
            />
          </>
        );

      case 'settings':
        return (
          <SettingsPanel
            client={client}
            connection={connection}
            plugins={plugins}
            theme={theme}
            onTheme={setTheme}
            motion={motion}
            onMotion={setMotion}
            onReconnect={reconnect}
            onChangeCore={() => setScreen('connect')}
            onRestartCore={restartCore}
            onRunSetup={() => setScreen('setup')}
          />
        );

      case 'devices':
        return (
          <DevicesPanel
            client={client}
            devices={devices}
            connection={connection}
            onReconnect={reconnect}
          />
        );

      case 'memory':
        return <MemoryPanel facts={facts} observations={observations} client={client} />;

      case 'tools':
        return <ToolsPanel tools={tools} plugins={plugins} client={client} />;

      case 'plugins':
        return <PluginsPanel plugins={plugins} client={client} />;

      case 'routines':
        return (
          <RoutinesPanel
            routines={routines}
            tools={tools}
            client={client}
            onOpenChat={(conversationId) => {
              setActiveId(conversationId);
              setScreen('chat');
            }}
          />
        );

      default:
        return <UsagePanel client={client} />;
    }
  }

  // Визард занимает окно целиком: во время настройки в боковой панели нечего
  // делать, а лишние кнопки только уводят в сторону.
  if (!setupDone || screen === 'setup') {
    return (
      <div className="h-full flex flex-col">
        <TopBar status={status} theme={theme} onTheme={setTheme} />
        <div className="flex-1 min-h-0 flex bg-bg">
          <SetupWizard
            client={client}
            connection={connection}
            onFinish={finishSetup}
            onReconnect={reconnect}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <TopBar status={status} theme={theme} onTheme={setTheme} />

      {/*
        Ядро — отдельная программа, и оно законно бывает старше приложения:
        десктоп обновился, а ядро рядом осталось поднятым до обновления.
        Чинится перезапуском, поэтому кнопка здесь же: иначе единственным
        способом узнать об этом была бы наполовину пустая панель.
      */}
      {coreOutdated && connection?.mode === 'embedded' && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-warning/10 border-b border-warning/30 text-[12px] text-warning animate-fade-in">
          <i className="bi bi-arrow-clockwise" />
          <span className="flex-1">
            Ядро старее приложения — часть возможностей ему пока неизвестна.
          </span>
          <button
            type="button"
            onClick={() => void restartCore()}
            className="h-6 px-2.5 rounded-lg bg-warning/20 hover:bg-warning/30 transition-colors font-medium"
          >
            Перезапустить ядро
          </button>
        </div>
      )}

      {banner && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-danger/10 border-b border-danger/30 text-[12px] text-danger animate-fade-in">
          <i className="bi bi-exclamation-triangle-fill" />
          <span className="flex-1">{banner}</span>
          <button
            type="button"
            onClick={() => setFailure(null)}
            className="w-5 h-5 rounded flex items-center justify-center hover:bg-danger/20 transition-colors"
          >
            <i className="bi bi-x-lg text-[10px]" />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <Sidebar
          screen={screen}
          expanded={expanded}
          onSelect={setScreen}
          onToggle={() => setExpanded((v) => !v)}
        />

        {screen === 'chat' && client && (
          <ChatList
            conversations={conversations}
            activeId={activeId}
            client={client}
            onSelect={setActiveId}
            onCreate={() => void createChat()}
            onArchive={(id) => void client.call('conversation.archive', { id, archived: true })}
          />
        )}

        <main className="flex-1 min-w-0 min-h-0 flex flex-col bg-bg">{body()}</main>
      </div>

      {showContext && client && activeId && (
        <ContextReport
          client={client}
          conversationId={activeId}
          onClose={() => setShowContext(false)}
          onOpenTools={() => setScreen('tools')}
          onOpenMemory={() => setScreen('memory')}
          onOpenSettings={() => setScreen('settings')}
        />
      )}

      {permission && (
        <PermissionModal
          request={permission}
          onDecide={(decision: UserDecision) => {
            void client?.call('permission.resolve', { requestId: permission.id, decision });
          }}
        />
      )}
    </div>
  );
}
