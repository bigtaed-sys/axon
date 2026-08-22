import { describe, expect, it } from 'vitest';
import { compareVersions, formatVersion, parseVersion } from '../src/version.js';

describe('версии сборки', () => {
  it('разбирает релиз и сборку из середины работы', () => {
    expect(parseVersion('2026.8.23')).toMatchObject({ parts: [2026, 8, 23], ahead: 0 });
    expect(parseVersion('v2026.8.23-4-g1a2b3c')).toMatchObject({ parts: [2026, 8, 23], ahead: 4 });
    expect(parseVersion('2026.8.23-dirty')).toMatchObject({ ahead: 0, dirty: true });
  });

  it('коммиты после тега — новее тега, а не старее', () => {
    // Semver прочитал бы «-4» как предрелиз и поставил бы эту сборку ДО тега.
    // У нас суффикс означает обратное: столько коммитов сделано после.
    expect(compareVersions('2026.8.23-4-g1a2b3c', '2026.8.23')).toBe(1);
    expect(compareVersions('2026.8.23', '2026.8.23-4-g1a2b3c')).toBe(-1);
  });

  it('сравнивает по годам и месяцам', () => {
    expect(compareVersions('2026.8.23', '2026.9.1')).toBe(-1);
    expect(compareVersions('2026.9.1', '2026.8.23')).toBe(1);
    expect(compareVersions('2026.8.23', '2026.8.23')).toBe(0);
  });

  it('сборку без тегов не считает ни старой, ни новой', () => {
    // Иначе предупреждение горело бы всё время разработки — а горящее всегда
    // перестают замечать.
    expect(compareVersions('0.0.0-dev+1a2b3c', '2026.8.23')).toBe(0);
    expect(compareVersions('2026.8.23', 'непонятно что')).toBe(0);
  });

  it('показывает человеку коротко', () => {
    expect(formatVersion('2026.8.23')).toBe('v2026.8.23');
    expect(formatVersion('2026.8.23-4-g1a2b3c')).toBe('v2026.8.23 +4');
    expect(formatVersion('2026.8.23-dirty')).toBe('v2026.8.23 (с правками)');
  });
});
