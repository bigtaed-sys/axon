import { spawn, type ChildProcess } from 'node:child_process';
import type { McpTransport } from '@axon/protocol';
import { logger, type Logger } from '../logger.js';

/**
 * Клиент MCP — ровно столько протокола, сколько нужно, чтобы взять у сервера
 * инструменты и вызывать их.
 *
 * Своя реализация вместо официального SDK по одной причине: SDK тянет свои
 * зависимости и свою модель транспортов, а нам нужны две трети одного файла —
 * рукопожатие, `tools/list`, `tools/call`. Меньше кода, чем обёртка вокруг
 * чужого, и никакого расхождения версий в бандле.
 */

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'axon', version: '1' };
const DEFAULT_TIMEOUT_MS = 60_000;

export interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export class McpError extends Error {
  constructor(
    message: string,
    readonly code: string = 'mcp_error',
  ) {
    super(message);
    this.name = 'McpError';
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly log: Logger;

  private child: ChildProcess | null = null;
  /** Незавершённая строка из stdout: JSON-RPC приходит построчно, но не покадрово. */
  private buffer = '';
  /** Идентификатор сессии для HTTP-транспорта — сервер выдаёт его при initialize. */
  private sessionId: string | null = null;
  private closed = false;

  serverName = '';
  serverVersion = '';

  constructor(
    readonly name: string,
    private readonly transport: McpTransport,
    private readonly onLog?: (level: string, text: string) => void,
  ) {
    this.log = logger.child({ mcp: name });
  }

  // ─── Подключение ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.transport.type === 'stdio') this.spawnServer(this.transport);

    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as { serverInfo?: { name?: string; version?: string } };

    this.serverName = result.serverInfo?.name ?? this.name;
    this.serverVersion = result.serverInfo?.version ?? '';

    // По спецификации это уведомление обязательно: до него сервер вправе не
    // отвечать на рабочие запросы.
    this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolSpec[]> {
    const collected: McpToolSpec[] = [];
    let cursor: string | undefined;

    // Пагинация не декоративная: сервер вроде github отдаёт под сотню
    // инструментов и режет выдачу.
    do {
      const page = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpToolSpec[];
        nextCursor?: string;
      };
      collected.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor && collected.length < 500);

    return collected;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args }, signal)) as {
      content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };

    const parts: string[] = [];
    for (const item of result.content ?? []) {
      if (item.type === 'text' && item.text) parts.push(item.text);
      else if (item.type === 'image') parts.push(`[изображение ${item.mimeType ?? ''}]`);
      else if (item.type === 'resource') parts.push(item.text ?? '[ресурс]');
    }
    // Некоторые серверы отдают только структурированный результат.
    if (parts.length === 0 && result.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent, null, 2));
    }

    return { text: parts.join('\n'), isError: result.isError === true };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(new McpError('Соединение с MCP-сервером закрыто', 'closed'));
    }

    const child = this.child;
    if (!child) return;
    this.child = null;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  // ─── Транспорт: дочерний процесс ──────────────────────────────────────────

  private spawnServer(transport: Extract<McpTransport, { type: 'stdio' }>): void {
    const child = spawn(transport.command, transport.args, {
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      env: { ...process.env, ...transport.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // На Windows npx и uvx — это .cmd, а их без оболочки не запустить.
      shell: process.platform === 'win32',
      // Без этого каждый MCP-сервер на Windows открывает поверх приложения
      // чёрное окно консоли. Пользователь ничего для этого не делал и закрыть
      // его не может — сервер живёт, пока живёт плагин.
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Сервера по MCP пишут в stderr свои логи. Это не ошибка сама по себе,
      // но единственное место, где видно, почему сервер не отвечает.
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.onLog?.('info', `[${this.name}] ${line}`);
      }
    });

    child.on('error', (error) => this.fail(new McpError(error.message, 'spawn_failed')));
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      this.fail(new McpError(`Сервер завершился (${signal ?? code})`, 'exited'));
    });
  }

  /** Разобрать поток stdout на строки: одна строка — одно сообщение JSON-RPC. */
  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.deliver(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private deliver(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      // Не JSON — почти наверняка сервер что-то напечатал в stdout мимо
      // протокола. Роняться из-за этого нельзя.
      this.onLog?.('warn', `[${this.name}] не-JSON в stdout: ${line.slice(0, 200)}`);
      return;
    }
    this.settle(message);
  }

  private settle(message: JsonRpcResponse): void {
    // Уведомления от сервера (прогресс, изменение списка инструментов) нам
    // пока нечего обрабатывать — но и падать на них незачем.
    if (typeof message.id !== 'number') return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) pending.reject(new McpError(message.error.message, 'server_error'));
    else pending.resolve(message.result ?? null);
  }

  private fail(error: McpError): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.log.warn({ err: error.message }, 'mcp-сервер отвалился');
  }

  // ─── Запросы ──────────────────────────────────────────────────────────────

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new McpError('Клиент закрыт', 'closed'));
    const id = this.nextId++;
    const body = { jsonrpc: '2.0' as const, id, method, params };

    if (this.transport.type === 'http') return this.httpRequest(body, signal);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`Сервер не ответил на ${method}`, 'timeout'));
      }, DEFAULT_TIMEOUT_MS);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          this.notify('notifications/cancelled', { requestId: id });
          reject(new McpError('Вызов отменён', 'cancelled'));
        },
        { once: true },
      );

      this.write(body);
    });
  }

  private notify(method: string, params: unknown): void {
    const body = { jsonrpc: '2.0' as const, method, params };
    if (this.transport.type === 'http') {
      void this.httpRequest(body).catch(() => {
        // Уведомление, ответа нет и ждать нечего.
      });
      return;
    }
    this.write(body);
  }

  private write(body: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin?.writable) throw new McpError('MCP-сервер не запущен', 'not_running');
    stdin.write(`${JSON.stringify(body)}\n`);
  }

  // ─── Транспорт: HTTP ──────────────────────────────────────────────────────

  private async httpRequest(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport as Extract<McpTransport, { type: 'http' }>;
    const response = await fetch(transport.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Сервер вправе ответить и обычным JSON, и потоком событий —
        // договариваемся, что примем оба.
        Accept: 'application/json, text/event-stream',
        ...transport.headers,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    const session = response.headers.get('Mcp-Session-Id');
    if (session) this.sessionId = session;

    // Уведомления сервер подтверждает пустым 202 — разбирать нечего.
    if (response.status === 202) return null;
    if (!response.ok) {
      throw new McpError(`HTTP ${response.status} от MCP-сервера`, 'http_error');
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    const text = await response.text();
    const message = contentType.includes('text/event-stream')
      ? parseSse(text)
      : (JSON.parse(text) as JsonRpcResponse);

    if (!message) throw new McpError('Пустой ответ MCP-сервера', 'empty');
    if (message.error) throw new McpError(message.error.message, 'server_error');
    return message.result ?? null;
  }
}

/**
 * Достать последнее сообщение JSON-RPC из потока SSE.
 *
 * Ответ на запрос всегда последний: до него могут идти уведомления о прогрессе,
 * которые нам сейчас не нужны, но которые нельзя принять за результат.
 */
function parseSse(text: string): JsonRpcResponse | null {
  let last: JsonRpcResponse | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const message = JSON.parse(payload) as JsonRpcResponse;
      if (message.id !== undefined) last = message;
    } catch {
      // Кусок не разобрался — следующий может.
    }
  }
  return last;
}
