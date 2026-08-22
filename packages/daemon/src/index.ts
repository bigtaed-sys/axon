export { Daemon, DAEMON_VERSION } from './Daemon.js';
export type { DaemonOptions, DaemonAddress } from './Daemon.js';
export { PermissionHub } from './PermissionHub.js';
export { PairingService, authenticate, hashToken, generateToken } from './auth.js';
export { dispatch, CommandError } from './commands.js';
export type { CommandContext } from './commands.js';
export { WsSession } from './WsSession.js';
