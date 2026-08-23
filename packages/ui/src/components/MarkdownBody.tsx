import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import clsx from 'clsx';
import { Mermaid } from './Mermaid.js';
import { SANITIZE_SCHEMA } from './markdown-schema.js';

/**
 * Рендер Markdown в сообщениях агента.
 *
 * Порядок плагинов здесь не декоративный, а защитный: `rehype-raw` разбирает
 * HTML из текста модели, и сразу за ним идёт `rehype-sanitize`, который
 * вычищает всё, кроме разрешённого списка тегов. Ослабить это нельзя: агент
 * читает чужие файлы и веб-страницы, а значит содержимое чужого документа
 * доходит сюда почти без изменений. Подсветка и формулы работают уже по
 * очищенному дереву — иначе они бы вернули в разметку то, что мы только что
 * вырезали.
 *
 * Во время стрима текст перерисовывается на каждую дельту. Разбор Markdown
 * этого не замечает, а вот диаграммы строятся с задержкой — см. Mermaid.
 */
export const MarkdownBody = memo(function MarkdownBody({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={clsx('msg-body', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, SANITIZE_SCHEMA],
          [rehypeKatex, { output: 'html', throwOnError: false, errorColor: 'inherit' }],
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
        ]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

const COMPONENTS: Components = {
  a({ href, children, ...rest }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"
        {...rest}
      >
        {children}
      </a>
    );
  },
  img({ src, alt, title }) {
    return (
      <Picture
        src={typeof src === 'string' ? src : ''}
        alt={alt ?? ''}
        {...(title ? { title } : {})}
      />
    );
  },
  p({ children }) {
    return <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>;
  },
  h1({ children }) {
    return <h1 className="text-[18px] font-semibold mt-3 mb-2 first:mt-0">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-[16px] font-semibold mt-3 mb-1.5 first:mt-0">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-[15px] font-semibold mt-2.5 mb-1 first:mt-0">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="text-[13.5px] font-semibold mt-2 mb-1 first:mt-0">{children}</h4>;
  },
  ul({ children }) {
    return <ul className="list-disc pl-5 my-1.5 space-y-0.5">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal pl-5 my-1.5 space-y-0.5">{children}</ol>;
  },
  li({ children, className }) {
    // Пункт списка задач от remark-gfm приходит со своим классом и чекбоксом:
    // маркер ему не нужен, иначе рядом с галочкой висит ещё и точка.
    const task = /task-list-item/.test(className ?? '');
    return <li className={clsx('leading-relaxed', task && 'list-none -ml-5 pl-0')}>{children}</li>;
  },
  input({ checked, type }) {
    if (type !== 'checkbox') return null;
    return (
      <span
        className={clsx(
          'inline-flex w-3.5 h-3.5 mr-1.5 rounded border align-[-2px] items-center justify-center',
          checked ? 'bg-accent border-accent text-accent-fg' : 'border-border',
        )}
      >
        {checked && <i className="bi bi-check text-[10px]" />}
      </span>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-accent/50 pl-3 my-2 text-text-muted italic">
        {children}
      </blockquote>
    );
  },
  hr() {
    return <hr className="my-3 border-0 border-t border-border" />;
  },
  strong({ children }) {
    return <strong className="font-semibold">{children}</strong>;
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  del({ children }) {
    return <del className="line-through text-text-muted">{children}</del>;
  },
  kbd({ children }) {
    return (
      <kbd className="px-1.5 py-0.5 rounded border border-border bg-surface-high font-mono text-[0.85em]">
        {children}
      </kbd>
    );
  },
  details({ children }) {
    return (
      <details className="my-2 rounded-xl border border-border bg-surface px-3 py-2 [&[open]>summary]:mb-2">
        {children}
      </details>
    );
  },
  summary({ children }) {
    return (
      <summary className="cursor-pointer select-none text-[13px] font-medium marker:text-text-dim">
        {children}
      </summary>
    );
  },
  code({ className, children, ...props }) {
    const inline = !/\blanguage-|\bhljs\b/.test(className ?? '') && !String(children).includes('\n');
    if (inline) {
      return (
        <code
          className="px-1.5 py-0.5 rounded bg-surface-high text-accent font-mono text-[0.88em] border border-border"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={clsx('font-mono text-[12.5px] block', className)} {...props}>
        {children}
      </code>
    );
  },
  pre({ children }) {
    const { code, lang } = extractCode(children);
    // Диаграмма — не код, а картинка: показывать её текстом бессмысленно,
    // когда мы умеем её нарисовать.
    if (lang === 'mermaid') return <Mermaid code={code} />;
    return (
      <CodeBlock lang={lang} code={code}>
        {children}
      </CodeBlock>
    );
  },
  // У таблицы должна быть видна сетка, а не только полоски строк: без
  // вертикальных границ колонки сливаются, и таблица читается как каша.
  table({ children }) {
    return (
      <div className="my-2.5 overflow-x-auto scrollbar rounded-xl border border-border">
        <table className="w-full text-[13px] border-collapse">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-surface-high">{children}</thead>;
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  tr({ children }) {
    return <tr className="border-b border-border last:border-b-0">{children}</tr>;
  },
  th({ children, style }) {
    return (
      <th
        style={style}
        className="px-3 py-2 text-left font-semibold border-r border-border last:border-r-0 whitespace-nowrap"
      >
        {children}
      </th>
    );
  },
  td({ children, style }) {
    return (
      <td style={style} className="px-3 py-2 align-top border-r border-border last:border-r-0">
        {children}
      </td>
    );
  },
  section({ children, className, ...rest }) {
    // Сноски remark-gfm складывает в отдельную секцию в конце сообщения.
    const footnotes = /footnotes/.test(className ?? '');
    return (
      <section
        className={clsx(
          className,
          footnotes && 'mt-4 pt-3 border-t border-border text-[12px] text-text-muted',
        )}
        {...rest}
      >
        {children}
      </section>
    );
  },
  sup({ children }) {
    return <sup className="text-[0.7em] align-super">{children}</sup>;
  },
};

/**
 * Картинка в ответе модели.
 *
 * Внешние адреса не загружаются, и это не перестраховка: агент читает чужие
 * страницы и файлы, а `![](http://чужой-сервер/пиксель.png)` в таком тексте —
 * готовый маячок, который сообщит, что письмо прочитали, ещё и с IP. Поэтому
 * удалённая картинка показывается карточкой с адресом и открывается в браузере
 * по явному нажатию. Локальные (`data:`, `blob:`) рисуются как есть — они уже
 * у нас.
 */
function Picture({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const local = /^(data:|blob:)/i.test(src);
  const [broken, setBroken] = useState(false);

  if (local && !broken) {
    return (
      <img
        src={src}
        alt={alt}
        title={title}
        onError={() => setBroken(true)}
        className="my-2 max-w-full rounded-xl border border-border"
      />
    );
  }

  let host = src;
  try {
    host = new URL(src).host || src;
  } catch {
    // Не URL — покажем как есть, обрезав.
  }

  return (
    <a
      href={/^https?:/i.test(src) ? src : undefined}
      target="_blank"
      rel="noreferrer"
      title={src}
      className="my-2 inline-flex items-center gap-2.5 px-3 py-2 rounded-xl border border-border bg-surface text-[12px] text-text-muted hover:border-border-strong transition-colors max-w-full"
    >
      <i className={clsx('bi text-accent', broken ? 'bi-image-alt' : 'bi-image')} />
      <span className="min-w-0">
        <span className="block truncate">{alt || 'изображение'}</span>
        <span className="block text-[10px] text-text-dim truncate">
          {broken ? 'не загрузилось' : `${host.slice(0, 60)} · открыть в браузере`}
        </span>
      </span>
    </a>
  );
}

/** Внутри `<pre>` лежит один `<code>` — достаём из него текст и язык. */
function extractCode(children: ReactNode): { code: string; lang: string | null } {
  let code = '';
  let lang: string | null = null;

  const visit = (node: ReactNode): void => {
    if (node == null || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      code += String(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node === 'object' && 'props' in node) {
      const props = (node as { props?: { className?: string; children?: ReactNode } }).props ?? {};
      if (props.className && !lang) {
        const match = /language-([\w-]+)/.exec(props.className);
        if (match) lang = match[1]!;
      }
      visit(props.children);
    }
  };

  visit(children);
  return { code, lang };
}

function CodeBlock({
  lang,
  code,
  children,
}: {
  lang: string | null;
  code: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // В некоторых контекстах буфер обмена недоступен — молча ничего не делаем.
    }
  };

  return (
    <div className="my-2 rounded-xl border border-border bg-bg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-high border-b border-border text-[11px]">
        <span className="uppercase tracking-wider text-text-dim font-mono">{lang ?? 'code'}</span>
        <button
          type="button"
          onClick={() => void copy()}
          title="Скопировать"
          className={clsx(
            'px-2 py-0.5 rounded flex items-center gap-1 transition-colors',
            copied
              ? 'bg-success/15 text-success'
              : 'bg-bg-hover text-text-muted hover:bg-surface-high hover:text-text',
          )}
        >
          <i className={clsx('bi', copied ? 'bi-check2' : 'bi-clipboard')} />
          {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <pre className="!m-0 !border-0 !rounded-none !bg-transparent p-3 overflow-x-auto scrollbar">
        {children}
      </pre>
    </div>
  );
}
