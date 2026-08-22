import { useEffect, useId, useState } from 'react';
import clsx from 'clsx';

/**
 * Диаграмма mermaid.
 *
 * Сама библиотека весит больше двух мегабайт и грузится динамически — только
 * когда в ответе действительно встретилась диаграмма. Тянуть её в основной
 * бандл ради редкого случая значило бы замедлять запуск приложения всем.
 *
 * Отрисовка идёт с задержкой: во время стрима код диаграммы приходит по
 * кускам и почти всегда синтаксически неполон, а mermaid на такое отвечает
 * красным крестом. Пауза гасит эти промежуточные состояния.
 */
export function Mermaid({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  // Перерисовываем при смене темы: цвета диаграммы запекаются в SVG.
  const theme = useThemeStamp();

  useEffect(() => {
    let alive = true;

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const mermaid = (await import('mermaid')).default;

          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            fontFamily: 'inherit',
            // `base` вместо готовых тем: только он принимает свои цвета
            // целиком. С `dark` диаграмма приходит в чужой серо-белой гамме и
            // выглядит вставленной картинкой, а не частью ответа.
            theme: 'base',
            themeVariables: themeVariables(),
            gantt: GANTT,
          });

          const rendered = await mermaid.render(`mermaid-${id}`, code);
          if (alive) {
            setSvg(naturalSize(rendered.svg));
            setFailed(null);
          }
        } catch (error) {
          if (alive) setFailed((error as Error).message);
        }
      })();
    }, 250);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code, id, theme]);

  // Сломанную диаграмму показываем исходником: это всё-таки ответ модели, и
  // потерять его из-за опечатки в синтаксисе хуже, чем показать как есть.
  if (failed) {
    return (
      <Frame label="диаграмма не построилась" tone="warning">
        <pre className="p-3 text-[12px] font-mono overflow-x-auto scrollbar whitespace-pre">
          {code}
        </pre>
      </Frame>
    );
  }

  if (!svg) {
    return (
      <div className="my-2 rounded-xl border border-border bg-surface px-3 py-4 text-[12px] text-text-dim flex items-center gap-2">
        <i className="bi bi-diagram-3" />
        Строю диаграмму…
      </div>
    );
  }

  const picture = (
    <div
      className="p-3 overflow-x-auto scrollbar flex justify-center"
      // Единственное место, где мы вставляем построенную не нами разметку.
      // У mermaid включён securityLevel: 'strict' — он вырезает скрипты и
      // обработчики событий сам, до того как SVG попадёт сюда.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );

  return (
    <>
      <Frame
        label="диаграмма"
        actions={
          <>
            <Action
              icon="bi-arrows-fullscreen"
              label="Крупнее"
              onClick={() => setZoomed(true)}
            />
            <Action
              icon={showSource ? 'bi-diagram-3' : 'bi-code'}
              label={showSource ? 'Диаграмма' : 'Исходник'}
              onClick={() => setShowSource((v) => !v)}
            />
          </>
        }
      >
        {showSource ? (
          <pre className="p-3 text-[12px] font-mono overflow-x-auto scrollbar whitespace-pre">
            {code}
          </pre>
        ) : (
          picture
        )}
      </Frame>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex flex-col animate-fade-in"
          onClick={() => setZoomed(false)}
        >
          <div className="flex justify-end p-3">
            <button
              type="button"
              className="h-9 px-3 rounded-lg bg-surface border border-border text-[12px] text-text-muted hover:text-text transition-colors flex items-center gap-2"
            >
              <i className="bi bi-x-lg" />
              Закрыть
            </button>
          </div>
          <div
            className="flex-1 min-h-0 overflow-auto scrollbar p-6 flex items-start justify-center"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </>
  );
}

// ─── Оформление ─────────────────────────────────────────────────────────────

function Frame({
  label,
  actions,
  tone,
  children,
}: {
  label: string;
  actions?: React.ReactNode;
  tone?: 'warning';
  children: React.ReactNode;
}) {
  return (
    <div className="my-2 rounded-xl border border-border bg-bg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface-high border-b border-border text-[11px]">
        <span
          className={clsx(
            'uppercase tracking-wider font-mono',
            tone === 'warning' ? 'text-warning' : 'text-text-dim',
          )}
        >
          {tone === 'warning' && <i className="bi bi-exclamation-triangle mr-1.5" />}
          {label}
        </span>
        <span className="flex items-center gap-1">{actions}</span>
      </div>
      {children}
    </div>
  );
}

function Action({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2 py-0.5 rounded bg-bg-hover text-text-muted hover:bg-surface-high hover:text-text transition-colors flex items-center gap-1"
    >
      <i className={clsx('bi', icon)} />
      {label}
    </button>
  );
}

// ─── Тема ───────────────────────────────────────────────────────────────────

/** Строка, меняющаяся при смене темы, — на неё завязана перерисовка. */
function useThemeStamp(): string {
  const [stamp, setStamp] = useState(() => document.documentElement.dataset['theme'] ?? '');

  useEffect(() => {
    const observer = new MutationObserver(() =>
      setStamp(document.documentElement.dataset['theme'] ?? ''),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return stamp;
}

/** Значение переменной темы как готовый цвет. Переменные хранят «R G B». */
function color(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw ? `rgb(${raw.split(/\s+/).join(', ')})` : fallback;
}

/**
 * Палитра диаграммы из переменных темы.
 *
 * Без этого диаграмма приходит в собственной гамме mermaid и читается как
 * чужая картинка, вставленная в ответ: другой фон, другие рамки, другой
 * шрифт. Здесь она собирается из тех же цветов, что и всё остальное
 * приложение, поэтому меняется вместе с темой.
 */
function themeVariables(): Record<string, string> {
  const bg = color('--c-bg', '#0a0a0c');
  const surface = color('--c-surface-2', '#1c1c22');
  const border = color('--c-border-strong', '#40404e');
  const text = color('--c-text', '#f0f0f4');
  const muted = color('--c-text-muted', '#a0a0ac');
  const accent = color('--c-accent', '#f0f0f4');
  const warning = color('--c-warning', '#eaa848');
  const danger = color('--c-danger', '#f05c5c');
  const success = color('--c-success', '#4ac87c');

  return {
    background: bg,
    primaryColor: surface,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: color('--c-surface-3', '#26262e'),
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: color('--c-surface', '#141418'),
    tertiaryTextColor: muted,
    tertiaryBorderColor: border,

    lineColor: color('--c-border-strong', '#40404e'),
    textColor: text,
    mainBkg: surface,
    nodeBorder: border,
    clusterBkg: color('--c-surface', '#141418'),
    clusterBorder: color('--c-border', '#2a2a34'),
    titleColor: text,
    edgeLabelBackground: bg,

    // Последовательности
    actorBkg: surface,
    actorBorder: border,
    actorTextColor: text,
    actorLineColor: color('--c-border', '#2a2a34'),
    signalColor: text,
    signalTextColor: muted,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: border,
    labelTextColor: text,
    loopTextColor: muted,
    noteBkgColor: color('--c-surface-3', '#26262e'),
    noteBorderColor: border,
    noteTextColor: text,

    // Гант
    sectionBkgColor: color('--c-surface', '#141418'),
    sectionBkgColor2: bg,
    altSectionBkgColor: bg,
    taskBkgColor: surface,
    taskBorderColor: border,
    taskTextColor: text,
    taskTextOutsideColor: muted,
    taskTextLightColor: text,
    taskTextDarkColor: text,
    activeTaskBkgColor: accent,
    activeTaskBorderColor: accent,
    doneTaskBkgColor: color('--c-surface-3', '#26262e'),
    doneTaskBorderColor: border,
    critBkgColor: danger,
    critBorderColor: danger,
    gridColor: color('--c-border', '#2a2a34'),
    todayLineColor: warning,

    // Круговая
    pie1: accent,
    pie2: color('--c-text-muted', '#a0a0ac'),
    pie3: success,
    pie4: warning,
    pie5: danger,
    pieTitleTextColor: text,
    pieSectionTextColor: bg,
    pieLegendTextColor: muted,
    pieStrokeColor: bg,
    pieOuterStrokeColor: color('--c-border', '#2a2a34'),
  };
}

/**
 * Размеры диаграммы Ганта.
 *
 * Умолчания mermaid рассчитаны на страницу во весь экран. В ширине колонки
 * чата подписи задач и даты по оси съезжают в нечитаемую сыпь — поэтому шрифт
 * и полосы крупнее, а отступы больше.
 */
const GANTT = {
  fontSize: 13,
  sectionFontSize: 13,
  barHeight: 26,
  barGap: 8,
  topPadding: 52,
  leftPadding: 96,
  gridLineStartPadding: 36,
  useWidth: 1100,
};

/**
 * Вернуть диаграмме её настоящий размер.
 *
 * mermaid отдаёт SVG с `width="100%"` и `max-width` по ширине контейнера. В
 * узкой колонке чата это означает, что широкая диаграмма — Гант, длинная
 * последовательность — ужимается до нечитаемого. Проставляем размеры из
 * viewBox и разрешаем горизонтальную прокрутку: лучше проматывать, чем
 * щуриться.
 */
function naturalSize(svg: string): string {
  // Правим только открывающий тег. Замена по всей строке однажды попала бы в
  // height дочернего прямоугольника и разъехалась бы вся картинка — ошибка,
  // которую увидишь не сразу и не на всех диаграммах.
  const open = /^[\s\S]*?<svg\b[^>]*>/.exec(svg);
  if (!open) return svg;

  const tag = open[0];
  const viewBox = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/.exec(tag);
  if (!viewBox) return svg;

  const width = Math.round(Number(viewBox[1]));
  const height = Math.round(Number(viewBox[2]));

  let fixed = tag
    .replace(/\swidth="[^"]*"/, '')
    .replace(/\sheight="[^"]*"/, '')
    .replace(/\sstyle="[^"]*"/, '')
    .replace(/<svg\b/, `<svg width="${width}" height="${height}" style="max-width:none"`);

  // Совсем узкие диаграммы (одна нода, короткая пирог-схема) в натуральную
  // величину выглядят потерянными — им родная ширина не нужна.
  if (width < 320) fixed = fixed.replace('style="max-width:none"', 'style="max-width:100%"');

  return svg.replace(tag, fixed);
}
