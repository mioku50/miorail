import { createLlmProvider, type LlmProvider } from '@mioagent/llm';
import type { MirrorReport } from '@mioagent/still-engine/report';
import type { DividendWalletResponseV1 } from '@mioagent/rwa-market-reality/dividend-wallet';
import {
  agentAnswerV1,
  isRussianV1,
  type AgentAnswerV1,
  type DividendReadStateV1,
} from '../../../lib/ui/src/still/agentAnswers.js';
import { skyStateV1 } from '../../../lib/ui/src/still/skyState.js';

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

function verifyStillAgentNarrationV2(narration: string, base: AgentAnswerV1): string | null {
  const cleaned = narration.trim().replace(/^["«]|["»]$/g, '').trim();
  if (cleaned.length < 24 || cleaned.length > 950) return null;
  // Never allow a narration that claims autonomous execution or third-party transfer completion
  if (
    /(?:я\s+(?:уже\s+)?(?:подписал|отправил|перев[её]л|исполнил)|i\s+have\s+(?:signed|sent|transferred|executed)\s+the\s+transaction)/i.test(
      cleaned,
    )
  ) {
    return null;
  }
  // If action_prep refused third-party transfer, the narration must still state the refusal
  if (
    base.mode === 'action_prep' &&
    !/(?:не\s+(?:подписыва|исполня|отправля|перевож)|never\s+sign|do\s+not\s+(?:sign|execute|transfer|send)|только\s+подготов|only\s+prepare)/i.test(
      cleaned,
    )
  ) {
    return null;
  }
  return cleaned;
}

export async function answerStillAgentHybridV2(input: {
  question: string;
  report: MirrorReport | null;
  dividends?: DividendWalletResponseV1 | null;
  dividendsReadState?: DividendReadStateV1;
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
    dividends: input.dividends ?? null,
    dividendsReadState: input.dividendsReadState,
    signedIn: input.signedIn,
  });

  if (!base.needsLlm || !input.report) {
    return { ...base, needsLlm: false };
  }

  const provider = stillAgentLlmRuntimeV1.provider();
  if (!provider) {
    return { ...base, needsLlm: false };
  }

  const ru = isRussianV1(input.question);
  const systemPrompt = ru
    ? [
        'Ты — Still Agent v2, проверяемый финансовый аналитик портфеля на Base.',
        'Все финансовые расчёты уже выполнены детерминированным риск-движком Miorail.',
        'Твоя задача — ясно и лаконично (2–4 предложения, без markdown-заголовков и списков) объяснить пользователю результат расчёта.',
        'ЖЕСТКИЕ ПРАВИЛА:',
        '1. Используй ТОЛЬКО числа и факты из переданного расчёта риск-движка (BASELINE_ANSWER, STEPS, ENGINE_FACTS). Никогда не выдумывай свои числа и не пересчитывай их.',
        '2. Для режима action_prep прямо укажи, что агент не подписывает транзакции автоматически и не переводит средства третьим лицам, а только готовит проверенную транзакцию для подтверждения в кошельке.',
        '3. Отвечай строго на русском языке.',
      ].join('\n')
    : [
        'You are Still Agent v2, a verified portfolio financial analyst on Base.',
        'All financial math has already been computed by the deterministic Miorail Risk Engine.',
        'Your job is to explain the verified result clearly and concisely (2–4 sentences, plain text without markdown headings or bullet lists).',
        'STRICT RULES:',
        '1. Use ONLY the exact numbers and facts from BASELINE_ANSWER, STEPS, and ENGINE_FACTS. Never invent or alter any figure.',
        '2. For action_prep mode, explicitly state that the agent never signs transactions autonomously or transfers funds to third parties, and only prepares a verified review for wallet confirmation.',
        '3. Respond strictly in English.',
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
    const llmSource = ru
      ? 'ИИ · синтез OpenRouter (связан с числами риск-движка)'
      : 'AI · OpenRouter synthesis (bound to Risk Engine figures)';
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
