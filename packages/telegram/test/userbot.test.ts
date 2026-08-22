import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/Userbot.js';

describe('разбор команды', () => {
  it('срабатывает на префикс с запросом', () => {
    expect(parseCommand('.axon переведи это', '.axon')).toEqual({ request: 'переведи это' });
  });

  it('регистр не важен', () => {
    expect(parseCommand('.Axon привет', '.axon')).toEqual({ request: 'привет' });
    expect(parseCommand('.AXON привет', '.axon')).toEqual({ request: 'привет' });
  });

  it('не цепляется к словам, начинающимся так же', () => {
    // Самая опасная ошибка из возможных: сработать на чужом тексте — значит
    // заменить собственное сообщение посреди живого разговора.
    expect(parseCommand('.axonometry — это проекция', '.axon')).toBeNull();
    expect(parseCommand('.axonom', '.axon')).toBeNull();
  });

  it('префикс должен стоять в начале', () => {
    expect(parseCommand('напиши .axon привет', '.axon')).toBeNull();
  });

  it('пустая команда ничего не запускает', () => {
    // Один префикс без просьбы — скорее всего опечатка, а не вопрос.
    expect(parseCommand('.axon', '.axon')).toBeNull();
    expect(parseCommand('.axon   ', '.axon')).toBeNull();
  });

  it('переносы строк внутри запроса сохраняются', () => {
    expect(parseCommand('.axon первая\nвторая', '.axon')).toEqual({
      request: 'первая\nвторая',
    });
  });

  it('свой префикс работает так же', () => {
    expect(parseCommand('!аи посчитай', '!аи')).toEqual({ request: 'посчитай' });
    expect(parseCommand('.axon посчитай', '!аи')).toBeNull();
  });
});
