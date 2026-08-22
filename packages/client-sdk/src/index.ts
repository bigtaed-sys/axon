/**
 * @axon/client-sdk — всё, что нужно клиенту Axon: подключение с
 * переподключением, догон журнала по курсору, локальная проекция состояния и
 * типизированный вызов команд.
 *
 * Пакет не знает ни про React, ни про Electron: состояние отдаётся обычной
 * подпиской, поэтому одинаково ложится и на хуки, и на стор, и на CLI.
 */

export { AxonClient, AxonError } from './AxonClient.js';
export type {
  AxonClientOptions,
  ConnectionStatus,
  SocketFactory,
  SocketLike,
} from './AxonClient.js';
export { ClientState } from './ClientState.js';
export type { RunStream } from './ClientState.js';
export { pairDevice, checkHealth, BlobClient, HttpError } from './http.js';
export type { PairResult, CoreHealth } from './http.js';
