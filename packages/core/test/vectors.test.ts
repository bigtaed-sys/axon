import { describe, expect, it } from 'vitest';
import { fuse, pack, similarity, unpack } from '../src/index.js';

describe('векторы', () => {
  it('переживают дорогу в базу и обратно', () => {
    const original = [0.1, -0.5, 0.9, 0];
    const restored = unpack(pack(original));

    expect(restored).toHaveLength(4);
    // Float32 — не Float64, точность здесь и не нужна.
    expect(Array.from(restored)).toEqual(original.map((v) => Math.fround(v)));
  });

  it('одинаковые векторы совпадают полностью', () => {
    const a = Float32Array.from([1, 2, 3]);
    expect(similarity(a, a)).toBeCloseTo(1, 6);
  });

  it('противоположные дают минус единицу', () => {
    expect(similarity(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1, 6);
  });

  it('длина вектора не влияет на близость', () => {
    // Векторы моделей обычно нормированы, но «обычно» не «всегда»: деление на
    // длины снимает вопрос целиком.
    const short = Float32Array.from([1, 1]);
    const long = Float32Array.from([100, 100]);
    expect(similarity(short, long)).toBeCloseTo(1, 6);
  });

  it('разная размерность — не совпадение, а ноль', () => {
    // Так бывает при смене модели: складывать несравнимое хуже, чем не найти.
    expect(similarity(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3]))).toBe(0);
  });

  it('пустой вектор ничего не ломает', () => {
    expect(similarity(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });
});

describe('слияние выдач', () => {
  it('поднимает то, что нашли оба способа', () => {
    // Главный смысл гибрида: совпадение двух независимых мнений весит больше,
    // чем первое место у одного из них.
    const words = ['а', 'б', 'в'];
    const meaning = ['г', 'б', 'д'];

    expect(fuse([words, meaning], 3)[0]).toBe('б');
  });

  it('сохраняет находки, которые есть только у одного', () => {
    const words = ['а'];
    const meaning = ['б'];

    expect(fuse([words, meaning], 5).sort()).toEqual(['а', 'б']);
  });

  it('одна выдача сливается сама с собой без перестановок', () => {
    expect(fuse([['а', 'б', 'в']], 3)).toEqual(['а', 'б', 'в']);
  });

  it('обрезает до предела', () => {
    expect(fuse([['а', 'б', 'в', 'г']], 2)).toHaveLength(2);
  });

  it('пустые выдачи не ломают слияние', () => {
    expect(fuse([[], []], 5)).toEqual([]);
  });
});
