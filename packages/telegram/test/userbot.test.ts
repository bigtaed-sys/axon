import { describe, expect, it } from 'vitest';
import { buildPrompt, parseCommand } from '../src/Userbot.js';

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

describe('задание для модели', () => {
  it('говорит, что ответ станет сообщением человека', () => {
    // Без этого модель отвечает так, будто разговаривает с тем, кто её позвал:
    // «вот перевод», «конечно, сейчас» — и всё это уезжает собеседнику.
    const prompt = buildPrompt('переведи', null);

    expect(prompt).toContain('от имени человека');
    expect(prompt).toContain('как его собственное сообщение');
    expect(prompt).toContain('он твой ответ не читает');
  });

  it('называет автора цитаты', () => {
    // Первая версия подставляла текст без автора, и модель принимала реплику
    // друга за слова самого человека — то есть отвечала не тому.
    const prompt = buildPrompt('ответь ему', { author: 'Миша', text: 'ты придёшь?' });

    expect(prompt).toContain('Собеседник (Миша) написал');
    expect(prompt).toContain('ты придёшь?');
  });

  it('ответ на собственное сообщение автора не выдумывает', () => {
    const prompt = buildPrompt('переведи', { author: '', text: 'буду в десять' });

    expect(prompt).toContain('написал ранее');
    expect(prompt).not.toContain('Собеседник');
  });

  it('без цитаты — только просьба', () => {
    const prompt = buildPrompt('посчитай 2+2', null);

    expect(prompt).toContain('посчитай 2+2');
    expect(prompt).not.toContain('написал');
  });
});
