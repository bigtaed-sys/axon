import { useState } from 'react';
import { formatVersion } from '@axon/protocol';
import { ChatHeader } from './components/ChatHeader.js';
import { ChatList } from './components/ChatList.js';
import { MessageInput } from './components/MessageInput.js';
import { MessageList } from './components/MessageList.js';
import { ConnectScreen } from './components/ConnectScreen.js';
import { DevicesPanel, Empty, MemoryPanel, ToolsPanel, UsagePanel } from './components/Panels.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { ContextReport } from './components/ContextReport.js';
import { PluginsPanel } from './components/PluginsPanel.js';
import { RoutinesPanel } from './components/RoutinesPanel.js';
import { PermissionModal, type UserDecision } from './components/PermissionModal.js';
import { SetupWizard } from './components/SetupWizard.js';
import { Sidebar } from './components/Sidebar.js';
import { TopBar } from './components/TopBar.js';
import { host } from './host.js';
import { useApp } from './useApp.js';

/**
 * Окно на компьютере.
 *
 * Здесь только расположение: рейка разделов, список чатов, главная область.
 * Всё поведение — в `useApp`, общем с телефоном.
 */

export function App() {
  const app = useApp();
  // Раскрытая рейка — свойство этой раскладки, а не приложения: на телефоне
  // рейки нет вовсе.
  const [expanded, setExpanded] = useState(false);
  const {
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
    clearFailure,
    createChat,
    send,
  } = app;

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
      {coreStale && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-warning/10 border-b border-warning/30 text-[12px] text-warning animate-fade-in">
          <i className="bi bi-arrow-clockwise" />
          <span className="flex-1">
            {coreBehind
              ? `Ядро ${formatVersion(coreVersion)} старее приложения ${formatVersion(host().app.version)} — оно работает на старом коде.`
              : 'Ядро старее приложения — часть возможностей ему пока неизвестна.'}
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
            onClick={clearFailure}
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
