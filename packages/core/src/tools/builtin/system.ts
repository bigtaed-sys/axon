import os from 'node:os';
import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../types.js';

export function createSystemTools(): ToolDefinition[] {
  const info = defineTool({
    name: 'system_info',
    title: 'Сведения о системе',
    description:
      'Операционная система, процессор, память, время работы машины. Вызывай, ' +
      'когда ответ зависит от того, на чём всё запущено: пути, доступные ' +
      'команды, производительность.',
    tier: 'safe',
    source: 'builtin',
    deferred: true,
    schema: z.object({}),
    async execute() {
      const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
      const cpus = os.cpus();

      return {
        text: [
          `Система: ${os.type()} ${os.release()} (${os.platform()}/${os.arch()})`,
          `Имя машины: ${os.hostname()}`,
          `Процессор: ${cpus[0]?.model ?? 'неизвестен'} × ${cpus.length}`,
          `Память: ${gb(os.totalmem() - os.freemem())} занято из ${gb(os.totalmem())}`,
          `Домашняя папка: ${os.homedir()}`,
          `Работает без перезагрузки: ${Math.round(os.uptime() / 3600)} ч`,
        ].join('\n'),
      };
    },
  });

  return [info];
}
