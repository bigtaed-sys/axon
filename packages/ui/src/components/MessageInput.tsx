import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import type { ContentPart } from '@axon/protocol';

const MAX_HEIGHT = 200;

/** Что уже загружено в ядро и ждёт отправки вместе с текстом. */
interface Attachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  /** Ссылка на блоб; для картинок по ней же рисуется превью. */
  blobId: string;
  /** Пока грузится — блоба ещё нет. */
  pending: boolean;
  error?: string;
  /** Локальный предпросмотр, доступный до конца загрузки. */
  preview?: string;
}

export function MessageInput({
  disabled,
  streaming,
  client,
  seesImages,
  onSend,
  onCancel,
  onOpenSettings,
}: {
  disabled: boolean;
  streaming: boolean;
  client: AxonClient;
  /** Умеет ли выбранная модель смотреть картинки. */
  seesImages: boolean;
  onSend: (parts: ContentPart[]) => void;
  onCancel: () => void;
  onOpenSettings: () => void;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  /**
   * Файл уезжает в ядро сразу, а не в момент отправки: пока человек дописывает
   * сообщение, загрузка уже идёт, и нажатие «отправить» не превращается в
   * ожидание. Заодно ошибка загрузки видна до того, как он нажмёт.
   */
  const attach = (files: File[]): void => {
    for (const file of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;

      setAttachments((list) => [
        ...list,
        {
          id,
          name: file.name || 'файл',
          mime: file.type || 'application/octet-stream',
          bytes: file.size,
          blobId: '',
          pending: true,
          ...(preview ? { preview } : {}),
        },
      ]);

      void client
        .uploadBlob({ data: file, mime: file.type || 'application/octet-stream', name: file.name })
        .then((written) =>
          setAttachments((list) =>
            list.map((item) =>
              item.id === id ? { ...item, blobId: written.blobId, pending: false } : item,
            ),
          ),
        )
        .catch((error: Error) =>
          setAttachments((list) =>
            list.map((item) =>
              item.id === id ? { ...item, pending: false, error: error.message } : item,
            ),
          ),
        );
    }
  };

  const drop = (attachment: Attachment): void => {
    if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    setAttachments((list) => list.filter((item) => item.id !== attachment.id));
  };

  const ready = attachments.filter((item) => !item.pending && !item.error && item.blobId);
  const uploading = attachments.some((item) => item.pending);
  const canSend = (Boolean(text.trim()) || ready.length > 0) && !streaming && !disabled && !uploading;

  const submit = (): void => {
    if (!canSend) return;

    const parts: ContentPart[] = ready.map((item) => ({
      type: 'blob',
      blobId: item.blobId,
      mime: item.mime,
      bytes: item.bytes,
      name: item.name,
    }));
    const trimmed = text.trim();
    if (trimmed) parts.push({ type: 'text', text: trimmed });

    for (const item of attachments) {
      if (item.preview) URL.revokeObjectURL(item.preview);
    }
    setText('');
    setAttachments([]);
    onSend(parts);
    area.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Скриншот из буфера — самый частый способ приложить картинку, и он должен
  // работать без промежуточного сохранения в файл.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...e.clipboardData.files];
    if (files.length === 0) return;
    e.preventDefault();
    attach(files);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length > 0) attach(files);
  };

  return (
    <div
      className="shrink-0 border-t border-border bg-surface p-3"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="max-w-3xl mx-auto">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((item) => (
              <AttachmentChip key={item.id} attachment={item} onRemove={() => drop(item)} />
            ))}
          </div>
        )}

        {/*
          Если распознавание не настроено, картинка поедет прямо в основную
          модель — и та вполне может отказать во всём запросе. Сказать об этом
          заранее дешевле, чем показать HTTP 400 вместо ответа.
        */}
        {!seesImages && attachments.some((item) => item.mime.startsWith('image/')) && (
          <p className="mb-2 px-1 text-[11px] text-warning leading-relaxed">
            <i className="bi bi-eye-slash mr-1.5" />
            Модель для распознавания не выбрана — картинка уйдёт в основную, и та может её не
            принять.{' '}
            <button
              type="button"
              onClick={onOpenSettings}
              className="underline underline-offset-2 hover:text-text transition-colors"
            >
              Выбрать
            </button>
          </p>
        )}

        <div
          className={clsx(
            'flex items-end gap-2 bg-bg border rounded-2xl px-3 py-2 transition-colors',
            dragging ? 'border-accent border-dashed' : 'border-border focus-within:border-accent',
          )}
        >
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={disabled}
            title="Приложить файл"
            className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center text-text-dim hover:text-text hover:bg-bg-hover transition-colors disabled:opacity-40"
          >
            <i className="bi bi-paperclip" />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attach([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />

          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled}
            placeholder={
              dragging
                ? 'Отпустите — приложу к сообщению'
                : 'Введите сообщение…   (Enter — отправить, Shift+Enter — перенос строки)'
            }
            rows={1}
            className="flex-1 resize-none bg-transparent outline-none text-[14px] text-text placeholder:text-text-dim leading-relaxed py-1.5 scrollbar disabled:opacity-50"
            style={{ maxHeight: MAX_HEIGHT }}
          />

          {streaming ? (
            <button
              type="button"
              onClick={onCancel}
              title="Остановить ответ"
              className="w-9 h-9 shrink-0 rounded-xl bg-danger hover:bg-danger-hover text-white flex items-center justify-center transition-colors"
            >
              <i className="bi bi-stop-fill" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              title={uploading ? 'Дождитесь загрузки вложений' : 'Отправить (Enter)'}
              className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center transition-colors btn-send"
            >
              <i className={clsx('bi', uploading ? 'bi-hourglass-split' : 'bi-send-fill')} />
            </button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between px-1">
          <span className="text-[10px] text-text-dim">
            <kbd className="px-1 rounded bg-surface-elev border border-border">Enter</kbd>
            {' — отправить · '}
            <kbd className="px-1 rounded bg-surface-elev border border-border">Shift</kbd>+
            <kbd className="px-1 rounded bg-surface-elev border border-border">Enter</kbd>
            {' — перенос · файл можно перетащить или вставить'}
          </span>
          <span className="text-[10px] text-text-dim">
            {text.length > 0 && `${text.length} симв.`}
          </span>
        </div>
      </div>
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  return (
    <div
      className={clsx(
        'group relative flex items-center gap-2 pl-2 pr-7 py-1.5 rounded-xl border bg-bg text-[11px]',
        attachment.error ? 'border-danger/50' : 'border-border',
      )}
      title={attachment.error ?? attachment.name}
    >
      {attachment.preview ? (
        <img src={attachment.preview} alt="" className="w-7 h-7 rounded object-cover shrink-0" />
      ) : (
        <i
          className={clsx(
            'bi text-[14px] shrink-0',
            attachment.pending ? 'bi-hourglass-split text-text-dim' : 'bi-file-earmark text-accent',
          )}
        />
      )}

      <span className="min-w-0">
        <span className="block truncate max-w-[160px]">{attachment.name}</span>
        <span className={clsx('block text-[10px]', attachment.error ? 'text-danger' : 'text-text-dim')}>
          {attachment.error ?? (attachment.pending ? 'загружаю…' : size(attachment.bytes))}
        </span>
      </span>

      <button
        type="button"
        onClick={onRemove}
        title="Убрать"
        className="absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-text-dim hover:text-danger transition-colors"
      >
        <i className="bi bi-x-lg text-[9px]" />
      </button>
    </div>
  );
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}
