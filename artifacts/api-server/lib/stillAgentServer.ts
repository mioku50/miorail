import { createLlmProvider, type LlmProvider } from '@mioagent/llm';
import type { MirrorReport } from '@mioagent/still-engine/report';
import {
  agentAnswerV1,
  isRussianV1,
  type AgentAnswerV1,
} from '../../../lib/ui/src/still/agentAnswers.js';
import { skyStateV1 } from '../../../lib/ui/src/still/skyState.js';
import { formatCents } from '@mioagent/still-engine/format';
import { numbersInV1, stripNarrationFormattingV1 } from './b20AnswerVerify.js';

// ---------------------------------------------------------------------------
// The Agent's wording, walled in the way the B20 narrator is: the calculation
// is deterministic, and a model may only re-say it. A narration is shown only
// if every figure in it is one the reader can already see in the calculation
// (its sentence and its steps), and it neither advises nor claims to have
// acted. Anything else falls back to the deterministic answer, which is what
// the page shows without a model at all.
// ---------------------------------------------------------------------------

export const stillAgentLlmRuntimeV1: {
  provider: () => LlmProvider | null;
} = {
  provider: () => {
    try {
      return createLlmProvider();
    } catch {
      return null;
    }
  },
};

/** Advice is not ours to give, in either language the Agent answers in. */
const ADVICE_V2 =
  /\b(?:recommend\w*|you should|i suggest|safest|best (?:option|way|path))\b|рекоменд|совету|советую|следует|стоит (?:взять|занять|погасить|продать|купить)|лучше всего|самый безопасн|безопаснее всего/i;

/** "Every number must be in the evidence" is only as strong as the evidence is small. */
export const STILL_NARRATION_MAX_FIGURES_V2 = 40;

/** The allowed figures: what the reader already sees in the calculation. */
function evidenceFiguresV2(base: AgentAnswerV1): Set<string> {
  return new Set([base.text, ...(base.steps ?? [])].flatMap(numbersInV1));
}

/**
 * Figures a restatement may not drop, and the one claim it may not flip. A
 * fluent sentence with no numbers passes a number check while saying the
 * opposite, so the outcome itself is checked mechanically too.
 */
function decisiveFiguresV2(base: AgentAnswerV1): string[] {
  const facts = base.engineFacts ?? {};
  const cents = (value: unknown) => (typeof value === 'string' && /^\d+$/.test(value) ? numbersInV1(formatCents(value)) : []);
  if (facts.mode === 'stress_test') return typeof facts.hfAfter === 'string' ? numbersInV1(facts.hfAfter) : cents(facts.valueAfterCents);
  if (facts.mode === 'repay_options' && facts.fullPayoff !== true) return cents(facts.debtAfterCents);
  if (facts.mode === 'limit_change') return cents(facts.availableCents);
  return [];
}
// `\w` is ASCII-only in JS: Russian endings are spelled as a Cyrillic class.
const ENTERS_LIQUIDATION_V2 = /enter\w* (?:the )?liquidation|liquidation zone|be liquidated|зон[а-яё]* ликвидации|будет ликвидирован|ликвидируют/i;
const STAYS_SAFE_V2 = /remain\w* safe|stays? safe|останется безопасн|остаётся безопасн/i;

const ACTED_V2 =
  /(?:я\s+(?:уже\s+)?(?:подписал|отправил|перев[её]л|исполнил)|i\s+have\s+(?:signed|sent|transferred|executed)\s+the\s+transaction)/i;

export function verifyStillAgentNarrationV2(narration: string, base: AgentAnswerV1): string | null {
  const cleaned = stripNarrationFormattingV1(narration.trim().replace(/^["«]|["»]$/g, '').trim());
  if (cleaned.length < 24 || cleaned.length > 950) return null;
  // Never allow a narration that claims autonomous execution or third-party transfer completion
  if (ACTED_V2.test(cleaned) || ADVICE_V2.test(cleaned)) return null;
  // If action_prep refused third-party transfer, the narration must still state the refusal
  if (
    base.mode === 'action_prep' &&
    !/(?:не\s+(?:подписыва|исполня|отправля|перевож)|never\s+sign|do\s+not\s+(?:sign|execute|transfer|send)|только\s+подготов|only\s+prepare)/i.test(
      cleaned,
    )
  ) {
    return null;
  }
  // Every figure must already be on the reader's screen, and the decisive ones stay.
  const figures = numbersInV1(cleaned);
  const evidence = evidenceFiguresV2(base);
  if (figures.some((figure) => !evidence.has(figure))) return null;
  if (decisiveFiguresV2(base).some((figure) => !figures.includes(figure))) return null;
  // A stress test's outcome is a boolean: the wording may not flip it.
  if (base.engineFacts?.mode === 'stress_test' && typeof base.engineFacts.liquidatedAfter === 'boolean') {
    if (base.engineFacts.liquidatedAfter ? STAYS_SAFE_V2.test(cleaned) : ENTERS_LIQUIDATION_V2.test(cleaned)) return null;
  }
  return cleaned;
}

export async function answerStillAgentHybridV2(input: {
  question: string;
  report: MirrorReport | null;
  signedIn: boolean;
  now?: Date;
}): Promise<AgentAnswerV1> {
  const sky = skyStateV1({
    now: input.now ?? new Date(),
  });
  const base = agentAnswerV1({
    question: input.question,
    report: input.report,
    sky,
    signedIn: input.signedIn,
  });

  if (!base.needsLlm || !input.report || evidenceFiguresV2(base).size > STILL_NARRATION_MAX_FIGURES_V2) {
    return { ...base, needsLlm: false };
  }

  const provider = stillAgentLlmRuntimeV1.provider();
  if (!provider) {
    return { ...base, needsLlm: false };
  }

  const ru = isRussianV1(input.question);
  const systemPrompt = ru
    ? [
        'Ты пересказываешь готовый расчёт Still о кошельке пользователя на Base.',
        'Все финансовые расчёты уже выполнены детерминированным кодом Miorail.',
        'Твоя задача — ясно и лаконично (2–4 предложения, без markdown-заголовков и списков) пересказать результат расчёта.',
        'ЖЕСТКИЕ ПРАВИЛА:',
        '1. Используй ТОЛЬКО числа из BASELINE_ANSWER и STEPS, в том же виде. Никогда не выдумывай свои числа и не пересчитывай их.',
        '2. Не давай советов и рекомендаций: не говори, что выбрать, что безопаснее или что стоит сделать.',
        '3. Для режима action_prep прямо укажи, что агент не подписывает транзакции автоматически и не переводит средства третьим лицам, а только готовит проверку для подтверждения в кошельке.',
        '4. Не представляйся и не называй версий. Отвечай строго на русском языке.',
      ].join('\n')
    : [
        "You restate Still's finished calculation about the reader's wallet on Base.",
        'All financial math has already been computed by deterministic Miorail code.',
        'Your job is to restate the result clearly and concisely (2–4 sentences, plain text without markdown headings or bullet lists).',
        'STRICT RULES:',
        '1. Use ONLY the figures in BASELINE_ANSWER and STEPS, written the same way. Never invent or alter any figure.',
        '2. Give no advice or recommendation: never say what to choose, what is safest or what the reader should do.',
        '3. For action_prep mode, explicitly state that the agent never signs transactions autonomously or transfers funds to third parties, and only prepares a review for wallet confirmation.',
        '4. Do not introduce yourself or name versions. Respond strictly in English.',
      ].join('\n');

  const userPayload = JSON.stringify(
    {
      question: input.question,
      mode: base.mode,
      baselineAnswer: base.text,
      steps: base.steps ?? [],
      engineFacts: base.engineFacts ?? {},
    },
    null,
    2,
  );

  try {
    const response = await provider.generate({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPayload },
      ],
      temperature: 0.1,
      reasoningEffort: 'none',
      timeoutMs: 12_000,
    });
    const verifiedText = verifyStillAgentNarrationV2(response.message.content ?? '', base);
    if (!verifiedText) {
      return { ...base, needsLlm: false };
    }
    // The chain can fall over to a spare provider, so the line names the
    // check, not a vendor.
    const llmSource = ru
      ? 'ИИ · пересказ; каждое число сверено с расчётом'
      : 'AI · wording only; every figure checked against the calculation';
    return {
      ...base,
      text: verifiedText,
      sources: [...base.sources, llmSource],
      needsLlm: false,
    };
  } catch {
    return { ...base, needsLlm: false };
  }
}
