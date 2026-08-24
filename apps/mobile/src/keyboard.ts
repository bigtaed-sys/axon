import { useEffect, useState } from 'react';

/**
 * Открыта ли экранная клавиатура.
 *
 * Спрашиваем не систему, а окно: `visualViewport` — это видимая часть
 * страницы, и клавиатура откусывает от неё половину. Никакого плагина для
 * этого не нужно, а значит и лишней зависимости.
 *
 * Нужно затем, что островок разделов висит внизу. Пока человек печатает, он
 * оказывается ровно между полем ввода и клавиатурой — занимает место там, где
 * его и так нет, и переключать разделы посреди набора никто не собирается.
 */
export function useKeyboard(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const check = (): void => {
      // Порог, а не точное сравнение: панель жестов и адресная строка тоже
      // меняют высоту на десятки пикселей, и принимать их за клавиатуру
      // означало бы мигать островком на ровном месте.
      setOpen(window.innerHeight - viewport.height > 160);
    };

    check();
    viewport.addEventListener('resize', check);
    return () => viewport.removeEventListener('resize', check);
  }, []);

  return open;
}
