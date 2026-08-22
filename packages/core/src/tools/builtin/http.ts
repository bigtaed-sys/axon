import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types.js';

const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 30_000;

export function createHttpTools(): ToolDefinition[] {
  const request = defineTool({
    name: 'http_request',
    title: 'HTTP-запрос',
    description:
      'Выполнить HTTP-запрос и вернуть ответ. Вызывай, когда нужны данные из ' +
      'внешнего API или содержимое страницы. HTML приходит как есть, без ' +
      'разметки не разбирается.',
    tier: 'sensitive',
    source: 'builtin',
    previewLimit: 8_000,
    schema: z.object({
      url: z.string().url().describe('Полный адрес, включая схему'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']).optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional().describe('Тело запроса для POST/PUT/PATCH'),
    }),
    async execute({ url, method = 'GET', headers, body }, ctx) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
      // Отмена прогона должна прерывать и висящий запрос.
      const onAbort = (): void => timeout.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await fetch(url, {
          method,
          ...(headers ? { headers } : {}),
          ...(body === undefined ? {} : { body }),
          signal: timeout.signal,
          redirect: 'follow',
        });

        const text = await readCapped(response);
        const summary = [
          `HTTP ${response.status} ${response.statusText}`,
          `content-type: ${response.headers.get('content-type') ?? 'неизвестен'}`,
          '',
          text,
        ].join('\n');

        return { text: summary };
      } catch (e) {
        const error = e as Error;
        if (error.name === 'AbortError') {
          throw new Error(
            ctx.signal.aborted ? 'Вызов отменён' : `Запрос не уложился в ${TIMEOUT_MS} мс`,
          );
        }
        throw new Error(`Не удалось выполнить запрос: ${error.message}`);
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },
  });

  return [request];
}

/**
 * Читаем ответ с потолком. `response.text()` без ограничения на большом файле
 * съедает память процесса целиком — а по ссылке может оказаться что угодно.
 */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length >= MAX_RESPONSE_BYTES) {
        return `${text.slice(0, MAX_RESPONSE_BYTES)}\n… ответ обрезан`;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return text;
}
