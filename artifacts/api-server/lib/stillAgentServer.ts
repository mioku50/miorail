import { createLlmProvider, createStructuredLlmProvider, type LlmProvider } from '@mioagent/llm';
import type { MirrorReadingV1 } from '@mioagent/still-engine';
import { formatCents } from '@mioagent/still-engine/format';
import {
  agentAnswerV1,
  agentCapabilitiesV2,
  agentRouteV2,
  agentSwapAnswerV2,
  agentSwapRequestV2,
  isRussianV1,
  type AgentAnswerV1,
} from '../../../lib/ui/src/still/agentAnswers.js';
import { skyStateV1 } from '../../../lib/ui/src/still/skyState.js';
import { numbersInV1, stripNarrationFormattingV1 } from './b20AnswerVerify.js';
import { resolveBaseNameV1, type BaseNameResolutionV1 } from './baseNameResolver.js';
import { stillAgentSendAnswerV1 } from './stillAgentSend.js';
import { groundProposalV1, modelProposalV1, planSummaryV1, rulesProposalV1 } from './stillAgentPlan.js';
import { stillAgentToolAnswerV1 } from './stillAgentTools.js';
import { earlierStillReadingV1, rememberStillReadingV1, stillReadingChangeV1 } from './stillReadings.js';
import { modelBudgetRuntimeV1 } from './modelBudget.js';

// ---------------------------------------------------------------------------
// The Still Agent, end to end, on the server.
//
//   read     the session wallet's own report and the chain reading under it
//   route    the page's one rule: a direct read, a request to act, a
//            transfer, or a calculation (lib/ui/src/still/agentAnswers.ts)
//   plan     fixed rules first; a model reads only what they do not, and
//            every number, asset and loan it proposes must be in the words
//   compute  the Mirror engine, on the same reading with the change applied
//   word     a model may re-say the answer; it is shown only if every figure
//            is the calculation's, the decisive one stays, the outcome is not
//            flipped and nothing advises or claims to have acted
//
// Each stage is reported as it happens, so the page shows the work being done
// rather than an animation. Any failure lands on the deterministic answer.
// ---------------------------------------------------------------------------

export const stillAgentLlmRuntimeV1: {
  planner: () => LlmProvider | null;
  narrator: () => LlmProvider | null;
} = {
  // Reading a question into a closed JSON contract is the structured lane's job.
  planner: () => {
    try {
      return createStructuredLlmProvider();
    } catch {
      return null;
    }
  },
  narrator: () => {
    try {
      return createLlmProvider();
    } catch {
      return null;
    }
  },
};

export type StillAgentStageV1 =
  | { stage: 'reading' }
  | { stage: 'read'; block: string; blockTime: string }
  | { stage: 'understanding' }
  | { stage: 'understood'; summary: string; by: 'rules' | 'model' }
  | { stage: 'computing'; summary: string }
  | { stage: 'computed'; figures: number }
  | { stage: 'resolving'; summary: string }
  | { stage: 'resolved'; summary: string }
  | { stage: 'wording' }
  | { stage: 'checked'; verified: boolean; figures: number };

/** Advice is not ours to give, in either language the Agent answers in. Since audit MCP-2 (2026-11-14) it
 * also covers the softer forms a model reaches for ("you may want to", "it is a good idea", «имеет смысл»,
 * «стоит внести»), which passed the short list. `\b` is ASCII-only, so Russian words end in a class. */
const ADVICE_V2 = new RegExp([
  String.raw`\b(?:recommend\w*|you should|i suggest|safest|best (?:option|way|path)|consider|(?:may|might) want|good idea|wise to|would be wise|ought to|you need to|you must|make sure|better to)\b`,
  'рекоменд', 'совету', 'советую', 'следует', String.raw`стоит\s+[а-яё]+`, 'лучше(?![а-яё])', 'самый безопасн', 'безопаснее всего',
  'имеет смысл', 'нужно(?![а-яё])', 'надо(?![а-яё])', 'не помешает', 'разумно', 'желательно',
].join('|'), 'i');

/**
 * What a re-wording may never claim, whatever was calculated (audit MCP-2, 2026-11-14). Liquidation is
 * bounded, never excluded: a scenario's engine says "stays out of liquidation" for the drop it was asked,
 * and a model turned that into "liquidation is impossible", "risk-free", «ликвидация вам не грозит» or
 * «займ полностью защищён», which every check passed and the page showed as "every figure checked". A
 * re-wording that says any of these is not shown; the calculation's own words are.
 */
const ABSOLUTE_V2 = new RegExp([
  'impossib', String.raw`risk[- ]?free`, 'guarantee', String.raw`no (?:liquidation )?risk`, String.raw`without (?:any )?risk`, 'zero risk',
  String.raw`can(?:not|['’]t) be liquidated`, 'never be liquidated', String.raw`won['’]t be liquidated`, String.raw`(?:fully|completely|totally|100%) (?:safe|protected|secure)`,
  'nothing to worry', 'no need to worry',
  'не грозит', 'исключен', 'невозможн', 'гарант', 'полностью защищ', 'полностью безопас', String.raw`без\s+(?:всякого\s+|какого-либо\s+)?риск`, 'безрисков',
  String.raw`(?:нет|никакого)\s+риск`, String.raw`риска?\s+нет`, 'не о чем беспокоиться', 'можно не беспокоиться', String.raw`не\s+(?:будет|может быть)\s+ликвидир`, 'не ликвидируют',
].join('|'), 'i');

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
  if (facts.mode === 'scenario') return typeof facts.hfAfter === 'string' ? numbersInV1(facts.hfAfter) : cents(facts.roomAfterCents);
  if (facts.mode === 'repay_options') return cents(facts.debtAfterCents);
  if (facts.mode === 'interest') return cents(facts.totalCents);
  if (facts.mode === 'limit') return cents(facts.availableCents);
  return [];
}
// `\w` is ASCII-only in JS: Russian endings are spelled as a Cyrillic class.
const ENTERS_LIQUIDATION_V2 = /enter\w* (?:the )?liquidation|liquidation zone|be liquidated|can be liquidated|зон[а-яё]* ликвидации|будет ликвидирован|может быть ликвидирован|ликвидируют/i;
const STAYS_SAFE_V2 = /remain\w* safe|stays? safe|stays? out of liquidation|не доходит до ликвидации|останется безопасн|остаётся безопасн/i;

const ACTED_V2 =
  /(?:я\s+(?:уже\s+)?(?:подписал|отправил|перев[её]л|исполнил|погасил|занял)|i\s+(?:have\s+)?(?:signed|sent|transferred|executed|repaid|borrowed)\b)/i;

export function verifyStillAgentNarrationV2(narration: string, base: AgentAnswerV1): string | null {
  const cleaned = stripNarrationFormattingV1(narration.trim().replace(/^["«]|["»]$/g, '').trim());
  if (cleaned.length < 24 || cleaned.length > 950) return null;
  if (ACTED_V2.test(cleaned) || ADVICE_V2.test(cleaned) || ABSOLUTE_V2.test(cleaned)) return null;
  // Every figure must already be on the reader's screen, and the decisive ones stay.
  const figures = numbersInV1(cleaned);
  const evidence = evidenceFiguresV2(base);
  if (figures.some((figure) => !evidence.has(figure))) return null;
  if (decisiveFiguresV2(base).some((figure) => !figures.includes(figure))) return null;
  // A scenario's outcome is a boolean: the wording may not flip it.
  if (base.engineFacts?.mode === 'scenario' && typeof base.engineFacts.liquidatedAfter === 'boolean') {
    if (base.engineFacts.liquidatedAfter ? STAYS_SAFE_V2.test(cleaned) : ENTERS_LIQUIDATION_V2.test(cleaned)) return null;
  }
  return cleaned;
}

function narratorPromptV2(ru: boolean): string {
  return ru
    ? [
        'Ты пересказываешь готовый расчёт Still о кошельке пользователя на Base.',
        'Все финансовые расчёты уже выполнены детерминированным кодом.',
        'Перескажи результат ясно и коротко: 2–4 предложения, обычный текст без заголовков и списков.',
        'ЖЁСТКИЕ ПРАВИЛА:',
        '1. Используй ТОЛЬКО числа из BASELINE и STEPS, в том же виде. Не выдумывай и не пересчитывай числа.',
        '2. Сохрани главный итог: health factor после изменения, остаток долга, сумму процентов или запас.',
        '3. Не давай советов: не говори, что выбрать, что безопаснее или что стоит сделать.',
        '4. Не утверждай, что что-то подписано или отправлено.',
        '5. Не представляйся. Отвечай по-русски.',
      ].join('\n')
    : [
        "You restate Still's finished calculation about the reader's wallet on Base.",
        'All financial math has already been computed by deterministic code.',
        'Restate the result clearly and briefly: 2–4 sentences, plain text without headings or lists.',
        'STRICT RULES:',
        '1. Use ONLY the figures in BASELINE and STEPS, written the same way. Never invent or recompute a figure.',
        '2. Keep the main result: the health factor after the change, the debt left, the interest total or the room.',
        '3. Give no advice: never say what to choose, what is safest or what the reader should do.',
        '4. Never claim anything was signed or sent.',
        '5. Do not introduce yourself. Answer in English.',
      ].join('\n');
}

/** Whether one more model call fits the server's one budget (audit MCP-5): a refusal is no call, and the
 * Agent answers by its fixed rules alone. */
async function modelPlaceV2(clientKey: string): Promise<boolean> {
  try {
    await modelBudgetRuntimeV1.budget.take(clientKey);
    return true;
  } catch {
    return false;
  }
}

async function narrateV2(base: AgentAnswerV1, question: string, ru: boolean, stage: (s: StillAgentStageV1) => void, modelClient: string): Promise<AgentAnswerV1> {
  const figures = evidenceFiguresV2(base).size;
  if (figures > STILL_NARRATION_MAX_FIGURES_V2) return base;
  const narrator = stillAgentLlmRuntimeV1.narrator();
  if (!narrator) return base;
  // The calculation's own words stand when the model budget is spent.
  if (!(await modelPlaceV2(modelClient))) return base;
  stage({ stage: 'wording' });
  try {
    const response = await narrator.generate({
      messages: [
        { role: 'system', content: narratorPromptV2(ru) },
        { role: 'user', content: JSON.stringify({ question, baseline: base.text, steps: base.steps ?? [] }, null, 2) },
      ],
      temperature: 0.1,
      reasoningEffort: 'none',
      timeoutMs: 12_000,
    });
    const verified = verifyStillAgentNarrationV2(response.message.content ?? '', base);
    stage({ stage: 'checked', verified: verified !== null, figures });
    if (!verified) return base;
    // The chain can fall over to a spare provider, so the line names the check, not a vendor.
    const source = ru ? 'ИИ · пересказ; каждое число сверено с расчётом' : 'AI · wording only; every figure checked against the calculation';
    return { ...base, text: verified, sources: [...base.sources, source] };
  } catch {
    stage({ stage: 'checked', verified: false, figures });
    return base;
  }
}

function capabilitiesAnswerV2(ru: boolean, unread = false, busy = false): AgentAnswerV1 {
  const lead = busy
    ? (ru ? 'Модель, которая читает вопросы своими словами, сейчас занята для всех, поэтому я прочитал этот вопрос только по своим правилам. '
      : 'The model that reads questions in other words is busy for everyone just now, so I read this one by my fixed rules only. ')
    : unread ? (ru ? 'Я не смог прочитать этот вопрос как расчёт. ' : 'I could not read that question as a calculation. ') : '';
  return { topic: null, text: lead + agentCapabilitiesV2(ru), sources: [] };
}

export interface StillAgentAskV3 {
  question: string;
  /** The session's wallet, lower case. */
  wallet: string;
  /** The wallet's report and its chain reading: the same cached service as /mine. */
  read: () => Promise<MirrorReadingV1>;
  /** The wallet's USDC, for "swap all my USDC": the report reads only collateral. */
  readUsdc?: () => Promise<{ raw: string; decimals: number; block: string } | null>;
  /** Who the model calls are counted under in the server's one budget (audit MCP-5): the asking address. */
  modelClient?: string;
  /** A Basename a transfer's question writes, resolved on Base. */
  resolveName?: (name: string) => Promise<BaseNameResolutionV1>;
  onStage?: (stage: StillAgentStageV1) => void;
  now?: Date;
}

export async function answerStillAgentV3(input: StillAgentAskV3): Promise<AgentAnswerV1> {
  const { question, wallet } = input;
  const modelClient = input.modelClient ?? 'agent:unattributed';
  const ru = isRussianV1(question);
  const stage = input.onStage ?? (() => undefined);
  const { route } = agentRouteV2(question);

  stage({ stage: 'reading' });
  const reading = await input.read();
  if (reading.outcome !== 'report') {
    return {
      topic: null,
      mode: 'refused',
      text: ru ? 'Base сейчас не удалось прочитать. Это наш сбой, а не факт о вашем кошельке.' : 'Base could not be read just now. That is our failure, not a fact about your wallet.',
      sources: [],
    };
  }
  const { report } = reading;
  if (report.subject.address.toLowerCase() !== wallet) throw new Error('still_agent_wallet_mismatch');
  stage({ stage: 'read', block: report.reading.block, blockTime: report.reading.blockTime });
  void rememberStillReadingV1(wallet, report);
  const sky = skyStateV1({ now: input.now ?? new Date() });

  // A swap is written out for Swap AI; only "all"/"half" of USDC needs a read.
  if (route === 'swap') {
    const request = agentSwapRequestV2(question);
    const usdcBalance =
      request?.from === 'USDC' && request.amount?.kind === 'share' && input.readUsdc
        ? ((await input.readUsdc().catch(() => null)) ?? 'unread')
        : null;
    return agentSwapAnswerV2({ question, report, usdcBalance });
  }
  // A transfer is read by the rules alone: its recipient is the question's own words.
  if (route === 'send') {
    return stillAgentSendAnswerV1({ question, wallet, report, resolveName: input.resolveName ?? resolveBaseNameV1, ...(input.readUsdc ? { readUsdc: input.readUsdc } : {}), stage });
  }
  // A direct read and a request to act are the page's own answers: no model.
  if (route === 'fast' || route === 'action_prep') return agentAnswerV1({ question, report, sky, signedIn: true });

  let by: 'rules' | 'model' = 'rules';
  let proposal = rulesProposalV1(question, report);
  if (!proposal) {
    const planner = stillAgentLlmRuntimeV1.planner();
    if (!planner) return capabilitiesAnswerV2(ru, route === 'analysis');
    if (!(await modelPlaceV2(modelClient))) return capabilitiesAnswerV2(ru, false, true);
    stage({ stage: 'understanding' });
    by = 'model';
    proposal = await modelProposalV1(planner, question, report).catch(() => null);
    if (!proposal) return capabilitiesAnswerV2(ru, true);
  }
  const plan = groundProposalV1(proposal, question, report);
  if (plan.task === 'chat') return capabilitiesAnswerV2(ru);
  if (plan.task === 'status') {
    // A plain question about the loan, asked in other words: the page's own answers.
    const owes = report.venues.some((v) => v.debtCents !== null && BigInt(v.debtCents) > 0n);
    const room = agentAnswerV1({ question: ru ? 'Сколько я могу занять?' : 'How much can I borrow?', report, sky, signedIn: true });
    if (!owes) return { ...room, understoodBy: by };
    const safety = agentAnswerV1({ question: ru ? 'Насколько безопасен мой займ?' : 'How safe is my loan?', report, sky, signedIn: true });
    return { ...room, text: `${room.text} ${safety.text}`, understoodBy: by };
  }

  const summary = planSummaryV1(plan, ru);
  if (summary) stage({ stage: 'understood', summary, by });
  const previous = plan.task === 'limit' ? await earlierStillReadingV1(wallet, report) : null;
  if (summary) stage({ stage: 'computing', summary });
  const base: AgentAnswerV1 = {
    ...stillAgentToolAnswerV1({
      plan,
      reading: { report, input: reading.input },
      ru,
      question,
      change: previous ? stillReadingChangeV1(previous, report) : null,
    }),
    understoodBy: by,
  };
  // Only a plan that was computed says so: a refusal computed nothing.
  if (summary) stage({ stage: 'computed', figures: evidenceFiguresV2(base).size });
  // A refusal or a request for what is missing is ours, said plainly.
  if (base.mode !== 'analysis') return base;
  return narrateV2(base, question, ru, stage, modelClient);
}
