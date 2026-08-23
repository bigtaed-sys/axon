import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { AxonClient } from '@axon/client-sdk';
import type { ProviderInfo } from '@axon/protocol';
import type { Connection } from '../useAxon.js';
import { host } from '../host.js';
import { copyText } from '../clipboard.js';

/**
 * Что показать при первом знакомстве.
 *
 * Здесь только редакторский текст — ядру взять его неоткуда. Всё техническое,
 * включая имя ключа в секретах, приходит от ядра командой `provider.list`:
 * продублируй мы его тут, и однажды визард молча запишет ключ не туда, где
 * его потом станет искать провайдер.
 */
const PROVIDERS = [
  {
    id: 'anthropic',
    title: 'Anthropic',
    note: 'Самые сильные модели и лучший кэш промпта',
    link: 'console.anthropic.com',
  },
  {
    id: 'deepseek',
    title: 'DeepSeek',
    note: 'Дёшево и с кэшем — хороший выбор на каждый день',
    link: 'platform.deepseek.com',
  },
  {
    id: 'openai',
    title: 'OpenAI',
    note: 'Привычные модели GPT',
    link: 'platform.openai.com',
  },
  {
    id: 'ollama',
    title: 'Ollama',
    note: 'Локальные модели, без ключа и без оплаты',
    link: '',
  },
];

type StepId = 'hello' | 'where' | 'remote' | 'local' | 'provider' | 'done';

/**
 * Первоначальная настройка.
 *
 * Ведёт по одному решению за шаг и объясняет только то, что нужно для этого
 * решения. Главная мысль, которую визард должен донести: ядро и приложение —
 * разные вещи, и ядру лучше жить отдельно от ноутбука.
 */
export function SetupWizard({
  client,
  connection,
  onFinish,
  onReconnect,
}: {
  client: AxonClient | null;
  connection: Connection | null;
  onFinish: () => void;
  onReconnect: () => void;
}) {
  const [step, setStep] = useState<StepId>('hello');
  const [forward, setForward] = useState(true);

  const go = (next: StepId, back = false): void => {
    setForward(!back);
    setStep(next);
  };

  const order: StepId[] = ['hello', 'where', 'provider', 'done'];
  const position = Math.max(0, order.indexOf(step === 'remote' || step === 'local' ? 'where' : step));

  return (
    <div className="flex-1 overflow-y-auto scrollbar">
      <div className="max-w-xl mx-auto px-6 py-10 min-h-full flex flex-col">
        <Progress position={position} total={order.length} />

        <div key={step} className={clsx('flex-1', forward ? 'step-forward' : 'step-back')}>
          {step === 'hello' && <Hello onNext={() => go('where')} onSkip={onFinish} />}

          {step === 'where' && (
            <Where onRemote={() => go('remote')} onLocal={() => go('local')} />
          )}

          {step === 'remote' && (
            <Remote
              onBack={() => go('where', true)}
              onConnected={() => {
                onReconnect();
                go('provider');
              }}
            />
          )}

          {step === 'local' && (
            <Local onBack={() => go('where', true)} onNext={() => go('provider')} />
          )}

          {step === 'provider' && (
            <Provider client={client} onBack={() => go('where', true)} onNext={() => go('done')} />
          )}

          {step === 'done' && <Done connection={connection} onFinish={onFinish} />}
        </div>
      </div>
    </div>
  );
}

function Progress({ position, total }: { position: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-8">
      {Array.from({ length: total }, (_, index) => (
        <span
          key={index}
          className={clsx(
            'step-dot h-1 rounded-full',
            index === position ? 'w-8 bg-accent' : index < position ? 'w-4 bg-accent/40' : 'w-4 bg-border',
          )}
        />
      ))}
    </div>
  );
}

// ─── Шаги ───────────────────────────────────────────────────────────────────

function Hello({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  return (
    <div className="text-center">
      <CoreDiagram />

      <h1 className="mt-8 text-[22px] font-semibold tracking-tight rise" style={cssIndex(0)}>
        Это Axon
      </h1>
      <p
        className="mt-2.5 text-[13px] text-text-muted leading-relaxed max-w-md mx-auto rise"
        style={cssIndex(1)}
      >
        Он состоит из двух частей. <span className="text-text">Ядро</span> хранит переписку,
        память и ключи и разговаривает с моделью. <span className="text-text">Приложения</span> —
        это окна к нему: десктоп, телефон, что угодно ещё.
      </p>
      <p className="mt-2 text-[13px] text-text-muted leading-relaxed max-w-md mx-auto rise" style={cssIndex(2)}>
        Дальше — три коротких шага: где поселить ядро и чем оно будет думать.
      </p>

      <div className="mt-8 flex flex-col items-center gap-2 rise" style={cssIndex(3)}>
        <Primary onClick={onNext}>Начать настройку</Primary>
        <button
          type="button"
          onClick={onSkip}
          className="text-[12px] text-text-dim hover:text-text transition-colors"
        >
          Пропустить, разберусь сам
        </button>
      </div>
    </div>
  );
}


/** Ядро в центре, устройства вокруг, связи прочерчиваются одна за другой. */
function CoreDiagram() {
  return (
    // Высота с запасом: подпись нижнего узла уходит на 26 пикселей вниз от
    // его центра и в более тесную рамку не помещается.
    <svg viewBox="0 0 240 156" className="w-full max-w-[300px] mx-auto">
      <g stroke="rgb(var(--c-border-strong))" strokeWidth="1" fill="none">
        <line x1="120" y1="70" x2="42" y2="34" className="draw" style={cssIndex(0, 90)} />
        <line x1="120" y1="70" x2="198" y2="34" className="draw" style={cssIndex(1, 90)} />
        <line x1="120" y1="70" x2="120" y2="122" className="draw" style={cssIndex(2, 60)} />
      </g>

      {[0, 1, 2].map((index) => (
        <circle
          key={index}
          cx="120"
          cy="70"
          r="22"
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth="1"
          className="ring"
          style={{ ...cssIndex(index), transformOrigin: '120px 70px' }}
        />
      ))}

      <circle cx="120" cy="70" r="22" fill="rgb(var(--c-accent))" />

      {/* Значок ядра рисуем контуром, а не символом шрифта: иконочный шрифт
          внутри SVG подхватывается не везде и оставляет пустоту. */}
      <g stroke="rgb(var(--c-accent-fg))" strokeWidth="1.5" strokeLinecap="round" fill="none">
        <rect x="112" y="62" width="16" height="16" rx="3.5" />
        <path d="M116 57.5v4.5M124 57.5v4.5M116 78v4.5M124 78v4.5M107.5 66h4.5M107.5 74h4.5M128 66h4.5M128 74h4.5" />
      </g>

      {[
        { x: 42, y: 34, label: 'десктоп' },
        { x: 198, y: 34, label: 'телефон' },
        { x: 120, y: 122, label: 'телеграм' },
      ].map((node, index) => (
        <g key={node.label} className="rise" style={cssIndex(index + 3)}>
          <circle
            cx={node.x}
            cy={node.y}
            r="13"
            fill="rgb(var(--c-surface-3))"
            stroke="rgb(var(--c-border))"
          />
          <text
            x={node.x}
            y={node.y + 26}
            textAnchor="middle"
            fontSize="8"
            fill="rgb(var(--c-text-dim))"
          >
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}


function Where({ onRemote, onLocal }: { onRemote: () => void; onLocal: () => void }) {
  return (
    <div>
      <Title icon="bi-hdd-network">Где поселить ядро</Title>
      <Subtitle>
        Ядро работает круглосуточно: отвечает в телеграме, выполняет рутины, помнит. Поэтому
        вопрос не в мощности, а в том, что должно быть включено.
      </Subtitle>

      <button
        type="button"
        onClick={onRemote}
        className="w-full card p-4 text-left mt-6 hover:border-accent transition-colors rise group"
        style={cssIndex(0)}
      >
        <div className="flex items-start gap-3">
          <i className="bi bi-server text-[20px] text-accent mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium">На сервере или другом компьютере</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent text-accent-fg font-medium">
                советую
              </span>
            </div>
            <p className="mt-1.5 text-[12px] text-text-muted leading-relaxed">
              Ядро доступно всегда и со всех устройств, а ноутбук можно закрывать и увозить.
              Подойдёт любая машина с Node — от домашнего мини-ПК до дешёвой VPS.
            </p>
          </div>
          <i className="bi bi-chevron-right text-text-dim group-hover:text-text transition-colors" />
        </div>
      </button>

      <button
        type="button"
        onClick={onLocal}
        className="w-full card p-4 text-left mt-2 hover:border-border-strong transition-colors rise group"
        style={cssIndex(1)}
      >
        <div className="flex items-start gap-3">
          <i className="bi bi-pc-display text-[20px] text-text-muted mt-0.5" />
          <div className="min-w-0 flex-1">
            <span className="text-[14px] font-medium">На этом компьютере</span>
            <p className="mt-1.5 text-[12px] text-text-muted leading-relaxed">
              Ничего ставить не нужно, всё заработает сразу. Но агент живёт ровно столько,
              сколько включён этот компьютер, и с телефона до него не дотянуться из другой сети.
            </p>
          </div>
          <i className="bi bi-chevron-right text-text-dim group-hover:text-text transition-colors" />
        </div>
      </button>
    </div>
  );
}

function Remote({ onBack, onConnected }: { onBack: () => void; onConnected: () => void }) {
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const install = 'npm install -g @axon-assistant/core && axon start --host 0.0.0.0';

  const connect = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await host().connectRemote({ url, code, name: 'Десктоп' });
      onConnected();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Title icon="bi-server">Ядро на другой машине</Title>
      <Subtitle>Выполните это на сервере — понадобится Node 22.5 или новее.</Subtitle>

      <div className="mt-5 rounded-xl2 border border-border bg-bg overflow-hidden rise" style={cssIndex(0)}>
        <div className="flex items-center justify-between px-3 py-1.5 bg-surface-high border-b border-border">
          <span className="text-[10px] uppercase tracking-wider text-text-dim font-mono">
            терминал сервера
          </span>
          <button
            type="button"
            onClick={async () => {
              if (!(await copyText(install))) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className={clsx(
              'px-2 py-0.5 rounded flex items-center gap-1 text-[11px] transition-colors',
              copied ? 'bg-success/15 text-success' : 'text-text-muted hover:text-text',
            )}
          >
            <i className={clsx('bi', copied ? 'bi-check2' : 'bi-clipboard')} />
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
        <pre className="p-3 font-mono text-[11.5px] leading-relaxed overflow-x-auto scrollbar">
          {install}
        </pre>
      </div>

      <p className="mt-3 text-[12px] text-text-muted leading-relaxed rise" style={cssIndex(1)}>
        Ядро напечатает адрес и код подключения. Введите их здесь — код одноразовый.
      </p>

      <div className="mt-4 space-y-2 rise" style={cssIndex(2)}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="адрес, например 192.168.1.50:8787"
          className="input font-mono text-[12px]"
        />
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          className="input font-mono tracking-[0.2em] text-center"
        />
      </div>

      {failure && <p className="mt-3 text-[12px] text-danger">{failure}</p>}

      <Nav
        onBack={onBack}
        primary={{
          label: busy ? 'Подключаюсь…' : 'Подключиться',
          onClick: () => void connect(),
          disabled: !url.trim() || !code.trim() || busy,
        }}
      />
    </div>
  );
}

function Local({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const [autostart, setAutostart] = useState<{ supported: boolean; enabled: boolean } | null>(null);

  useEffect(() => {
    void host().local?.autostart().then(setAutostart);
  }, []);

  return (
    <div>
      <Title icon="bi-pc-display">Ядро на этом компьютере</Title>
      <Subtitle>
        Оно уже работает — ставить ничего не нужно. Осталось решить, поднимать ли его при входе
        в систему.
      </Subtitle>

      <div className="card p-4 mt-5 rise" style={cssIndex(0)}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium">Запускать ядро при входе в систему</p>
            <p className="mt-1.5 text-[12px] text-text-muted leading-relaxed">
              Без этого агент поднимается только вместе с приложением. С ним — работает в фоне
              и после перезагрузки: отвечает в телеграме, выполняет рутины.
            </p>
          </div>
          <button
            type="button"
            disabled={!autostart?.supported}
            onClick={async () => setAutostart(await host().local!.setAutostart(!autostart?.enabled))}
            className={clsx(
              'mt-0.5 w-9 h-5 shrink-0 rounded-full transition-colors disabled:opacity-40',
              autostart?.enabled ? 'bg-accent' : 'bg-surface-high border border-border',
            )}
          >
            <span
              className={clsx(
                'block w-4 h-4 rounded-full transition-transform',
                autostart?.enabled ? 'translate-x-[18px] bg-accent-fg' : 'translate-x-0.5 bg-text-dim',
              )}
            />
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2 text-[11px] text-text-dim leading-relaxed rise" style={cssIndex(1)}>
        <i className="bi bi-info-circle mt-0.5" />
        <span>
          Передумаете — ядро всегда можно перенести на сервер: в настройках есть выбор ядра.
        </span>
      </div>

      <Nav onBack={onBack} primary={{ label: 'Дальше', onClick: onNext }} />
    </div>
  );
}

function Provider({
  client,
  onBack,
  onNext,
}: {
  client: AxonClient | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const [selected, setSelected] = useState('anthropic');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [known, setKnown] = useState<ProviderInfo[]>([]);

  /**
   * Имена ключей берём у ядра, а не из своего списка.
   *
   * Здесь остаются только пояснения — их ядру взять неоткуда, это редакторский
   * текст для первого знакомства. А вот `secretKey` продублировать нельзя:
   * разойдись эти две записи, и визард молча запишет ключ не туда, где его
   * потом будет искать провайдер.
   */
  useEffect(() => {
    if (!client) return;
    void client
      .call('provider.list', {})
      .then((res) => setKnown(res.providers))
      .catch(() => setKnown([]));
  }, [client]);

  const note = PROVIDERS.find((p) => p.id === selected);
  const provider = known.find((p) => p.id === selected);
  // Пока список от ядра не приехал, ключ спрашиваем у всех, кроме локальных:
  // лучше показать лишнее поле, чем не дать ввести ключ вовсе.
  const needsKey = provider ? provider.requiresKey : selected !== 'ollama';

  const save = async (): Promise<void> => {
    if (!client) return onNext();
    setBusy(true);
    setFailure(null);
    try {
      await client.call('settings.set', {
        values: { 'provider.active': selected },
        ...(provider?.secretKey && key.trim()
          ? { secrets: { [provider.secretKey]: key.trim() } }
          : {}),
      });
      onNext();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Title icon="bi-cpu">Чем будет думать</Title>
      <Subtitle>Ключ хранится в ядре в зашифрованном виде и наружу не отдаётся.</Subtitle>

      <div className="mt-5 grid grid-cols-2 gap-2">
        {PROVIDERS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSelected(item.id)}
            className={clsx(
              'card p-3 text-left transition-colors rise',
              selected === item.id ? 'border-accent' : 'hover:border-border-strong',
            )}
            style={cssIndex(index)}
          >
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-medium">{item.title}</span>
              {selected === item.id && <i className="bi bi-check2 text-accent" />}
            </div>
            <p className="mt-1 text-[11px] text-text-muted leading-relaxed">{item.note}</p>
          </button>
        ))}
      </div>

      {needsKey && (
        <div className="mt-4 rise" style={cssIndex(4)}>
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="ключ доступа"
            className="input"
          />
          <p className="mt-2 text-[11px] text-text-dim">
            Получить можно на {note?.link ?? provider?.keyUrl}. Можно пропустить и вписать позже в
            настройках.
          </p>
        </div>
      )}

      {failure && <p className="mt-3 text-[12px] text-danger">{failure}</p>}

      <Nav
        onBack={onBack}
        primary={{ label: busy ? 'Сохраняю…' : 'Дальше', onClick: () => void save(), disabled: busy }}
      />
    </div>
  );
}

function Done({ connection, onFinish }: { connection: Connection | null; onFinish: () => void }) {
  return (
    <div className="text-center">
      <svg viewBox="0 0 80 80" className="w-20 h-20 mx-auto">
        <circle cx="40" cy="40" r="30" fill="none" stroke="rgb(var(--c-success))" strokeWidth="1.5" opacity="0.35" />
        {[0, 1].map((index) => (
          <circle
            key={index}
            cx="40"
            cy="40"
            r="30"
            fill="none"
            stroke="rgb(var(--c-success))"
            strokeWidth="1"
            className="ring"
            style={{ ...cssIndex(index), transformOrigin: '40px 40px' }}
          />
        ))}
        <path
          d="M27 41 l9 9 l17 -19"
          fill="none"
          stroke="rgb(var(--c-success))"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="check-draw"
        />
      </svg>

      <h1 className="mt-6 text-[22px] font-semibold tracking-tight rise" style={cssIndex(0)}>
        Готово
      </h1>
      <p className="mt-2.5 text-[13px] text-text-muted leading-relaxed max-w-sm mx-auto rise" style={cssIndex(1)}>
        {connection?.mode === 'remote'
          ? `Приложение подключено к ядру ${connection.label ?? connection.url}. Оно работает само по себе, а это окно — просто один из клиентов.`
          : 'Ядро работает на этом компьютере отдельной программой и не закрывается вместе с окном.'}
      </p>

      <div className="mt-6 flex flex-col gap-2 max-w-xs mx-auto text-left">
        {[
          { icon: 'bi-shield-check', text: 'Опасные действия агент делает только с вашего согласия' },
          { icon: 'bi-hdd-network', text: 'Другие устройства подключаются по коду из раздела «Устройства»' },
          { icon: 'bi-speedometer2', text: 'Расход токенов виден в разделе «Расход»' },
        ].map((hint, index) => (
          <div
            key={hint.icon}
            className="flex items-start gap-2.5 text-[12px] text-text-muted rise"
            style={cssIndex(index + 2)}
          >
            <i className={clsx('bi', hint.icon, 'text-accent mt-0.5')} />
            <span className="leading-relaxed">{hint.text}</span>
          </div>
        ))}
      </div>

      <div className="mt-8 rise" style={cssIndex(5)}>
        <Primary onClick={onFinish}>Перейти в чат</Primary>
      </div>
    </div>
  );
}

// ─── Мелочи ─────────────────────────────────────────────────────────────────

function Title({ icon, children }: { icon: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <i className={clsx('bi', icon, 'text-[19px] text-accent')} />
      <h1 className="text-[19px] font-semibold tracking-tight">{children}</h1>
    </div>
  );
}

function Subtitle({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[13px] text-text-muted leading-relaxed">{children}</p>;
}

function Primary({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-10 px-6 rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors"
    >
      {children}
    </button>
  );
}

function Nav({
  onBack,
  primary,
}: {
  onBack: () => void;
  primary: { label: string; onClick: () => void; disabled?: boolean };
}) {
  return (
    <div className="mt-8 flex items-center gap-2">
      <button
        type="button"
        onClick={onBack}
        className="h-10 px-4 rounded-xl2 border border-border text-[13px] text-text-muted hover:bg-bg-hover hover:text-text transition-colors"
      >
        Назад
      </button>
      <button
        type="button"
        onClick={primary.onClick}
        disabled={primary.disabled}
        className="h-10 flex-1 rounded-xl2 bg-accent text-accent-fg hover:bg-accent-hover text-[13px] font-medium transition-colors disabled:opacity-40"
      >
        {primary.label}
      </button>
    </div>
  );
}

/** Порядковый номер для ступенчатой анимации и длина линии для прочерчивания. */
function cssIndex(index: number, length?: number): React.CSSProperties {
  return { '--i': index, ...(length ? { '--len': length } : {}) } as React.CSSProperties;
}
