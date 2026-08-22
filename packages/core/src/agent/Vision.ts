import type { ContentPart, Message } from '@axon/protocol';
import { logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { BlobReader } from './ContextBuilder.js';

/** Признак, по которому видно, что картинка уже описана. */
const MARK = '[описание вложения';

/** Потолок длины описания: это подпись к картинке, а не пересказ страницы. */
const MAX_TOKENS = 700;

const PROMPT =
  'Опиши изображение так, чтобы по описанию можно было работать дальше, не видя ' +
  'его. Если это снимок экрана — перечисли, что на нём написано и что где ' +
  'расположено. Если это текст или таблица — перепиши содержимое. Если схема — ' +
  'опиши связи. Без вступлений и без выводов: только то, что видно.';

export interface VisionDeps {
  providers: ProviderRegistry;
  blobs: BlobReader;
}

/**
 * Распознавание картинок отдельной моделью.
 *
 * Зрение — свойство модели, а не провайдера, и у одного провайдера
 * одновременно бывают и обычные модели, и vision. Поэтому картинку смотрит та
 * модель, которую пользователь назначил, а не та, в которой идёт разговор.
 *
 * Описание записывается в само сообщение и остаётся в истории текстом. Это не
 * побочный эффект, а главный выигрыш: картинка стоит токенов один раз, а не
 * переотправляется на каждом ходу до конца разговора. Заодно основной моделью
 * может быть любая, включая текстовую.
 */
export class Vision {
  constructor(private readonly deps: VisionDeps) {}

  /** Назначена ли модель для распознавания. */
  get enabled(): boolean {
    return this.deps.providers.vision() !== null;
  }

  /** Нужно ли что-то описывать в этом сообщении. */
  static needsDescription(message: Message): boolean {
    const images = message.parts.filter(
      (part) => part.type === 'blob' && part.mime.startsWith('image/'),
    );
    if (images.length === 0) return false;
    return !message.parts.some((part) => part.type === 'text' && part.text.startsWith(MARK));
  }

  /**
   * Описать картинки сообщения. Возвращает новые части сообщения либо `null`,
   * если описывать нечем или незачем.
   *
   * Ошибка распознавания не срывает прогон: разговор продолжается без описания,
   * а причина уходит в лог. Картинка — вложение к вопросу, а не сам вопрос.
   */
  async describe(message: Message, signal?: AbortSignal): Promise<ContentPart[] | null> {
    const selection = this.deps.providers.vision();
    if (!selection || !Vision.needsDescription(message)) return null;

    const described: ContentPart[] = [];

    for (const part of message.parts) {
      if (part.type !== 'blob' || !part.mime.startsWith('image/')) continue;

      const blob = await this.deps.blobs.read(part.blobId);
      if (!blob) continue;

      try {
        let text = '';
        for await (const event of selection.provider.chat({
          model: selection.model,
          messages: [
            {
              role: 'user',
              parts: [
                { type: 'image', mime: blob.mime, base64: blob.base64 },
                { type: 'text', text: PROMPT },
              ],
            },
          ],
          maxTokens: MAX_TOKENS,
          ...(signal ? { signal } : {}),
        })) {
          if (event.type === 'text') text += event.delta;
        }

        const trimmed = text.trim();
        if (trimmed) {
          described.push({
            type: 'text',
            text: `${MARK} ${part.name ?? 'изображение'}]\n${trimmed}`,
          });
        }
      } catch (error) {
        logger.warn(
          { blob: part.blobId, err: (error as Error).message },
          'не удалось распознать картинку',
        );
      }
    }

    if (described.length === 0) return null;

    // Описание встаёт перед текстом пользователя: сначала что на картинке,
    // потом вопрос про неё. В обратном порядке модель читает вопрос, ещё не
    // зная, о чём он.
    const blobs = message.parts.filter((part) => part.type === 'blob');
    const texts = message.parts.filter((part) => part.type === 'text');
    return [...blobs, ...described, ...texts];
  }
}
