import { useState } from 'react';
import clsx from 'clsx';
import { useKeyboard } from './keyboard.js';
import {
  ChatList,
  ConnectScreen,
  ContextReport,
  DevicesPanel,
  Empty,
  MemoryPanel,
  MessageInput,
  MessageList,
  PermissionModal,
  PluginsPanel,
  RoutinesPanel,
  SettingsPanel,
  SetupWizard,
  ToolsPanel,
  UsagePanel,
  useApp,
  type Screen,
  type UserDecision,
} from '@axon/ui';

/**
 * Окно на телефоне.
 *
 * Десктопная раскладка здесь не работает совсем: рейка разделов и список чатов
 * забирают две трети ширины, и на разговор остаётся полоска в один символ.
 * Поэтому оболочка своя — а всё поведение общее, из `useApp`.
 *
 * Устройство раскладки: экран занят одним разделом целиком, разделы
 * переключаются островком снизу, список чатов приезжает шторкой поверх
 * разговора. Ничего не делится на колонки — делить нечего.
 */

interface Section {
  id: Screen;
  label: string;
  icon: string;
}

/**
 * Что попадает на островок.
 *
 * Разделов девять, и все они нужны — но не одновременно. На островке живут
 * четыре, которыми пользуются каждый день, остальные приезжают по «ещё».
 * Девять иконок в ряд на экране шириной в ладонь — это девять промахов.
 */
const ISLAND: Section[] = [
  { id: 'chat', label: 'Чат', icon: 'bi-chat-dots-fill' },
  { id: 'memory', label: 'Память', icon: 'bi-journal-bookmark-fill' },
  { id: 'routines', label: 'Рутины', icon: 'bi-clock-history' },
  { id: 'settings', label: 'Настройки', icon: 'bi-gear-fill' },
];

const MORE: Section[] = [
  { id: 'tools', label: 'Инструменты', icon: 'bi-tools' },
  { id: 'plugins', label: 'Плагины', icon: 'bi-puzzle-fill' },
  { id: 'usage', label: 'Расход', icon: 'bi-graph-up' },
  { id: 'devices', label: 'Устройства', icon: 'bi-hdd-network' },
  { id: 'connect', label: 'Ядро', icon: 'bi-hdd-rack' },
];

const TITLES: Partial<Record<Screen, string>> = Object.fromEntries(
  [...ISLAND, ...MORE].map((section) => [section.id, section.label]),
);

/** Порядок разделов слева направо — по нему выбирается сторона перехода. */
const ORDER: Screen[] = [...ISLAND.map((s) => s.id), ...MORE.map((s) => s.id)];

function orderOf(screen: Screen): number {
  const index = ORDER.indexOf(screen);
  return index === -1 ? ORDER.length : index;
}

export function Shell() {
  const app = useApp();
  const [chats, setChats] = useState(false);
  const [more, setMore] = useState(false);
  const typing = useKeyboard();

  const { client, status, screen, setScreen } = app;

  /**
   * Куда «листнули».
   *
   * Разделы лежат в ряд, и переход должен идти в ту же сторону, что и палец:
   * ушёл вправо по островку — новый экран приезжает справа. Направление, взятое
   * с потолка, читается хуже, чем его отсутствие: человек запоминает порядок
   * разделов по движению, и противоречие сбивает эту память.
   */
  const [forward, setForward] = useState(true);

  const go = (next: Screen): void => {
    setForward(orderOf(next) >= orderOf(screen));
    setScreen(next);
    setChats(false);
    setMore(false);
  };

  // Мастер настройки занимает экран целиком: во время неё выбирать разделы
  // не из чего.
  if (!app.setupDone || screen === 'setup') {
    return (
      <div className="h-full flex flex-col bg-bg">
        <SetupWizard
          client={client}
          connection={app.connection}
          onFinish={app.finishSetup}
          onReconnect={app.reconnect}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg">
      {app.banner && (
        <div className="shrink-0 flex items-start gap-2 px-3 py-2 bg-danger/10 border-b border-danger/30 text-[12px] text-danger">
          <i className="bi bi-exclamation-triangle-fill mt-0.5" />
          <span className="flex-1 whitespace-pre-line leading-relaxed">{app.banner}</span>
          <button type="button" onClick={app.clearFailure} className="w-6 h-6 shrink-0">
            <i className="bi bi-x-lg text-[11px]" />
          </button>
        </div>
      )}

      <Header
        app={app}
        onOpenChats={() => setChats(true)}
        onOpenContext={() => app.setShowContext(true)}
      />

      {/*
        Отступ снизу — под островок: он висит поверх содержимого, и без места
        под него последнее сообщение и поле ввода оказываются под кнопками.
      */}
      {/*
        `key` по разделу обязателен: без него React переиспользует узлы, и
        появление нового экрана не проигрывается вовсе — картинка просто
        подменяется.
      */}
      <main
        key={screen}
        className={clsx(
          'flex-1 min-h-0 flex flex-col',
          forward ? 'slide-from-right' : 'slide-from-left',
          !typing && 'under-island',
          // Разделы кроме чата начинаются под шапкой: подсовывать заголовок
          // панели под островок незачем, читать его там нечем.
          screen !== 'chat' && 'pt-12',
        )}
      >
        <Body app={app} onOpenChats={() => setChats(true)} />
      </main>

      {!typing && <Island screen={screen} onGo={go} onMore={() => setMore(true)} />}

      {chats && client && (
        <Sheet title="Чаты" onClose={() => setChats(false)}>
          <ChatList
            conversations={app.conversations}
            activeId={app.activeId}
            client={client}
            onSelect={(id) => {
              app.setActiveId(id);
              setChats(false);
            }}
            onCreate={() => {
              void app.createChat();
              setChats(false);
            }}
            onArchive={(id) => void client.call('conversation.archive', { id, archived: true })}
          />
        </Sheet>
      )}

      {more && (
        <Sheet title="Ещё" onClose={() => setMore(false)}>
          <div className="p-3 flex flex-col gap-1.5">
            {MORE.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => go(section.id)}
                className="tap h-12 px-4 rounded-xl2 bg-surface border border-border flex items-center gap-3 text-[14px]"
              >
                <i className={clsx('bi', section.icon, 'text-accent')} />
                {section.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {app.showContext && client && app.activeId && (
        <ContextReport
          client={client}
          conversationId={app.activeId}
          onClose={() => app.setShowContext(false)}
          onOpenTools={() => go('tools')}
          onOpenMemory={() => go('memory')}
          onOpenSettings={() => go('settings')}
        />
      )}

      {app.permission && (
        <PermissionModal
          request={app.permission}
          onDecide={(decision: UserDecision) => {
            void client?.call('permission.resolve', {
              requestId: app.permission!.id,
              decision,
            });
          }}
        />
      )}

      {status !== 'ready' && !app.banner && (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-accent/60 animate-pulse" />
      )}
    </div>
  );
}

/**
 * Шапка: маленький островок с именем того, что открыто.
 *
 * В разговоре он же открывает список чатов — это единственная кнопка, которая
 * нужна там постоянно. В остальных разделах он просто называет раздел: экран
 * без заголовка на телефоне теряется мгновенно, потому что вокруг нет ни
 * рейки, ни колонок, по которым понятно, где ты.
 */
function Header({
  app,
  onOpenChats,
  onOpenContext,
}: {
  app: ReturnType<typeof useApp>;
  onOpenChats: () => void;
  onOpenContext: () => void;
}) {
  const chat = app.screen === 'chat';

  return (
    <header className="header-float absolute inset-x-0 top-0 z-20 h-12 flex items-center justify-center px-3">
      {/*
        Островок по центру, шириной по содержимому. Тянуть его во всю ширину
        нельзя: тогда это уже не предмет на экране, а полоса, — а центр
        единственное место, где такая штука читается сама собой.
      */}
      <button
        type="button"
        disabled={!chat}
        onClick={onOpenChats}
        className="tap max-w-[70%] h-9 px-4 rounded-full bg-surface-high border border-border flex items-center gap-2 text-[13px] font-medium shadow-soft"
      >
        {chat && <i className="bi bi-chat-dots-fill text-accent text-[11px] shrink-0" />}
        <span className="truncate">{chat ? app.activeTitle : (TITLES[app.screen] ?? 'Axon')}</span>
        {chat && <i className="bi bi-chevron-down text-text-dim text-[9px] shrink-0" />}
      </button>

      {chat && (
        <button
          type="button"
          onClick={onOpenContext}
          title="Во что обходится контекст"
          className="tap absolute right-3 w-9 h-9 rounded-full bg-surface-high border border-border flex items-center justify-center"
        >
          <i className="bi bi-eye text-[13px] text-text-muted" />
        </button>
      )}
    </header>
  );
}

/** Содержимое раздела. Панели те же, что на компьютере, — они и так по колонке. */
function Body({ app, onOpenChats }: { app: ReturnType<typeof useApp>; onOpenChats: () => void }) {
  const { client } = app;

  if (app.screen === 'connect' || (!client && app.error)) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar">
        <ConnectScreen
          current={app.connection}
          error={app.error}
          onConnected={() => {
            app.setScreen('chat');
            app.reconnect();
          }}
        />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Empty icon="bi-hourglass-split" text="Подключаемся к ядру…" />
      </div>
    );
  }

  switch (app.screen) {
    case 'chat':
      return (
        <>
          <MessageList
            inset="pt-14"
            messages={app.messages}
            stream={app.stream}
            showToolCalls={app.showToolCalls}
            client={client}
            persona={app.persona}
            onSuggest={(text) => void app.send([{ type: 'text', text }])}
          />
          <MessageInput
            keyboard={false}
            disabled={app.status !== 'ready'}
            streaming={Boolean(app.stream)}
            client={client}
            seesImages={app.seesImages}
            onOpenSettings={() => app.setScreen('settings')}
            onSend={(parts) => void app.send(parts)}
            onCancel={() => {
              if (app.runId) void client.call('run.cancel', { runId: app.runId });
            }}
          />
        </>
      );

    case 'settings':
      return (
        <SettingsPanel
          client={client}
          connection={app.connection}
          plugins={app.plugins}
          theme={app.theme}
          onTheme={app.setTheme}
          motion={app.motion}
          onMotion={app.setMotion}
          onReconnect={app.reconnect}
          onChangeCore={() => app.setScreen('connect')}
          onRestartCore={app.restartCore}
          onRunSetup={() => app.setScreen('setup')}
        />
      );

    case 'devices':
      return (
        <DevicesPanel
          client={client}
          devices={app.devices}
          connection={app.connection}
          onReconnect={app.reconnect}
        />
      );

    case 'memory':
      return <MemoryPanel facts={app.facts} observations={app.observations} client={client} />;

    case 'tools':
      return <ToolsPanel tools={app.tools} plugins={app.plugins} client={client} />;

    case 'plugins':
      return <PluginsPanel plugins={app.plugins} client={client} />;

    case 'routines':
      return (
        <RoutinesPanel
          routines={app.routines}
          tools={app.tools}
          client={client}
          onOpenChat={(conversationId) => {
            app.setActiveId(conversationId);
            app.setScreen('chat');
            onOpenChats();
          }}
        />
      );

    default:
      return <UsagePanel client={client} />;
  }
}

/**
 * Островок разделов.
 *
 * Плавает над содержимым, а не прибит к низу полосой: полоса во всю ширину
 * съедает строку экрана насовсем, а островок оставляет содержимое видимым по
 * краям и читается как отдельный предмет, а не как край окна.
 */
function Island({
  screen,
  onGo,
  onMore,
}: {
  screen: Screen;
  onGo: (screen: Screen) => void;
  onMore: () => void;
}) {
  const inMore = MORE.some((section) => section.id === screen);
  // Где сейчас стоит бегунок. «Ещё» — последняя позиция.
  const current = inMore
    ? ISLAND.length
    : Math.max(
        0,
        ISLAND.findIndex((section) => section.id === screen),
      );

  return (
    <nav className="fixed inset-x-0 bottom-0 px-3 pb-[max(10px,env(safe-area-inset-bottom))] flex justify-center pointer-events-none">
      {/*
        Ширину островка задаёт экран, а не то, что открыто: кнопки делят её
        поровну и остаются на месте при переключении. Панель, меняющая размер
        под вкладкой, заставляет целиться заново после каждого нажатия.
      */}
      <div className="pointer-events-auto relative w-full max-w-[380px] flex items-center p-1.5 rounded-[26px] border border-border bg-surface/95 backdrop-blur shadow-pop">
        {/*
          Подсветка выбранного — отдельный слой, который переезжает, а не
          перекрашивание кнопок. Переезд показывает, куда именно ты попал, и
          связывает островок с тем, как в это время листается сам экран.
        */}
        <span
          aria-hidden
          className="island-mark absolute top-1.5 bottom-1.5 left-1.5 rounded-[20px] bg-accent"
          style={{
            width: `calc((100% - 12px) / ${ISLAND.length + 1})`,
            transform: `translateX(${current * 100}%)`,
          }}
        />
        {ISLAND.map((section) => (
          <IslandButton
            key={section.id}
            icon={section.icon}
            label={section.label}
            active={screen === section.id}
            onClick={() => onGo(section.id)}
          />
        ))}
        <IslandButton icon="bi-three-dots" label="Ещё" active={inMore} onClick={onMore} />
      </div>
    </nav>
  );
}

/**
 * Кнопка островка: подпись под иконкой и видна всегда.
 *
 * Иконка без подписи — загадка, которую разгадывают нажатием, а на телефоне
 * такая загадка стоит перехода в чужой раздел и обратно. Подписи у всех кнопок
 * заодно держат размер островка постоянным.
 */
function IslandButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'tap relative z-10 flex-1 min-w-0 h-[54px] rounded-[20px]',
        'flex flex-col items-center justify-center gap-1',
        active ? 'text-accent-fg' : 'text-text-muted',
      )}
    >
      <i className={clsx('bi', icon, 'text-[16px] leading-none')} />
      <span className="text-[9px] font-medium leading-none truncate max-w-full px-0.5">{label}</span>
    </button>
  );
}

/**
 * Шторка снизу.
 *
 * Снизу, а не сверху: до верхнего края экрана большим пальцем не дотянуться, а
 * закрывают её чаще, чем открывают.
 */
function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="backdrop fixed inset-0 z-40 flex flex-col justify-end modal-backdrop"
      onClick={onClose}
    >
      <div
        className="sheet max-h-[78%] flex flex-col rounded-t-[20px] border-t border-border bg-bg"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
          <span className="text-[14px] font-semibold flex-1">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="tap w-8 h-8 rounded-full flex items-center justify-center text-text-dim"
          >
            <i className="bi bi-x-lg text-[12px]" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar pb-[max(12px,env(safe-area-inset-bottom))]">
          {children}
        </div>
      </div>
    </div>
  );
}
