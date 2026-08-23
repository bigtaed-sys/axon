import fs from 'node:fs';
import path from 'node:path';

/**
 * Плагин «Ленты»: следит за RSS и приносит агенту свежие заголовки.
 *
 * Написан не как учебный пример, а как рабочая вещь — и заодно как проверка
 * того, удобен ли SDK. Задействует всё сразу: инструмент, вклад в промпт,
 * задачу по расписанию, разделы и кнопки на странице настроек.
 *
 * Зависимостей нет. Разбор RSS сделан регулярками, и это осознанно: настоящий
 * XML-парсер тянул бы пакет ради трёх полей — заголовка, ссылки и даты. Ленты
 * в природе кривые, но кривые предсказуемо, и на этих трёх полях регулярки
 * ошибаются реже, чем стоят.
 */

/** Сколько ждать ленту. Дольше — значит она и не ответит. */
const TIMEOUT_MS = 15_000;

export async function activate(api) {
  const storePath = path.join(api.dataDir, 'items.json');

  /** Накопленные записи: свежие сверху, без повторов по ссылке. */
  let items = read(storePath, api);

  const settings = () => ({
    urls: String(api.settings.get('urls') ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    limit: Number(api.settings.get('limit') ?? 30),
    inPrompt: Boolean(api.settings.get('inPrompt')),
    promptCount: Number(api.settings.get('promptCount') ?? 5),
  });

  /**
   * Обойти все ленты и слить новое с накопленным.
   *
   * Возвращает отчёт по каждой ленте — он нужен и кнопке «проверить сейчас»,
   * и логу задачи. Одна упавшая лента не отменяет остальных: чаще всего это
   * временный отказ сайта, а не повод оставить человека вовсе без новостей.
   */
  async function refresh() {
    const { urls, limit } = settings();
    if (urls.length === 0) return { report: ['Ленты не заданы'], added: 0 };

    const report = [];
    const fresh = [];

    for (const url of urls) {
      try {
        const parsed = await fetchFeed(url);
        fresh.push(...parsed.items);
        report.push(`${parsed.title || host(url)}: ${parsed.items.length}`);
      } catch (error) {
        report.push(`${host(url)}: не ответила (${error.message})`);
      }
    }

    const known = new Set(items.map((item) => item.link));
    const added = fresh.filter((item) => item.link && !known.has(item.link));

    items = [...added, ...items]
      .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      .slice(0, Math.max(1, limit));

    fs.writeFileSync(storePath, JSON.stringify(items), 'utf8');
    return { report, added: added.length };
  }

  // ─── Инструмент ───────────────────────────────────────────────────────────

  await api.tools.register({
    name: 'latest',
    title: 'Свежие заголовки',
    description:
      'Показать последние заголовки из лент, за которыми следит пользователь. ' +
      'Вызывай, когда спрашивают «что нового», «есть ли новости» или просят ' +
      'пересказать ленту.',
    tier: 'safe',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Сколько заголовков вернуть, по умолчанию 10' },
      },
    },
    execute: async (args) => {
      if (items.length === 0) {
        const { report } = await refresh();
        if (items.length === 0) return `Пока ничего нет. ${report.join('; ')}`;
      }

      const count = Math.min(Number(args.count ?? 10), items.length);
      return items
        .slice(0, count)
        .map((item) => `${item.title}\n${item.link}`)
        .join('\n\n');
    },
  });

  // ─── Вклад в промпт ───────────────────────────────────────────────────────

  /**
   * Изменчивый вклад, а не стабильный.
   *
   * Заголовки меняются каждый час. Положи их в системный блок — и кэш промпта
   * будет обнуляться при каждом обновлении лент, то есть человек заплатит за
   * весь контекст заново ради пяти строк новостей.
   */
  await api.context.contribute('свежие новости', 'volatile', () => {
    const { inPrompt, promptCount } = settings();
    if (!inPrompt || items.length === 0) return null;

    const lines = items.slice(0, promptCount).map((item) => `- ${item.title}`);
    return `Свежее в лентах, за которыми следит человек:\n${lines.join('\n')}`;
  });

  // ─── Задача и кнопки ──────────────────────────────────────────────────────

  api.jobs.on('обновление', async () => {
    const { report, added } = await refresh();
    api.log.info('ленты обновлены', { added, report: report.join('; ') });
  });

  api.actions.on('refresh', async () => {
    const { report, added } = await refresh();
    return `Новых: ${added}. ${report.join('; ')}`;
  });

  api.actions.on('forget', async () => {
    items = [];
    fs.rmSync(storePath, { force: true });
    return 'Накопленное удалено';
  });
}

// ─── Разбор ленты ───────────────────────────────────────────────────────────

async function fetchFeed(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: abort.signal,
      headers: { 'user-agent': 'Axon feeds plugin' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parse(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Достать заголовки из RSS или Atom.
 *
 * Оба формата описывают запись по-разному, но пересекаются в том, что нам
 * нужно: заголовок, ссылка, дата. Поэтому разбираем оба одним проходом, а не
 * определяем формат заранее — определение всё равно свелось бы к тем же
 * проверкам.
 */
function parse(xml) {
  const title = tag(xml, 'title');
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)].map((match) => match[0]);

  const items = blocks.map((block) => ({
    title: clean(tag(block, 'title')),
    link: link(block),
    at: normalizeDate(tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'published')),
  }));

  return { title: clean(title), items: items.filter((item) => item.title) };
}

function tag(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return match?.[1]?.trim() ?? '';
}

/** В RSS ссылка — текст тега, в Atom — атрибут `href`. */
function link(block) {
  const atom = /<link\b[^>]*href=["']([^"']+)["']/i.exec(block);
  if (atom?.[1]) return atom[1];
  return clean(tag(block, 'link'));
}

function clean(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Дата к сравнимому виду. Неразобранная — пустая: пусть уйдёт вниз списка. */
function normalizeDate(raw) {
  const at = Date.parse(raw);
  return Number.isNaN(at) ? '' : new Date(at).toISOString();
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Прочитать накопленное. Битый файл — не повод не работать: начнём заново. */
function read(file, api) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    api.log.debug('накопленного нет, начинаю с пустого');
    return [];
  }
}
