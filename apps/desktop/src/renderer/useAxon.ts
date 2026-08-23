import { useCallback, useEffect, useReducer, useState } from 'react';
import { AxonClient, type ConnectionStatus } from '@axon/client-sdk';
import { host, type Connection } from './host.js';

export type { Connection } from './host.js';

export interface AxonHandle {
  client: AxonClient | null;
  status: ConnectionStatus;
  error: string | null;
  connection: Connection | null;
  /** Растёт при любом изменении состояния — на нём держится перерисовка. */
  version: number;
  /**
   * Ядро старее приложения: рукопожатие прошло, но части контракта оно не
   * знает. Чинится перезапуском — и кнопка для этого рядом.
   */
  coreOutdated: boolean;
  /** Перечитать выбранное подключение и пересоздать клиента. */
  reconnect: () => void;
  /** Перезапустить своё ядро и подключиться заново. */
  restartCore: () => Promise<void>;
}

/**
 * Подключение к ядру и подписка на его состояние.
 *
 * Состояние в SDK — обычные Map, которые мутируются на месте: React не умеет
 * замечать такое сам, поэтому перерисовка держится на счётчике версий. Так
 * дешевле, чем копировать всю историю сообщений на каждую дельту стрима.
 */
export function useAxon(): AxonHandle {
  const [client, setClient] = useState<AxonClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [coreOutdated, setCoreOutdated] = useState(false);
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  // Смена поколения пересоздаёт клиента: подключились к другому ядру —
  // старое состояние и старый сокет должны уйти целиком.
  const [generation, nextGeneration] = useReducer((n: number) => n + 1, 0);

  const reconnect = useCallback(() => nextGeneration(), []);

  /**
   * Перезапустить ядро и подключиться заново.
   *
   * Смена поколения обязательна: у нового ядра другой порт, а значит и другой
   * адрес. Просто дождаться переподключения нельзя — старый клиент будет
   * стучаться туда, где уже никого нет.
   */
  const restartCore = useCallback(async () => {
    setError(null);
    setStatus('connecting');
    try {
      await host().local?.restart();
      setCoreOutdated(false);
      nextGeneration();
    } catch (e) {
      setError((e as Error).message);
      setStatus('offline');
    }
  }, []);

  useEffect(() => {
    let active = true;
    let created: AxonClient | null = null;

    setClient(null);
    setStatus('connecting');
    setError(null);

    void (async () => {
      const { connection: target, error: startupError } = await host().connection();
      if (!active) return;

      setConnection(target);
      if (!target) {
        setError(startupError ?? 'Ядро не выбрано');
        setStatus('offline');
        return;
      }

      created = new AxonClient({ url: target.url, token: target.token });
      created.onStatus(setStatus);
      // Без этого сорвавшийся догон оставлял приложение в вечной
      // «Синхронизации» — без единого слова о том, что произошло.
      created.onError((failure) => {
        if (active) setError(failure.message);
      });
      created.state.subscribe(bump);
      setClient(created);

      try {
        await created.connect();
        if (active) setCoreOutdated(created.coreOutdated);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    })();

    return () => {
      active = false;
      created?.close();
    };
  }, [generation]);

  return { client, status, error, connection, version, coreOutdated, reconnect, restartCore };
}
