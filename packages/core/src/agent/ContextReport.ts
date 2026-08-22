import type { ContextPart, ContextReport } from '@axon/protocol';
import type { ProviderRegistry } from '../providers/ProviderRegistry.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';
import type { Store } from '../storage/Store.js';
import type { ToolRegistry, SelectOptions } from '../tools/ToolRegistry.js';
import { selectForPrompt } from '../memory/Observations.js';
import type { ContextBuilder } from './ContextBuilder.js';
import { composePersona } from './Persona.js';
import { estimateTokens } from './tokens.js';

export interface ContextReportInput {
  conversationId: string;
  /** Права устройства: от них зависит, какие схемы инструментов уедут. */
  access: SelectOptions;
}

export interface ContextReportDeps {
  store: Store;
  context: ContextBuilder;
  tools: ToolRegistry;
  skills: SkillRegistry;
  providers: ProviderRegistry;
}

/**
 * Из чего складывается следующий запрос к модели.
 *
 * Это единственное место в продукте, где видно, за что именно платит человек.
 * Обычно расход показывают постфактум одной цифрой — «потрачено столько-то», —
 * и с ней ничего нельзя сделать. Здесь наоборот: разбор до отправки и по
 * частям, каждую из которых можно уменьшить руками — выключить инструмент,
 * стереть факт, свернуть историю.
 *
 * Числа здесь — оценка (см. tokens.ts), и это честно сказано в интерфейсе.
 * Точные приходят от провайдера уже после ответа; смешивать их нельзя.
 */
export async function buildContextReport(
  deps: ContextReportDeps,
  input: ContextReportInput,
): Promise<ContextReport> {
  const parts: ContextPart[] = [];

  // ─── Стабильный префикс: то, что кэшируется провайдером ───────────────────

  const persona = composePersona(deps.store.settings.all());
  if (persona) {
    parts.push({
      key: 'persona',
      label: 'Личность',
      tokens: estimateTokens(persona),
      cached: true,
      detail: 'Настройки → личность',
    });
  }

  const facts = deps.store.facts.list();
  if (facts.length > 0) {
    const text = facts.map((fact) => `- ${fact.key}: ${fact.value}`).join('\n');
    parts.push({
      key: 'facts',
      label: 'Память о вас',
      tokens: estimateTokens(text),
      cached: true,
      detail: `${facts.length} ${plural(facts.length, 'факт', 'факта', 'фактов')}`,
    });
  }

  const observations = selectForPrompt(deps.store.observations.list());
  if (observations.length > 0) {
    const text = observations.map((observation) => `- ${observation.text}`).join('\n');
    parts.push({
      key: 'observations',
      label: 'Наблюдения',
      tokens: estimateTokens(text),
      cached: true,
      detail: `${observations.length} из ${deps.store.observations.list().length}: остальные выцвели`,
    });
  }

  const summary = deps.store.summaries.latest(input.conversationId);
  if (summary) {
    parts.push({
      key: 'summary',
      label: 'Сводка прошлой части разговора',
      tokens: summary.tokens ?? estimateTokens(summary.text),
      cached: true,
      detail: 'Заменяет собой всё, что было до неё',
    });
  }

  const skills = deps.skills.enabled();
  const catalog = deps.skills.catalogText();
  if (catalog) {
    parts.push({
      key: 'skills',
      label: 'Оглавление скиллов',
      tokens: estimateTokens(catalog),
      cached: true,
      detail:
        `${skills.length} ${plural(skills.length, 'скилл', 'скилла', 'скиллов')} — ` +
        `тела не в контексте, агент читает их сам`,
    });
  }

  // ─── Схемы инструментов ───────────────────────────────────────────────────

  const selected = deps.tools.select(input.access);
  const eager = selected.filter((tool) => !tool.deferred);
  const deferred = selected.filter((tool) => tool.deferred);

  if (eager.length > 0) {
    const tokens = eager.reduce(
      (sum, tool) =>
        sum + estimateTokens(tool.name + tool.description + JSON.stringify(tool.parameters)),
      0,
    );
    parts.push({
      key: 'tools',
      label: 'Схемы инструментов',
      tokens,
      cached: true,
      detail: `${eager.length} ${plural(eager.length, 'инструмент', 'инструмента', 'инструментов')} в каждом запросе`,
    });
  }

  if (deferred.length > 0) {
    parts.push({
      key: 'tools.deferred',
      label: 'Отложенные инструменты',
      tokens: 0,
      cached: true,
      detail:
        `${deferred.length} ${plural(deferred.length, 'штука', 'штуки', 'штук')} — ` +
        `схемы не грузятся, пока модель сама не спросит`,
    });
  }

  // ─── История ──────────────────────────────────────────────────────────────

  const history = summary
    ? deps.store.messages.after(input.conversationId, summary.upToOrd)
    : deps.store.messages.recent(input.conversationId, 40);

  if (history.length > 0) {
    let tokens = 0;
    let images = 0;
    for (const message of history) {
      for (const part of message.parts) {
        if (part.type === 'text') tokens += estimateTokens(part.text);
        else {
          images++;
          tokens += 1_500;
        }
      }
      for (const call of message.toolCalls ?? []) {
        tokens += estimateTokens(JSON.stringify(call.arguments)) + 10;
      }
    }
    parts.push({
      key: 'history',
      label: 'История разговора',
      tokens,
      cached: true,
      detail:
        `${history.length} ${plural(history.length, 'сообщение', 'сообщения', 'сообщений')}` +
        (images > 0 ? `, из них вложений: ${images}` : ''),
    });
  }

  // ─── Изменчивый хвост ─────────────────────────────────────────────────────

  const volatile = await deps.context.volatileParts({
    conversationId: input.conversationId,
    userText: '',
  });
  for (const contribution of volatile) {
    parts.push({
      key: `volatile:${contribution.name}`,
      label: contribution.name,
      tokens: estimateTokens(contribution.text),
      cached: false,
      detail: 'Меняется от хода к ходу — поэтому в хвосте, за точкой кэша',
    });
  }

  const total = parts.reduce((sum, part) => sum + part.tokens, 0);
  const cacheable = parts
    .filter((part) => part.cached)
    .reduce((sum, part) => sum + part.tokens, 0);

  const selection = safeSelection(deps.providers);

  return {
    parts,
    totalTokens: total,
    cacheableTokens: cacheable,
    ...(selection ? { provider: selection.id, model: selection.model } : {}),
    // Кэш промпта умеют не все: без него «кэшируемая часть» — просто число,
    // и обещать экономию было бы враньём.
    supportsPromptCache: selection?.supportsPromptCache ?? false,
  };
}

/**
 * Текущий провайдер, если он вообще настроен. Отчёт о контексте должен
 * открываться и на свежей установке, где ключа ещё нет.
 */
function safeSelection(
  providers: ProviderRegistry,
): { id: string; model: string; supportsPromptCache: boolean } | null {
  try {
    const current = providers.current();
    return {
      id: current.descriptor.title,
      model: current.model,
      supportsPromptCache: current.descriptor.supportsPromptCache,
    };
  } catch {
    return null;
  }
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
