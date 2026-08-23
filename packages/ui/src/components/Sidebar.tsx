import clsx from 'clsx';

export type Screen =
  | 'chat'
  | 'memory'
  | 'tools'
  | 'plugins'
  | 'routines'
  | 'usage'
  | 'devices'
  | 'settings'
  | 'connect'
  | 'setup';

interface NavItem {
  id: Screen;
  label: string;
  icon: string;
}

/**
 * Пункты сгруппированы и разделены тонкой линией: пользователь видит
 * смысловые кластеры, а не сплошной столбик иконок.
 */
const NAV_GROUPS: NavItem[][] = [
  [
    { id: 'chat', label: 'Чаты', icon: 'bi-chat-dots-fill' },
    { id: 'routines', label: 'Рутины', icon: 'bi-clock-history' },
    { id: 'memory', label: 'Память', icon: 'bi-journal-bookmark-fill' },
  ],
  [
    { id: 'tools', label: 'Инструменты', icon: 'bi-tools' },
    { id: 'plugins', label: 'Плагины', icon: 'bi-puzzle-fill' },
    { id: 'usage', label: 'Расход', icon: 'bi-graph-up' },
  ],
];

const NAV_BOTTOM: NavItem[] = [
  { id: 'devices', label: 'Устройства', icon: 'bi-hdd-network' },
  { id: 'settings', label: 'Настройки', icon: 'bi-gear-fill' },
];

/**
 * Геометрия панели.
 *
 * Свёрнутая ширина считается, а не подбирается: 8 отступа + 40 колонка
 * иконки + 8 отступа. Благодаря этому иконка при разворачивании стоит на
 * месте до пикселя — едет только правый край панели, а подпись проявляется
 * в освободившемся месте.
 */
const COLLAPSED = 56;
const EXPANDED = 200;

export function Sidebar({
  screen,
  expanded,
  onSelect,
  onToggle,
}: {
  screen: Screen;
  expanded: boolean;
  onSelect: (screen: Screen) => void;
  onToggle: () => void;
}) {
  return (
    <nav
      style={{ width: expanded ? EXPANDED : COLLAPSED }}
      className="bg-surface border-r border-border flex flex-col py-3 gap-1 px-2 shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
    >
      <Item
        icon={expanded ? 'bi-layout-sidebar-inset' : 'bi-layout-sidebar'}
        label="Свернуть"
        expanded={expanded}
        onClick={onToggle}
      />

      {NAV_GROUPS.map((group, index) => (
        <div
          key={index}
          className={clsx('flex flex-col gap-1', index > 0 && 'mt-2 pt-2 border-t border-border/60')}
        >
          {group.map((item) => (
            <Item
              key={item.id}
              icon={item.icon}
              label={item.label}
              expanded={expanded}
              active={screen === item.id}
              onClick={() => onSelect(item.id)}
            />
          ))}
        </div>
      ))}

      <div className="flex-1" />

      <div className="flex flex-col gap-1 pt-2 border-t border-border/60">
        {NAV_BOTTOM.map((item) => (
          <Item
            key={item.id}
            icon={item.icon}
            label={item.label}
            expanded={expanded}
            active={screen === item.id}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </div>
    </nav>
  );
}

/**
 * Пункт устроен так, чтобы при сворачивании менялась ровно одна величина —
 * ширина панели.
 *
 * Иконка живёт в колонке фиксированной ширины и одного размера в обоих
 * состояниях: раньше она прыгала с `text-lg` на обычный кегль, и глаз ловил
 * этот скачок сильнее, чем само движение. Подпись не размонтируется, а
 * проявляется прозрачностью и обрезается панелью, — поэтому текст не
 * возникает рывком посреди анимации.
 */
function Item({
  icon,
  label,
  expanded,
  active = false,
  onClick,
}: {
  icon: string;
  label: string;
  expanded: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={expanded ? undefined : label}
      className={clsx(
        'h-10 w-full rounded-xl flex items-center transition-colors duration-150',
        active
          ? 'bg-bg-hover text-accent font-medium'
          : 'text-text-muted hover:bg-bg-hover hover:text-text',
      )}
    >
      <span className="w-10 shrink-0 flex items-center justify-center">
        <i className={clsx('bi', icon, 'text-[17px]')} />
      </span>

      <span
        className={clsx(
          // Разворачиваясь, ждём, пока появится место, и только потом
          // проявляем текст; сворачиваясь — гасим сразу, чтобы он не
          // выползал за край.
          'text-[13px] whitespace-nowrap transition-opacity duration-150',
          expanded ? 'opacity-100 delay-100' : 'opacity-0 delay-0',
        )}
      >
        {label}
      </span>
    </button>
  );
}
