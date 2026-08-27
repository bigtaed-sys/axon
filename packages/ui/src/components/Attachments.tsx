import { useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import type { ContentPart } from '@axon/protocol';
import { size } from './MessageInput.js';

type BlobPart = Extract<ContentPart, { type: 'blob' }>;

/**
 * Вложения сообщения.
 *
 * Байты лежат в ядре и тянутся по ссылке, а не едут в журнале: журнал
 * синкается на все устройства, и один скриншот в нём означал бы, что телефон
 * при подключении скачивает его целиком, даже если открывать не собирался.
 */
export function Attachments({ parts, client }: { parts: ContentPart[]; client: AxonClient }) {
  const blobs = parts.filter((part): part is BlobPart => part.type === 'blob');
  const [opened, setOpened] = useState<BlobPart | null>(null);

  if (blobs.length === 0) return null;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {blobs.map((blob) =>
          blob.mime.startsWith('image/') ? (
            <button
              key={blob.blobId}
              type="button"
              onClick={() => setOpened(blob)}
              title={`${blob.name ?? 'изображение'} · ${size(blob.bytes)}`}
              className="rounded-xl border border-border overflow-hidden hover:border-border-strong transition-colors"
            >
              <img
                src={client.blobUrl(blob.blobId)}
                alt={blob.name ?? ''}
                className="max-h-56 max-w-[320px] object-contain block bg-bg"
              />
            </button>
          ) : (
            <a
              key={blob.blobId}
              href={client.blobUrl(blob.blobId)}
              target="_blank"
              rel="noreferrer"
              download={blob.name}
              className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-border bg-bg hover:border-border-strong transition-colors"
            >
              <i className={clsx('bi text-accent', iconFor(blob.mime))} />
              <span className="min-w-0">
                <span className="block text-[12px] truncate max-w-[200px]">
                  {blob.name ?? 'файл'}
                </span>
                <span className="block text-[10px] text-text-dim">{size(blob.bytes)}</span>
              </span>
            </a>
          ),
        )}
      </div>

      {opened && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-2 sm:p-6 animate-fade-in"
          onClick={() => setOpened(null)}
        >
          <img
            src={client.blobUrl(opened.blobId)}
            alt={opened.name ?? ''}
            className="max-w-full max-h-full object-contain rounded-xl"
          />
        </div>
      )}
    </>
  );
}

function iconFor(mime: string): string {
  if (mime.startsWith('audio/')) return 'bi-file-earmark-music';
  if (mime.startsWith('video/')) return 'bi-file-earmark-play';
  if (mime.includes('pdf')) return 'bi-file-earmark-pdf';
  if (mime.includes('zip') || mime.includes('compressed')) return 'bi-file-earmark-zip';
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) {
    return 'bi-file-earmark-text';
  }
  return 'bi-file-earmark';
}
