import { defaultSchema } from 'rehype-sanitize';
import type { Options } from 'rehype-sanitize';

/**
 * Что разрешено из HTML внутри ответа модели.
 *
 * Список белый, а не чёрный, и это принципиально: агент читает чужие файлы и
 * веб-страницы, и всё, что он оттуда принёс, доходит сюда почти дословно.
 * Чёрный список пришлось бы обновлять каждый раз, когда кто-то придумает
 * новый способ выполнить скрипт из атрибута; белый по умолчанию запрещает всё.
 *
 * Основа — схема rehype-sanitize (GitHub-совместимая). Мы добавляем только то,
 * ради чего HTML в разметке вообще пишут: раскрывающиеся блоки, выравнивание,
 * переносы, подстрочные и надстрочные знаки. И отдельно — классы и атрибуты,
 * без которых не работают подсветка кода и формулы, потому что их плагины
 * дописывают разметку уже после нас.
 */
export const SANITIZE_SCHEMA: Options = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'details',
    'summary',
    'kbd',
    'mark',
    'ins',
    'abbr',
    'figure',
    'figcaption',
    // KaTeX печатает формулу деревом span'ов и, при выводе mathml, тегами math.
    'math',
    'semantics',
    'mrow',
    'mi',
    'mo',
    'mn',
    'msup',
    'msub',
    'mfrac',
    'msqrt',
    'annotation',
  ],
  attributes: {
    ...defaultSchema.attributes,
    // `align` — единственный способ выровнять текст без style, а style мы не
    // пускаем: через него уходит и фон с чужой картинкой, и перекрытие окна.
    div: [...(defaultSchema.attributes?.['div'] ?? []), 'align'],
    p: [...(defaultSchema.attributes?.['p'] ?? []), 'align'],
    h1: ['align'],
    h2: ['align'],
    h3: ['align'],
    details: ['open'],
    // Ячейкам таблицы выравнивание проставляет сам remark-gfm — через style.
    // Это наша собственная разметка, а не текст модели, и здесь она безопасна.
    th: [...(defaultSchema.attributes?.['th'] ?? []), 'style'],
    td: [...(defaultSchema.attributes?.['td'] ?? []), 'style'],
    span: [...(defaultSchema.attributes?.['span'] ?? []), 'className', 'style'],
    code: [...(defaultSchema.attributes?.['code'] ?? []), 'className'],
    section: [...(defaultSchema.attributes?.['section'] ?? []), 'className'],
    li: [...(defaultSchema.attributes?.['li'] ?? []), 'className'],
    input: ['type', 'checked', 'disabled'],
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className'],
  },
  // Протоколы ссылок: без ограничения сюда пролезает javascript: в href.
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data', 'blob'],
  },
};
