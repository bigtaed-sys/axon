import { useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import {
  compareVersions,
  formatVersion,
  PERSONA_PRESETS,
  readImpulse,
  readPersona,
  type Impulse,
  type Persona,
} from '@axon/protocol';
import type { PluginInfo, ProviderInfo, SecretStatus } from '@axon/protocol';
import type { Connection } from '../useAxon.js';
import { THEMES, type ThemeId } from '../theme.js';
import type { MotionId } from '../motion.js';
import { Toggle } from './Panels.js';

/**
 * Настройки.
 *
 * Разделены на страницы, а не свалены в одну прокрутку. Причина простая:
 * настроек стало полтора десятка, и в общем столбце «системный промпт»
 * оказывается сразу под «потолком токенов», хотя между ними нет ничего
 * общего. Слева видно, что вообще можно настроить, — и это отвечает на вопрос
 * «где это меняется» без пролистывания.
 *
 * Разделы сгруппированы по тому, чего они касаются: что думает, где живёт
 * ядро, как выглядит приложение.
 */

type PageId = 'provider' | 'vision' | 'persona' | 'impulse' | 'budget' | 'telegram' | 'core' | 'access' | 'look' | 'about';

interface Page {
  id: PageId;
  label: string;
  icon: string;
}

const PAGES: Page[] = [
  { id: 'provider', label: 'Провайдер', icon: 'bi-cpu-fill' },
  { id: 'vision', label: 'Картинки', icon: 'bi-image' },
  { id: 'persona', label: 'Личность', icon: 'bi-person-badge-fill' },
  { id: 'impulse', label: 'Инициатива', icon: 'bi-send-fill' },
  { id: 'budget', label: 'Расход', icon: 'bi-coin' },
  { id: 'core', label: 'Подключение', icon: 'bi-pc-display' },
  { id: 'telegram', label: 'Телеграм', icon: 'bi-telegram' },
  { id: 'access', label: 'Доступ и запуск', icon: 'bi-shield-lock-fill' },
  { id: 'look', label: 'Оформление', icon: 'bi-palette-fill' },
  { id: 'about', label: 'О программе', icon: 'bi-info-circle-fill' },
];

const GROUPS: Array<{ title: string; ids: PageId[] }> = [
  { title: 'Агент', ids: ['provider', 'vision', 'persona', 'impulse', 'budget'] },
  { title: 'Ядро', ids: ['core', 'telegram', 'access'] },
  { title: 'Приложение', ids: ['look', 'about'] },
];

export function SettingsPanel({
  client,
  connection,
  plugins,
  theme,
  onTheme,
  motion,
  onMotion,
  onChangeCore,
  onRestartCore,
  onRunSetup,
  onReconnect,
}: {
  client: AxonClient;
  connection: Connection | null;
  plugins: PluginInfo[];
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
  motion: MotionId;
  onMotion: (motion: MotionId) => void;
  onChangeCore: () => void;
  onRestartCore: () => Promise<void>;
  onRunSetup: () => void;
  onReconnect: () => void;
}) {
  const [page, setPage] = useState<PageId>('provider');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [secrets, setSecrets] = useState<SecretStatus[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [saved, setSaved] = useState(false);

  const load = async (): Promise<void> => {
    const settings = await client.call('settings.get', {});
    setValues(settings.values);
    setSecrets(settings.secrets);
  };

  useEffect(() => {
    void load();
  }, []);

  // Список провайдеров приходит из ядра и меняется, когда плагин со своим
  // провайдером поднялся или упал. Перечитываем по составу и состоянию
  // плагинов, а не на каждое изменение чего угодно.
  const pluginStamp = plugins.map((plugin) => `${plugin.id}:${plugin.status}`).join(',');
  useEffect(() => {
    void client
      .call('provider.list', {})
      .then((res) => setProviders(res.providers))
      .catch(() => setProviders([]));
  }, [pluginStamp]);

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    await client.call('settings.set', { values: patch });
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    await load();
  };

  const saveSecret = async (key: string, value: string): Promise<void> => {
    await client.call('settings.set', { secrets: { [key]: value } });
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
    await load();
  };

  const shared = { values, secrets, providers, save, saveSecret };

  return (
    <div className="flex-1 flex min-h-0">
      <aside className="w-[210px] shrink-0 bg-surface border-r border-border flex flex-col">
        <div className="px-4 pt-5 pb-3">
          <h1 className="text-[17px] font-semibold tracking-tight">Настройки</h1>
        </div>

        <nav className="flex-1 overflow-y-auto scrollbar px-2 pb-3 space-y-3">
          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-text-dim">
                {group.title}
              </div>
              <div className="space-y-0.5">
                {group.ids.map((id) => {
                  const item = PAGES.find((candidate) => candidate.id === id)!;
                  const active = page === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPage(id)}
                      className={clsx(
                        'w-full h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-left text-[13px] transition-colors relative',
                        active
                          ? 'bg-bg-hover text-text font-medium'
                          : 'text-text-muted hover:bg-bg-hover hover:text-text',
                      )}
                    >
                      {/* Полоска у края — где мы находимся, видно боковым зрением. */}
                      <span
                        className={clsx(
                          'absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r bg-accent transition-all duration-150',
                          active ? 'h-5' : 'h-0',
                        )}
                      />
                      <i
                        className={clsx(
                          'bi shrink-0',
                          item.icon,
                          active ? 'text-accent' : 'text-text-dim',
                        )}
                      />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-border min-h-[44px] flex items-center">
          {saved && (
            <span className="text-[11px] text-success flex items-center gap-1.5 animate-fade-in">
              <i className="bi bi-check-circle-fill" />
              сохранено
            </span>
          )}
        </div>
      </aside>

      <div className="flex-1 overflow-y-auto scrollbar">
        <div className="max-w-2xl px-6 py-6 space-y-4">
          {page === 'provider' && <ProviderPage {...shared} />}
          {page === 'vision' && <VisionPage {...shared} />}
          {page === 'persona' && <PersonaPage {...shared} />}
          {page === 'impulse' && <ImpulsePage {...shared} />}
          {page === 'telegram' && <TelegramPage {...shared} />}
          {page === 'budget' && <BudgetPage {...shared} />}
          {page === 'core' && (
            <CorePage
              connection={connection}
              onChangeCore={onChangeCore}
              onRestartCore={onRestartCore}
              onReconnect={onReconnect}
            />
          )}
          {page === 'access' && <AccessPage connection={connection} onReconnect={onReconnect} />}
          {page === 'look' && (
            <LookPage theme={theme} onTheme={onTheme} motion={motion} onMotion={onMotion} />
          )}
          {page === 'about' && (
            <AboutPage client={client} connection={connection} onRunSetup={onRunSetup} />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Общие части страниц ────────────────────────────────────────────────────

interface PageProps {
  values: Record<string, unknown>;
  secrets: SecretStatus[];
  providers: ProviderInfo[];
  save: (patch: Record<string, unknown>) => Promise<void>;
  saveSecret: (key: string, value: string) => Promise<void>;
}

function Section({
  title,
  icon,
  hint,
  children,
}: {
  title: string;
  icon: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="card p-5">
      <h2 className="text-[14px] font-semibold flex items-center gap-2">
        <i className={clsx('bi', icon, 'text-accent')} />
        {title}
      </h2>
      {hint && <p className="mt-1.5 text-[11px] text-text-dim leading-relaxed">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <span className="block text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1.5">
        {label}
      </span>
      {hint && <p className="text-[11px] text-text-dim mb-2 leading-relaxed">{hint}</p>}
      {children}
    </div>
  );
}

/** Переключатель строкой: подпись слева, тумблер справа, вся строка кликается. */
function Switch({
  label,
  hint,
  on,
  onToggle,
  disabled,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onToggle}
      className="w-full flex items-start justify-between gap-3 px-3 py-2.5 rounded-xl bg-bg border border-border hover:border-border-strong transition-colors text-left disabled:opacity-50"
    >
      <span className="min-w-0">
        <span className="block text-[13px]">{label}</span>
        {hint && <span className="block mt-0.5 text-[11px] text-text-dim leading-relaxed">{hint}</span>}
      </span>
      <span
        className={clsx(
          'mt-0.5 w-9 h-5 shrink-0 rounded-full transition-colors',
          on ? 'bg-accent' : 'bg-surface-high border border-border',
        )}
      >
        <span
          className={clsx(
            'block w-4 h-4 rounded-full transition-transform',
            on ? 'translate-x-[18px] bg-accent-fg' : 'translate-x-0.5 bg-text-dim',
          )}
          style={{ marginTop: 1 }}
        />
      </span>
    </button>
  );
}

// ─── Страницы ───────────────────────────────────────────────────────────────

function ProviderPage({ values, secrets, providers, save, saveSecret }: PageProps) {
  const [keyDraft, setKeyDraft] = useState('');

  const active = String(values['provider.active'] ?? 'anthropic');
  const provider = providers.find((item) => item.id === active) ?? providers[0];
  const secret = secrets.find((item) => item.key === provider?.secretKey);
  const models = provider?.models ?? [];
  const currentModel = String(values[`provider.${active}.model`] ?? '');

  return (
    <>
      <Section
        title="Чем думает агент"
        icon="bi-cpu-fill"
        hint="Список приходит от ядра — сюда попадают и провайдеры, которые принесли плагины."
      >
        <Field label="Провайдер">
          <select
            value={active}
            onChange={(e) => void save({ 'provider.active': e.target.value })}
            className="input"
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
                {item.source === 'builtin' ? '' : ' — из плагина'}
                {item.configured ? '' : ' (нужен ключ)'}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Модель"
          hint={
            models.length > 0
              ? 'Провайдер сам сообщил, какие модели у него есть.'
              : 'Пусто — модель по умолчанию для выбранного провайдера.'
          }
        >
          {models.length > 0 ? (
            <select
              value={currentModel}
              onChange={(e) => void save({ [`provider.${active}.model`]: e.target.value })}
              className="input font-mono text-[12px]"
            >
              <option value="">по умолчанию ({provider?.defaultModel})</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name ?? model.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              // key по провайдеру: иначе поле с defaultValue не перерисуется
              // при смене провайдера и покажет модель от предыдущего.
              key={active}
              defaultValue={currentModel}
              placeholder={provider?.defaultModel ?? 'по умолчанию'}
              onBlur={(e) => void save({ [`provider.${active}.model`]: e.target.value })}
              className="input font-mono text-[12px]"
            />
          )}
        </Field>
      </Section>

      {provider?.requiresKey && (
        <Section
          title="Ключ доступа"
          icon="bi-key-fill"
          hint="Хранится в ядре зашифрованным и наружу не отдаётся — ни этому приложению, ни любому другому. Посмотреть целиком можно только командой axon secret get на машине с ядром."
        >
          <div className="flex gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={secret?.set ? `задан, оканчивается на ${secret.hint}` : 'ключ не задан'}
              className="input flex-1"
            />
            <button
              type="button"
              disabled={!keyDraft.trim() || !provider.secretKey}
              onClick={async () => {
                await saveSecret(provider.secretKey, keyDraft.trim());
                setKeyDraft('');
              }}
              className="h-9 px-4 rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors disabled:opacity-40"
            >
              Записать
            </button>
          </div>

          {secret?.set && (
            <p className="text-[11px] text-success flex items-center gap-1.5">
              <i className="bi bi-check-circle-fill" />
              ключ на месте
            </p>
          )}
          {provider.keyUrl && (
            <p className="text-[11px] text-text-dim">
              Получить можно на{' '}
              <a
                href={provider.keyUrl}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline underline-offset-2"
              >
                {new URL(provider.keyUrl).host}
              </a>
            </p>
          )}
        </Section>
      )}
    </>
  );
}

function VisionPage({ values, providers, save }: PageProps) {
  const visionProvider = String(values['vision.provider'] ?? '');
  const visionModel = String(values['vision.model'] ?? '');

  return (
    <Section
      title="Распознавание картинок"
      icon="bi-image"
      hint="Зрение — свойство модели, а не провайдера: у одного провайдера бывают и обычные модели, и vision. Поэтому картинки смотрит отдельная модель, которую вы назначаете здесь."
    >
      <Field label="Провайдер">
        <select
          value={visionProvider}
          onChange={(e) => void save({ 'vision.provider': e.target.value })}
          className="input"
        >
          <option value="">не распознавать</option>
          {providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Модель" hint="Имя vision-модели у этого провайдера.">
        <input
          key={visionProvider}
          defaultValue={visionModel}
          placeholder="например, llava"
          onBlur={(e) => void save({ 'vision.model': e.target.value })}
          className="input font-mono text-[12px]"
          disabled={!visionProvider}
        />
      </Field>

      {visionProvider && !visionModel && (
        <p className="text-[11px] text-warning">
          Укажите имя модели — без него распознавание не включится.
        </p>
      )}

      <p className="text-[11px] text-text-dim leading-relaxed">
        Картинка описывается один раз, описание остаётся в переписке текстом — и дальше с ним
        работает основная модель, даже если сама картинок не принимает. Заодно вложение перестаёт
        стоить токенов на каждом следующем ходу.
      </p>
    </Section>
  );
}

/**
 * Выбор одного значения из нескольких — сегментами, а не выпадающим списком.
 *
 * Ручек характера мало и они короткие: список прячет варианты за кликом и
 * заставляет открыть его, чтобы вспомнить, из чего вообще выбор. Здесь всё
 * видно сразу, а выбранное читается без наведения.
 */
function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onPick,
}: {
  label: string;
  hint?: string;
  value: T;
  options: ReadonlyArray<{ id: T; title: string }>;
  onPick: (id: T) => void;
}) {
  return (
    <Field label={label} {...(hint ? { hint } : {})}>
      <div className="seg w-full">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onPick(option.id)}
            className="flex-1"
          >
            {option.title}
          </button>
        ))}
      </div>
    </Field>
  );
}

function PersonaPage({ values, save }: PageProps) {
  const persona = readPersona(values);

  /**
   * Правка руками означает, что знакомиться уже не нужно.
   *
   * Иначе человек выкрутит всё на этом экране, а агент в первом же разговоре
   * спросит, как его называть, — и будет выглядеть так, будто настройки ни на
   * что не влияют.
   */
  const set = <K extends keyof Persona>(field: K, value: Persona[K]): void =>
    void save({ [`persona.${field}`]: value, 'persona.configured': true });

  return (
    <>
      <Section
        title="Характер"
        icon="bi-person-badge-fill"
        hint="Из этого собирается начало каждого разговора. Оно уходит в кэшируемую часть промпта, поэтому характер не стоит вам почти ничего — платите за него один раз."
      >
        <div className="space-y-2">
          {PERSONA_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => set('preset', preset.id)}
              className={clsx(
                'w-full text-left px-3 py-2.5 rounded-xl border transition-colors',
                persona.preset === preset.id
                  ? 'border-accent bg-surface-2'
                  : 'border-border bg-bg hover:border-border-strong',
              )}
            >
              <span className="flex items-center gap-2">
                <i
                  className={clsx(
                    'bi text-[13px]',
                    persona.preset === preset.id
                      ? 'bi-record-circle text-accent'
                      : 'bi-circle text-text-dim',
                  )}
                />
                <span className="text-[13px] font-medium">{preset.title}</span>
              </span>
              <span className="block mt-1 ml-[21px] text-[11px] text-text-dim leading-relaxed">
                {preset.note}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="Знакомство"
        icon="bi-hand-thumbs-up"
        hint="Пока знакомство не состоялось, агент получает задание выяснить всё это сам — в разговоре, а не анкетой."
      >
        {persona.configured ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-text-muted">Вы знакомы — вопросов он не задаёт.</span>
            <button
              type="button"
              onClick={() => void save({ 'persona.configured': false })}
              className="shrink-0 h-8 px-3 rounded-lg border border-border text-[12px] hover:border-border-strong transition-colors"
            >
              Познакомиться заново
            </button>
          </div>
        ) : (
          <p className="text-[13px] text-text-muted leading-relaxed">
            Ещё не знакомы. Напишите ему первым — он спросит, как вас называть и как себя вести.
            Или задайте всё здесь: тогда спрашивать будет не о чем.
          </p>
        )}
      </Section>

      <Section title="Кто с кем говорит" icon="bi-chat-square-text-fill">
        <Field
          label="Как зовут агента"
          hint="Пусто — имени нет, и он спросит его сам при знакомстве."
        >
          <input
            className="input"
            defaultValue={persona.name}
            placeholder="имени пока нет"
            onBlur={(e) => set('name', e.target.value.trim())}
          />
        </Field>

        <Field label="Как зовут вас" hint="Пусто — агент не станет выдумывать обращение.">
          <input
            className="input"
            defaultValue={persona.userName}
            placeholder="не указано"
            onBlur={(e) => set('userName', e.target.value.trim())}
          />
        </Field>

        <Choice
          label="Обращение"
          value={persona.address}
          options={[
            { id: 'ты' as const, title: 'На ты' },
            { id: 'вы' as const, title: 'На вы' },
          ]}
          onPick={(id) => set('address', id)}
        />
      </Section>

      <Section
        title="Манера"
        icon="bi-sliders"
        hint="Действует поверх выбранного характера. На «своём» характере не применяется — там всё задаёт ваш текст."
      >
        <Choice
          label="Юмор"
          value={persona.humor}
          options={[
            { id: 'none' as const, title: 'Без шуток' },
            { id: 'dry' as const, title: 'Сухая ирония' },
            { id: 'playful' as const, title: 'Охотно шутит' },
          ]}
          onPick={(id) => set('humor', id)}
        />

        <Choice
          label="Длина ответов"
          value={persona.verbosity}
          options={[
            { id: 'short' as const, title: 'Коротко' },
            { id: 'normal' as const, title: 'По ситуации' },
            { id: 'detailed' as const, title: 'Подробно' },
          ]}
          onPick={(id) => set('verbosity', id)}
        />

        <Choice
          label="Инициатива в разговоре"
          hint="Насколько сам предлагает следующий шаг и спорит, когда видит, что вы идёте не туда."
          value={persona.initiative}
          options={[
            { id: 'low' as const, title: 'Только по делу' },
            { id: 'normal' as const, title: 'Обычно' },
            { id: 'high' as const, title: 'Активно' },
          ]}
          onPick={(id) => set('initiative', id)}
        />

        <Switch
          label="Эмодзи"
          hint="Выключено — агент обходится словами."
          on={persona.emoji}
          onToggle={() => set('emoji', !persona.emoji)}
        />
      </Section>

      <Section
        title="Своими словами"
        icon="bi-file-text-fill"
        hint="Дописывается после собранного характера. Сюда идёт то, чего нет в ручках выше: ваш язык, область работы, личные правила."
      >
        <textarea
          rows={8}
          defaultValue={persona.custom}
          onBlur={(e) => set('custom', e.target.value)}
          placeholder="Например: я пишу на TypeScript, отвечай примерами под мой стек. Не предлагай переписать всё с нуля."
          className="input resize-none leading-relaxed scrollbar text-[12px]"
        />
      </Section>
    </>
  );
}

function ImpulsePage({ values, save }: PageProps) {
  const impulse = readImpulse(values);
  const set = <K extends keyof Impulse>(field: K, value: Impulse[K]): void =>
    void save({ [`impulse.${field}`]: value });

  return (
    <>
      <Section
        title="Писать первым"
        icon="bi-send-fill"
        hint="Раз в несколько минут агент дёшево проверяет, есть ли повод написать — и почти всегда решает, что нет. Полный запрос с памятью и историей случается только тогда, когда повод нашёлся."
      >
        <Switch
          label="Разрешить писать самому"
          hint="Выключено — агент отвечает, но никогда не начинает разговор."
          on={impulse.enabled}
          onToggle={() => set('enabled', !impulse.enabled)}
        />

        {impulse.enabled && (
          <p className="text-[11px] text-text-dim leading-relaxed">
            Поводом считается незакрытое дело, наступивший срок или что-то, что меняет прежний
            вывод. Дежурное «как дела» поводом не считается — и об этом сказано прямо в его
            задании.
          </p>
        )}
      </Section>

      {impulse.enabled && (
        <>
          <Section
            title="Насколько часто"
            icon="bi-hourglass-split"
            hint="Рамки проверяются до обращения к модели и ничего не стоят. Агент, пишущий когда вздумается, выключается на второй день — вместе со всем хорошим, что он мог принести."
          >
            <Field label="Не больше раз в сутки">
              <input
                type="number"
                min={1}
                max={12}
                className="input"
                defaultValue={impulse.maxPerDay}
                onBlur={(e) => set('maxPerDay', clamp(e.target.value, 1, 12, 3))}
              />
            </Field>

            <Field
              label="Пауза между сообщениями, минут"
              hint="Даже если поводов набралось несколько."
            >
              <input
                type="number"
                min={30}
                max={1440}
                className="input"
                defaultValue={impulse.minGapMinutes}
                onBlur={(e) => set('minGapMinutes', clamp(e.target.value, 30, 1440, 180))}
              />
            </Field>

            <Field
              label="Молчать, пока вы писали недавно, минут"
              hint="Написать тому, кто ответил пять минут назад, — не инициатива, а помеха."
            >
              <input
                type="number"
                min={5}
                max={1440}
                className="input"
                defaultValue={impulse.idleMinutes}
                onBlur={(e) => set('idleMinutes', clamp(e.target.value, 5, 1440, 45))}
              />
            </Field>
          </Section>

          <Section
            title="Тишина"
            icon="bi-moon-stars-fill"
            hint="В эти часы агент молчит, даже если повод настоящий. Интервал через полночь — обычное дело и работает как ожидается."
          >
            <div className="flex items-end gap-3">
              <Field label="С">
                <input
                  type="time"
                  className="input"
                  defaultValue={impulse.quietFrom}
                  onBlur={(e) => set('quietFrom', e.target.value || '23:00')}
                />
              </Field>
              <Field label="До">
                <input
                  type="time"
                  className="input"
                  defaultValue={impulse.quietTo}
                  onBlur={(e) => set('quietTo', e.target.value || '09:00')}
                />
              </Field>
            </div>
          </Section>
        </>
      )}
    </>
  );
}

/** Число из поля ввода в допустимых границах. Пустое или мусор — умолчание. */
function clamp(raw: string, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Кто из телеграма привязан. Ключ — id чата, значение пишет адаптер. */
interface TelegramChat {
  deviceId: string;
  name: string;
}

function TelegramPage({ values, secrets, save, saveSecret }: PageProps) {
  const [draft, setDraft] = useState('');
  const secret = secrets.find((item) => item.key === 'telegram.botToken');
  const chats = (values['telegram.chats'] ?? {}) as Record<string, TelegramChat>;
  const bound = Object.entries(chats);

  return (
    <>
      <Section
        title="Бот"
        icon="bi-telegram"
        hint="Телеграм — это ещё одно окно к тому же агенту, а не отдельный чат. Разговор общий с десктопом: закрыли ноутбук — продолжили с телефона с того же места."
      >
        <Field
          label="Токен бота"
          hint="Создайте бота у @BotFather, командой /newbot, и вставьте выданный токен. Он хранится в ядре зашифрованным."
        >
          <div className="flex gap-2">
            <input
              type="password"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={secret?.set ? `задан, оканчивается на ${secret.hint}` : 'токен не задан'}
              className="input flex-1"
            />
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={async () => {
                await saveSecret('telegram.botToken', draft.trim());
                setDraft('');
              }}
              className="h-9 px-4 rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors disabled:opacity-40"
            >
              Записать
            </button>
          </div>
        </Field>

        {secret?.set ? (
          <p className="text-[11px] text-success flex items-center gap-1.5">
            <i className="bi bi-check-circle-fill" />
            бот поднят — токен есть, отдельного переключателя не нужно
          </p>
        ) : (
          <p className="text-[11px] text-text-dim leading-relaxed">
            Пока токена нет, бот не работает. Отдельного переключателя «включить» нет намеренно:
            он был бы вторым источником правды, и однажды вы оказались бы с введённым токеном и
            выключенным ботом, не понимая почему.
          </p>
        )}
      </Section>

      <Section
        title="Кто может писать"
        icon="bi-person-check-fill"
        hint="Только привязанные. Чужой, нашедший бота, получает отказ и не тратит ваши деньги — обращения к модели не будет вовсе."
      >
        {bound.length === 0 ? (
          <p className="text-[12px] text-text-muted leading-relaxed">
            Никто не привязан. Создайте код подключения на экране «Устройства» и отправьте его
            боту командой <code className="font-mono text-[11px]">/start КОД</code> — это тот же
            механизм, что у любого другого устройства.
          </p>
        ) : (
          <div className="space-y-2">
            {bound.map(([chatId, chat]) => (
              <div
                key={chatId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-bg border border-border"
              >
                <i className="bi bi-telegram text-accent" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] truncate">{chat.name || 'без имени'}</p>
                  <p className="text-[11px] text-text-dim font-mono">{chatId}</p>
                </div>
                <button
                  type="button"
                  title="Отвязать"
                  onClick={() => {
                    const rest = { ...chats };
                    delete rest[chatId];
                    void save({ 'telegram.chats': rest });
                  }}
                  className="shrink-0 h-8 px-3 rounded-lg border border-border text-[12px] text-text-muted hover:border-danger hover:text-danger transition-colors"
                >
                  Отвязать
                </button>
              </div>
            ))}
            <p className="text-[11px] text-text-dim leading-relaxed">
              Отвязать здесь — значит перестать принимать сообщения из этого чата. Само
              устройство остаётся в списке на экране «Устройства», отозвать его нужно там.
            </p>
          </div>
        )}
      </Section>

      <Section title="Что умеет" icon="bi-list-check">
        <ul className="text-[12px] text-text-muted leading-relaxed space-y-1.5">
          <li>· Отвечает в том же разговоре, что и десктоп — контекст один на все окна.</li>
          <li>
            · Подтверждает опасные действия кнопками под сообщением. Здесь телеграм даже удобнее
            десктопа, поэтому ограничивать его безопасными инструментами не пришлось.
          </li>
          <li>
            · Присылает то, что агент написал сам по своему почину, — если инициатива включена.
            Ради этого она и делалась: до человека за компьютером достучаться можно и так.
          </li>
        </ul>
      </Section>
    </>
  );
}

function BudgetPage({ values, save }: PageProps) {
  const effort = String(values['run.effort'] ?? '');

  return (
    <>
      <Section
        title="Потолок расхода"
        icon="bi-coin"
        hint="Проверяется до обращения к модели, а не после, поэтому перерасход невозможен, а не «маловероятен»."
      >
        <Field label="Токенов на один ответ" hint="Пусто — без потолка.">
          <input
            type="number"
            defaultValue={String(values['run.budgetTokens'] ?? '')}
            placeholder="без потолка"
            onBlur={(e) =>
              void save({ 'run.budgetTokens': e.target.value ? Number(e.target.value) : null })
            }
            className="input font-mono text-[12px]"
          />
        </Field>
      </Section>

      <Section
        title="Глубина рассуждений"
        icon="bi-lightbulb"
        hint="Провайдеры без такого параметра его просто игнорируют. Чем глубже, тем дороже и медленнее."
      >
        <Field label="Усилие">
          <select
            value={effort}
            onChange={(e) => void save({ 'run.effort': e.target.value || null })}
            className="input"
          >
            <option value="">по умолчанию</option>
            <option value="low">низкое — быстро и дёшево</option>
            <option value="medium">среднее</option>
            <option value="high">высокое</option>
            <option value="xhigh">очень высокое</option>
            <option value="max">предельное — для трудных задач</option>
          </select>
        </Field>
      </Section>
    </>
  );
}

function CorePage({
  connection,
  onChangeCore,
  onRestartCore,
  onReconnect,
}: {
  connection: Connection | null;
  onChangeCore: () => void;
  onRestartCore: () => Promise<void>;
  onReconnect: () => void;
}) {
  const [restarting, setRestarting] = useState(false);

  return (
    <Section
      title="Ядро"
      icon="bi-pc-display"
      hint="Настройки агента хранятся в ядре, а не в приложении. Подключитесь к другому ядру — увидите его настройки, его переписку и его память."
    >
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-bg border border-border">
        <i
          className={clsx(
            'bi text-accent',
            connection?.mode === 'remote' ? 'bi-hdd-network' : 'bi-pc-display',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px]">
            {connection?.mode === 'remote' ? 'Удалённое ядро' : 'На этом компьютере'}
          </p>
          <p className="text-[10px] text-text-dim font-mono truncate">
            {connection?.label ?? connection?.url ?? '—'}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onChangeCore}
          className="h-9 px-4 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors"
        >
          Подключиться к другому
        </button>

        {connection?.mode === 'embedded' && (
          <button
            type="button"
            title="Остановить и поднять заново — например, после обновления приложения"
            disabled={restarting}
            onClick={() => {
              setRestarting(true);
              void onRestartCore().finally(() => setRestarting(false));
            }}
            className="h-9 px-4 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors disabled:opacity-40 flex items-center gap-2"
          >
            <i className={clsx('bi bi-arrow-clockwise', restarting && 'animate-spin')} />
            {restarting ? 'Перезапускаю…' : 'Перезапустить'}
          </button>
        )}
      </div>

      {connection?.mode === 'embedded' && (
        <div className="pt-4 border-t border-border">
          <p className="text-[12px] text-text-muted leading-relaxed">
            Ядро не останавливается вместе с окном — иначе агент не смог бы работать в фоне.
            Остановить можно отсюда или командой <span className="font-mono">axon stop</span>.
          </p>
          <button
            type="button"
            onClick={async () => {
              await window.axon!.stopLocal();
              onReconnect();
            }}
            className="mt-2.5 h-9 px-4 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-danger transition-colors"
          >
            Остановить ядро
          </button>
        </div>
      )}
    </Section>
  );
}

function AccessPage({
  connection,
  onReconnect,
}: {
  connection: Connection | null;
  onReconnect: () => void;
}) {
  const [autostart, setAutostart] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.axon?.autostart().then(setAutostart);
  }, []);

  const local = connection?.mode === 'embedded';

  return (
    <>
      <Section
        title="Доступ из сети"
        icon="bi-wifi"
        hint="По умолчанию ядро слушает только этот компьютер. Агент с доступом к файлам и оболочке не должен становиться сетевой службой без явного согласия."
      >
        {!local ? (
          <p className="text-[12px] text-text-dim">
            Вы подключены к удалённому ядру — его доступностью управляет та машина.
          </p>
        ) : (
          <>
            <Switch
              label="Открыть для устройств в локальной сети"
              hint="Ядро перезапустится и начнёт слушать все интерфейсы."
              on={Boolean(connection?.exposed)}
              disabled={busy}
              onToggle={() => {
                setBusy(true);
                void window
                  .axon!.setExposed(!connection?.exposed)
                  .then(() => onReconnect())
                  .finally(() => setBusy(false));
              }}
            />

            {connection?.exposed && connection.lan && connection.lan.length > 0 && (
              <Field label="Адреса для других устройств">
                <div className="flex flex-col gap-1">
                  {connection.lan.map((address) => (
                    <code
                      key={address}
                      className="px-2.5 py-1.5 rounded-lg bg-bg border border-border text-[12px] font-mono"
                    >
                      http://{address}
                    </code>
                  ))}
                </div>
              </Field>
            )}
          </>
        )}
      </Section>

      <Section
        title="Запуск вместе с системой"
        icon="bi-power"
        hint="Ядро — отдельная программа и живёт своей жизнью. С автозапуском рутины работают и уведомления приходят, даже когда приложение закрыто."
      >
        {autostart?.supported === false ? (
          <p className="text-[12px] text-text-dim">
            На этой системе автозапуск настраивается вручную.
          </p>
        ) : (
          <Switch
            label="Поднимать ядро при входе в систему"
            on={Boolean(autostart?.enabled)}
            disabled={!autostart}
            onToggle={() => {
              void window.axon!.setAutostart(!autostart?.enabled).then(setAutostart);
            }}
          />
        )}
      </Section>
    </>
  );
}

function LookPage({
  theme,
  onTheme,
  motion,
  onMotion,
}: {
  theme: ThemeId;
  onTheme: (theme: ThemeId) => void;
  motion: MotionId;
  onMotion: (motion: MotionId) => void;
}) {
  return (
    <>
      <Section title="Тема" icon="bi-palette-fill">
        <div className="grid grid-cols-2 gap-2">
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onTheme(item.id)}
              className={clsx(
                'flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-[13px] text-left transition-colors',
                theme === item.id
                  ? 'border-accent bg-accent/10 text-text'
                  : 'border-border text-text-muted hover:border-border-strong hover:text-text',
              )}
            >
              <i
                className={clsx('bi', item.icon, theme === item.id ? 'text-accent' : 'text-text-dim')}
              />
              <span className="flex-1 truncate">{item.label}</span>
              {theme === item.id && <i className="bi bi-check2 text-accent" />}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="Движение"
        icon="bi-fast-forward-fill"
        hint="Если система просит не двигать интерфейс, движение выключено сразу — это решение можно переопределить здесь."
      >
        <Switch
          label="Анимации"
          hint="Появление сообщений, шаги первоначальной настройки, мелкие подсветки."
          on={motion === 'full'}
          onToggle={() => onMotion(motion === 'full' ? 'off' : 'full')}
        />
      </Section>
    </>
  );
}

function AboutPage({
  client,
  connection,
  onRunSetup,
}: {
  client: AxonClient;
  connection: Connection | null;
  onRunSetup: () => void;
}) {
  const core = client.coreInfo;

  return (
    <>
      <Section title="Axon" icon="bi-info-circle-fill">
        <dl className="text-[12px] space-y-2">
          <Row label="Приложение" value={formatVersion(__APP_VERSION__)} />
          <Row label="Собрано" value={builtAt(__APP_BUILT_AT__)} />
          <Row
            label="Ядро"
            value={core ? formatVersion(core.version) : '—'}
            tone={core && compareVersions(core.version, __APP_VERSION__) < 0 ? 'warning' : undefined}
          />
          <Row
            label="Режим ядра"
            value={connection?.mode === 'remote' ? 'удалённое' : 'на этом компьютере'}
          />
          <Row label="Адрес" value={connection?.url ?? '—'} mono />
          <Row label="Идентификатор ядра" value={core?.coreId ?? '—'} mono />
        </dl>
      </Section>

      <Section
        title="Первоначальная настройка"
        icon="bi-magic"
        hint="Пройти заново — если хотите поменять ядро или провайдера с самого начала."
      >
        <button
          type="button"
          onClick={onRunSetup}
          className="h-9 px-4 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors flex items-center gap-2"
        >
          <i className="bi bi-magic" />
          Пройти настройку заново
        </button>
      </Section>
    </>
  );
}

function Row({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'warning' | undefined;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-40 shrink-0 text-text-dim">{label}</dt>
      <dd
        className={clsx(
          'min-w-0 flex-1 truncate',
          mono && 'font-mono text-[11px]',
          tone === 'warning' && 'text-warning',
        )}
      >
        {value}
        {tone === 'warning' && ' — старее приложения'}
      </dd>
    </div>
  );
}

/** Время сборки человеческим языком. Дата тега в номере, дата сборки здесь. */
function builtAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '—';
  return at.toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
}

export { Toggle };
