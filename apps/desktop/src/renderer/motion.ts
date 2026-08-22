import { useCallback, useEffect, useState } from 'react';

export type MotionId = 'full' | 'off';

const STORAGE_KEY = 'axon.motion';

/**
 * Насколько живо двигается интерфейс.
 *
 * Управляется атрибутом `data-motion` на `<html>` — тем же приёмом, что и
 * тема. Один атрибут гасит вообще всё: переходы между экранами, появление
 * сообщений, диаграмму в визарде. Расставлять проверки по компонентам значило
 * бы, что однажды где-то забудут, и «анимации выключены» окажется неправдой.
 *
 * По умолчанию слушаем систему: у человека, попросившего ОС не двигать
 * интерфейс, для этого обычно есть причина — от укачивания до эпилепсии.
 */
export function useMotion(): { motion: MotionId; setMotion: (motion: MotionId) => void } {
  const [motion, setState] = useState<MotionId>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as MotionId | null;
    if (saved) return saved;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'full';
  });

  useEffect(() => {
    document.documentElement.dataset['motion'] = motion;
  }, [motion]);

  const setMotion = useCallback((next: MotionId) => {
    localStorage.setItem(STORAGE_KEY, next);
    setState(next);
  }, []);

  return { motion, setMotion };
}
