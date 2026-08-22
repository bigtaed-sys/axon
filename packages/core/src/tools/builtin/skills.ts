import { z } from 'zod';
import type { SkillRegistry } from '../../skills/SkillRegistry.js';
import { defineTool, type ToolDefinition } from '../types.js';

/**
 * Вторая половина прогрессивного раскрытия скиллов.
 *
 * Первая — оглавление в системном блоке: имя и одна строка описания на скилл.
 * Эта — способ забрать тело, когда оно понадобилось. Без такого инструмента
 * оглавление было бы издевательством: модель видит, что инструкция есть, и не
 * может её прочитать.
 */
export function createSkillTools(skills: SkillRegistry): ToolDefinition[] {
  const readSkill = defineTool({
    name: 'read_skill',
    title: 'Прочитать инструкцию',
    description:
      'Получить полный текст скилла по имени из оглавления. Вызывай, когда задача ' +
      'совпадает с описанием скилла, — до того, как начнёшь её делать. Инструкция ' +
      'может содержать шаги, ограничения и примеры, которых нет в общем контексте.',
    tier: 'safe',
    source: 'builtin',
    schema: z.object({
      name: z.string().min(1).max(200).describe('Имя скилла ровно как в оглавлении'),
    }),
    async execute({ name }) {
      const skill = skills.byName(name);
      if (!skill || !skills.isEnabled(skill.id)) {
        const available = skills
          .enabled()
          .map((s) => s.name)
          .join(', ');
        return {
          text: available
            ? `Скилла "${name}" нет. Доступны: ${available}`
            : `Скилла "${name}" нет, и других тоже`,
        };
      }
      return { text: `# ${skill.name}\n\n${skill.body}` };
    },
    // Тело скилла — это ровно тот случай, ради которого существует потолок
    // вывода: обрезать инструкцию на середине хуже, чем не дать её вовсе.
    previewLimit: 24_000,
  });

  return [readSkill];
}
