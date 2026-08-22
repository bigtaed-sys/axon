import fs from 'node:fs';
import path from 'node:path';
import type { SkillInfo } from '@axon/protocol';
import { estimateTokens } from '../agent/tokens.js';

/** Где хранится список выключенных скиллов. */
export const DISABLED_SKILLS_SETTING = 'skills.disabled';

export interface Skill {
  id: string;
  pluginId: string;
  name: string;
  description: string;
  body: string;
  tokens: number;
}

/**
 * Скиллы — инструкции текстом.
 *
 * Ключевая идея и вся причина, по которой это отдельная подсистема, а не
 * «допишите в системный промпт»: раскрытие происходит в два шага. В контексте
 * постоянно висит только строчка «есть скилл X, он про Y» — десяток токенов.
 * Тело скилла, которое может быть на пять страниц, модель забирает сама
 * инструментом `read_skill`, и только когда оно правда понадобилось.
 *
 * Разница на практике: двадцать поставленных скиллов стоят ~300 токенов в
 * каждом запросе вместо ~20 000. Это тот же приём, что и `deferred` у
 * инструментов, применённый к знаниям вместо действий.
 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly disabled: Set<string>;

  constructor(disabled: Iterable<string> = []) {
    this.disabled = new Set(disabled);
  }

  add(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  /** Убрать все скиллы плагина — при его выгрузке. */
  removeByPlugin(pluginId: string): void {
    for (const [id, skill] of this.skills) {
      if (skill.pluginId === pluginId) this.skills.delete(id);
    }
  }

  get(id: string): Skill | null {
    return this.skills.get(id) ?? null;
  }

  /** Найти по имени — модель зовёт скилл именем, а не внутренним id. */
  byName(name: string): Skill | null {
    const needle = name.trim().toLowerCase();
    for (const skill of this.skills.values()) {
      if (skill.name.toLowerCase() === needle || skill.id.toLowerCase() === needle) return skill;
    }
    return null;
  }

  list(pluginId?: string): SkillInfo[] {
    return [...this.skills.values()]
      .filter((skill) => !pluginId || skill.pluginId === pluginId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tokens: skill.tokens,
        enabled: this.isEnabled(skill.id),
      }));
  }

  enabled(): Skill[] {
    return [...this.skills.values()]
      .filter((skill) => this.isEnabled(skill.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  isEnabled(id: string): boolean {
    return !this.disabled.has(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(id);
    else this.disabled.add(id);
  }

  disabledIds(): string[] {
    return [...this.disabled].sort();
  }

  /**
   * Оглавление для системного блока. Стабильно по составу и порядку — иначе
   * оно ломало бы кэш промпта при каждой перезагрузке плагина.
   */
  catalogText(): string | null {
    const skills = this.enabled();
    if (skills.length === 0) return null;

    const lines = skills.map((skill) => `- ${skill.name} — ${skill.description}`);
    return [
      'Доступные инструкции (скиллы). Это оглавление, а не сами инструкции.',
      'Если задача похожа на описание — сначала прочитай скилл через read_skill, потом делай.',
      ...lines,
    ].join('\n');
  }
}

// ─── Чтение с диска ─────────────────────────────────────────────────────────

/**
 * Прочитать скиллы из папки плагина. Файл `*.md` со шляпкой:
 *
 * ```
 * ---
 * name: Разбор логов
 * description: Как искать причину падения в логах сборки
 * ---
 * ```
 *
 * Без шляпки скилл тоже возьмётся: имя — из имени файла, описание — из первой
 * непустой строки. Требовать frontmatter значило бы отсекать самый частый
 * способ появления скилла — «положил заметку в папку».
 */
export function readSkillsFromDir(dir: string, pluginId: string): Skill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: Skill[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;

    const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    const { meta, body } = splitFrontmatter(raw);
    const base = entry.name.replace(/\.md$/i, '');

    skills.push({
      id: `${pluginId}/${base}`,
      pluginId,
      name: meta['name'] ?? base,
      description: meta['description'] ?? firstLine(body),
      body,
      tokens: estimateTokens(body),
    });
  }
  return skills;
}

/**
 * Разбор шляпки. Намеренно не YAML: тянуть парсер ради `ключ: значение` в
 * четырёх строках — плохой обмен, а полный YAML в скиллах никому не нужен.
 */
function splitFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return { meta: {}, body: text.trim() };

  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text.trim() };

  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) meta[key] = value;
  }

  const bodyStart = text.indexOf('\n', end + 1);
  return { meta, body: bodyStart < 0 ? '' : text.slice(bodyStart + 1).trim() };
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'));
  return (line ?? '').trim().slice(0, 200);
}
