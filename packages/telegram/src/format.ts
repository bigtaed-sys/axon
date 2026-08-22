/**
 * Markdown ответа → разметка телеграма.
 *
 * Телеграм понимает крошечное подмножество HTML: жирный, курсив, зачёркнутый,
 * моноширинный, блок кода, ссылка, цитата. Ни заголовков, ни списков, ни
 * таблиц. Отдать ему markdown как есть — значит показать человеку `**жирный**`
 * звёздочками и `### Заголовок` решётками; отдать с `parse_mode: Markdown` —
 * получить отказ на первом же символе `_` внутри имени переменной.
 *
 * Поэтому переводим сами и в HTML, а не в MarkdownV2: у MarkdownV2 экранировать
 * нужно восемнадцать символов, включая точку и дефис, и любая пропущенная
 * приводит к отказу всего сообщения. В HTML экранируются три.
 *
 * То, чего в телеграме нет, не выбрасывается, а превращается в ближайшее
 * читаемое: заголовок — жирная строка, список — строка с маркером. Потерять
 * структуру хуже, чем показать её беднее.
 */

/** Потолок телеграма на одно сообщение. */
const LIMIT = 4096;

/** С запасом: закрывающие теги при разрезе дописываются к куску. */
const SAFE = LIMIT - 64;

export function toTelegramHtml(markdown: string): string {
  const out: string[] = [];
  const lines = markdown.split('\n');

  let inFence = false;
  let fenceLanguage = '';
  let fenceBody: string[] = [];

  for (const line of lines) {
    const fence = /^\s*```(.*)$/.exec(line);

    if (fence) {
      if (inFence) {
        out.push(closeFence(fenceBody, fenceLanguage));
        inFence = false;
        fenceBody = [];
      } else {
        inFence = true;
        fenceLanguage = (fence[1] ?? '').trim();
      }
      continue;
    }

    if (inFence) {
      fenceBody.push(line);
      continue;
    }

    out.push(block(line));
  }

  // Незакрытый блок кода — обычное дело в оборванном ответе. Закрываем сами:
  // иначе телеграм отвергнет сообщение целиком за незакрытый тег.
  if (inFence) out.push(closeFence(fenceBody, fenceLanguage));

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function closeFence(body: string[], language: string): string {
  const code = escape(body.join('\n'));
  return language
    ? `<pre><code class="language-${escape(language)}">${code}</code></pre>`
    : `<pre>${code}</pre>`;
}

/** Блочная разметка: то, что определяется началом строки. */
function block(line: string): string {
  const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return `<b>${inline(heading[2] ?? '')}</b>`;

  // Горизонтальная черта: в телеграме её нет, а пустая строка читается лучше,
  // чем три дефиса посреди текста.
  if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) return '';

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1] ?? ''}• ${inline(bullet[2] ?? '')}`;

  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) return `${numbered[1] ?? ''}${numbered[2]}. ${inline(numbered[3] ?? '')}`;

  const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
  if (quote) return `<blockquote>${inline(quote[1] ?? '')}</blockquote>`;

  return inline(line);
}

/**
 * Строчная разметка.
 *
 * Порядок важен: сначала выкусываем моноширинные куски и подменяем их
 * заглушками, потом размечаем всё остальное, потом возвращаем на место. Иначе
 * `**` внутри `код` станет жирным, а звёздочки в примере кода исчезнут.
 */
function inline(text: string): string {
  const code: string[] = [];
  let work = text.replace(/`([^`]+)`/g, (_, body: string) => {
    code.push(`<code>${escape(body)}</code>`);
    // Заглушка из символов, которых не бывает в тексте и которых не касается
    // экранирование. Номер в пробелах не годился: строка вида «шаг 1 готов»
    // подставила бы на месте единицы чужой кусок кода.
    return `\u0000${code.length - 1}\u0000`;
  });

  work = escape(work);

  // Ссылка целиком, до жирного: иначе `**` внутри подписи разорвёт разметку.
  work = work.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, href: string) => {
    return `<a href="${href}">${label}</a>`;
  });

  work = work.replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>');
  work = work.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  work = work.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  work = work.replace(/(^|[\s(])_([^_\n]+)_/g, '$1<i>$2</i>');
  work = work.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  return work.replace(/\u0000(\d+)\u0000/g, (_, index: string) => code[Number(index)] ?? '');
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Разрезать длинный ответ на сообщения.
 *
 * Режем по границам: сначала пробуем абзац, потом строку, и только если один
 * абзац сам длиннее предела — по символам. Разрез посреди строки читается как
 * сбой связи, а не как продолжение.
 *
 * Блок кода не разрывается: если он не помещается, кусок закрывается своим
 * `</pre>`, а следующий открывается новым. Иначе телеграм отвергнет обе
 * половины за незакрытый тег.
 */
export function split(html: string, limit = SAFE): string[] {
  if (html.length <= limit) return [html];

  const parts: string[] = [];
  let rest = html;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;

    parts.push(balance(rest.slice(0, cut)));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }

  if (rest.trim()) parts.push(rest);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Дописать закрывающий `</pre>`, если разрез пришёлся внутрь блока кода. */
function balance(chunk: string): string {
  const open = (chunk.match(/<pre>|<pre><code[^>]*>/g) ?? []).length;
  const closed = (chunk.match(/<\/pre>/g) ?? []).length;
  if (open <= closed) return chunk;

  return chunk.includes('<code') ? `${chunk}</code></pre>` : `${chunk}</pre>`;
}
