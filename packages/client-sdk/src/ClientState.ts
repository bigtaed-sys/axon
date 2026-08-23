import type {
  Conversation,
  Device,
  Fact,
  JournalEvent,
  Message,
  Observation,
  PermissionRequest,
  PluginInfo,
  Routine,
  Seq,
  ToolInfo,
} from '@axon/protocol';

export interface RunStream {
  runId: string;
  /** Накопленный текст ответа. Черновик: итог придёт событием. */
  text: string;
  phase: 'thinking' | 'calling_tool' | 'awaiting_permission' | 'summarizing' | 'retrying';
  detail?: string;
  tokensSpent: number;
  costUsd: number;
  budgetRemaining: number | null;
}

/**
 * Локальная проекция состояния ядра.
 *
 * Собирается только применением журнальных событий — никаких «а тут допишем
 * руками». Стоит один раз изменить состояние в обход событий, и клиент
 * начнёт расходиться с ядром в местах, которые невозможно воспроизвести.
 */
export class ClientState {
  readonly conversations = new Map<string, Conversation>();
  readonly messages = new Map<string, Message[]>();
  readonly facts = new Map<string, Fact>();
  readonly observations = new Map<string, Observation>();
  readonly devices = new Map<string, Device>();
  readonly tools = new Map<string, ToolInfo>();
  readonly plugins = new Map<string, PluginInfo>();
  readonly routines = new Map<string, Routine>();
  /** Незакрытые запросы разрешений — по ним рисуется модалка. */
  readonly permissions = new Map<string, PermissionRequest>();
  /** Живые прогоны: текст копится из сигналов, пока не придёт сообщение. */
  readonly streams = new Map<string, RunStream>();

  cursor: Seq = 0;
  coreId: string | null = null;

  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Полный сброс — при смене ядра или потере курсора. */
  reset(): void {
    this.conversations.clear();
    this.messages.clear();
    this.facts.clear();
    this.observations.clear();
    this.devices.clear();
    this.tools.clear();
    this.plugins.clear();
    this.routines.clear();
    this.permissions.clear();
    this.streams.clear();
    this.cursor = 0;
  }

  conversationList(): Conversation[] {
    return [...this.conversations.values()]
      .filter((c) => !c.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  messagesOf(conversationId: string): Message[] {
    return this.messages.get(conversationId) ?? [];
  }

  /**
   * Применить журнальное событие. Идемпотентность обеспечивается уровнем выше
   * по `seq`: сюда одно и то же событие дважды не приходит.
   */
  apply(event: JournalEvent): void {
    switch (event.type) {
      case 'conversation.created':
        this.conversations.set(event.conversation.id, event.conversation);
        break;

      case 'conversation.renamed': {
        const conversation = this.conversations.get(event.id);
        if (conversation) this.conversations.set(event.id, { ...conversation, title: event.title });
        break;
      }

      case 'conversation.archived': {
        const conversation = this.conversations.get(event.id);
        if (conversation) {
          this.conversations.set(event.id, { ...conversation, archived: event.archived });
        }
        break;
      }

      case 'conversation.deleted':
        this.conversations.delete(event.id);
        this.messages.delete(event.id);
        break;

      case 'message.created':
        this.appendMessage(event.message);
        break;

      case 'message.amended': {
        const list = this.messages.get(event.message.conversationId);
        const index = list?.findIndex((m) => m.id === event.message.id) ?? -1;
        if (list && index >= 0) list[index] = event.message;
        break;
      }

      case 'message.deleted': {
        const list = this.messages.get(event.conversationId);
        if (list) {
          const index = list.findIndex((m) => m.id === event.id);
          if (index >= 0) list.splice(index, 1);
        }
        break;
      }

      case 'run.started':
        this.streams.set(event.runId, {
          runId: event.runId,
          text: '',
          phase: 'thinking',
          tokensSpent: 0,
          costUsd: 0,
          budgetRemaining: event.budgetTokens,
        });
        break;

      case 'run.finished':
      case 'run.failed':
        this.streams.delete(event.runId);
        break;

      case 'permission.requested':
        this.permissions.set(event.request.id, event.request);
        break;

      case 'permission.resolved':
        this.permissions.delete(event.requestId);
        break;

      case 'tool.changed':
        this.tools.set(event.tool.name, event.tool);
        break;

      case 'routine.changed':
        this.routines.set(event.routine.id, event.routine);
        break;

      case 'routine.removed':
        this.routines.delete(event.id);
        break;

      case 'plugin.changed':
        this.plugins.set(event.plugin.id, event.plugin);
        break;

      case 'plugin.removed':
        this.plugins.delete(event.id);
        // Инструменты снятого плагина уезжают вместе с ним: событий на каждый
        // из них не будет, а показывать их дальше — врать пользователю.
        for (const [name, tool] of this.tools) {
          if (tool.source === `plugin:${event.id}`) this.tools.delete(name);
        }
        break;

      case 'fact.upserted':
        this.facts.set(event.fact.id, event.fact);
        break;

      case 'fact.forgotten':
        this.facts.delete(event.id);
        break;

      case 'observation.noticed':
        this.observations.set(event.observation.id, event.observation);
        break;

      case 'observation.forgotten':
        this.observations.delete(event.id);
        break;

      case 'device.paired':
        this.devices.set(event.device.id, event.device);
        break;

      case 'device.revoked':
        this.devices.delete(event.id);
        break;

      // Само сообщение приезжает отдельным `message.created` — состоянию тут
      // добавить нечего. Событие существует ради уведомления: по роли
      // отличить порыв агента от обычного ответа невозможно.
      case 'impulse.sent':
      // Значения настроек по проводу не ходят — клиент перезапросит сам.
      case 'settings.changed':
      case 'tool_call.started':
      case 'tool_call.finished':
        break;
    }
  }

  /**
   * Подмешать historyю, загруженную постранично.
   *
   * Снапшот отдаёт только текущее состояние — разговоры, факты, инструменты, —
   * но не переписку: проигрывать весь журнал с начала времён ради неё слишком
   * дорого. Поэтому сообщения приходят отдельной командой, а сюда попадают
   * этим методом. Страница всегда старше того, что уже есть в памяти (живые
   * события дописываются в конец), поэтому она встаёт перед.
   */
  mergeMessages(conversationId: string, incoming: Message[]): void {
    const known = this.messages.get(conversationId) ?? [];
    const seen = new Set(known.map((m) => m.id));
    const fresh = incoming.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) return;

    this.messages.set(conversationId, [...fresh, ...known]);
  }

  private appendMessage(message: Message): void {
    const list = this.messages.get(message.conversationId) ?? [];
    // Сообщение могло приехать и историей, и событием — не дублируем.
    if (list.some((m) => m.id === message.id)) return;
    list.push(message);
    this.messages.set(message.conversationId, list);
  }
}
