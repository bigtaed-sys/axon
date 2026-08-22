import { randomUUID } from 'node:crypto';
import type { PermissionDecision, PermissionRequest } from '@axon/protocol';
import type { Store } from '../storage/Store.js';
import type { PermissionDecider } from '../tools/ToolExecutor.js';

/**
 * Кто отвечает на запрос разрешения. Реализация живёт в демоне: он показывает
 * запрос подключённым устройствам и ждёт ответа. Ядру достаточно промиса.
 */
export interface PermissionBroker {
  request(request: PermissionRequest): Promise<PermissionDecision>;
}

/**
 * Брокер по умолчанию — отказ.
 *
 * Так и задумано: если спросить некого (фоновая рутина, адаптер без прав,
 * ядро без клиентов), то опасное действие не выполняется. Обратный дефолт
 * означал бы, что достаточно дождаться, пока пользователь отойдёт.
 */
export const denyAllBroker: PermissionBroker = {
  async request() {
    return 'deny_once';
  },
};

/**
 * Политика поверх сохранённых правил: сначала смотрим, не решил ли
 * пользователь этот вопрос раньше и навсегда, потом уже спрашиваем.
 */
export class StoredPermissions implements PermissionDecider {
  constructor(private readonly store: Store) {}

  async decide(input: {
    tool: { name: string; tier: string };
  }): Promise<'allow' | 'deny' | 'ask'> {
    const rule = this.store.permissionRules.get(input.tool.name);
    if (rule === 'allow') return 'allow';
    if (rule === 'deny') return 'deny';
    return input.tool.tier === 'safe' ? 'allow' : 'ask';
  }
}

/** Сохранить постоянное решение, если пользователь выбрал «всегда». */
export function persistDecision(store: Store, toolName: string, decision: PermissionDecision): void {
  if (decision === 'allow_always') {
    store.permissionRules.set(randomUUID(), toolName, 'allow', new Date().toISOString());
  } else if (decision === 'deny_always') {
    store.permissionRules.set(randomUUID(), toolName, 'deny', new Date().toISOString());
  }
}

export function isGranted(decision: PermissionDecision): boolean {
  return decision === 'allow_once' || decision === 'allow_always';
}
