/**
 * @axon/protocol — контракт между ядром Axon и любым клиентом.
 *
 * Пакет намеренно не содержит ни транспорта, ни ввода-вывода: только схемы и
 * типы. Всё, что пересекает границу процесса, описано здесь и валидируется на
 * обеих сторонах — ядро не доверяет клиенту, клиент не доверяет ядру.
 */

export * from './primitives.js';
export * from './errors.js';
export * from './domain.js';
export * from './impulse.js';
export * from './persona.js';
export * from './plugins.js';
export * from './routines.js';
export * from './events.js';
export * from './signals.js';
export * from './settings.js';
export * from './commands.js';
export * from './envelope.js';
