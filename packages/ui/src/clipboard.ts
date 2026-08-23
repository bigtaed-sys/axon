/**
 * Скопировать текст.
 *
 * `navigator.clipboard` браузер отдаёт только защищённому источнику. Окно
 * приложения на телефоне живёт на обычном http — иначе оно не может
 * разговаривать с ядром, у которого TLS нет намеренно, — и там этого пути
 * просто не существует.
 *
 * Поэтому запасной ход через скрытое поле и старую команду копирования:
 * устаревшую, но работающую везде. Кнопка «скопировать» — не та вещь, ради
 * которой стоит ломать подключение.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Разрешения нет или источник незащищённый — пробуем по-старому.
  }

  try {
    const field = document.createElement('textarea');
    field.value = text;
    // Поле должно быть в документе и доступным для выделения, но невидимым.
    // `display: none` тут не годится: из скрытого поля копировать нечего.
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    field.style.pointerEvents = 'none';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(field);
    return copied;
  } catch {
    return false;
  }
}
