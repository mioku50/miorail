import {
  AERODROME_REWARD_ALERT_DEFAULT_CENTS_V1,
  AERODROME_REWARD_ALERT_MAX_CENTS_V1,
  AERODROME_REWARD_ALERT_MIN_CENTS_V1,
} from '@mioagent/route-storage';

// ---------------------------------------------------------------------------
// The words of Found, inside Wallet MCP: a question about the person's own
// Aerodrome rewards, or a request to hear when they build up. Kept apart from
// the reading itself so the room's routing can ask without loading it.
// ---------------------------------------------------------------------------

// Cyrillic letters are not word characters to JavaScript's \b.
const EDGE = '(?:^|[^\\p{L}\\p{N}])';
const END = '(?=$|[^\\p{L}\\p{N}])';
const AERODROME_V1 = new RegExp(`aerodrome|аэродром|${EDGE}aero${END}`, 'iu');
const OWN_V1 = new RegExp(`\\b(?:my|me|i)\\b|${EDGE}(?:мо[йияеёю]\\p{L}*|мне|меня|я)${END}`, 'iu');
const TOPIC_V1 = new RegExp(
  `\\b(?:rewards?|fees?|claimable|unclaimed|earned|earnings|claim)\\b|${EDGE}(?:наград\\p{L}*|комисси\\p{L}*|заработ\\p{L}*|забрать|собрать|накопил\\p{L}*)`,
  'iu',
);
const ASK_V1 = new RegExp(
  `^(?:please\\s+)?(?:check|show|what|how much|how many|list|see|view|find|any|do i|did i|have i|is there|are there)\\b|\\?\\s*$|${EDGE}(?:покажи|проверь|сколько|что|есть\\s+ли|какие)${END}`,
  'iu',
);
const CLAIM_ORDER_V1 = new RegExp(`^(?:please\\s+)?(?:claim|collect)\\b|^(?:забери|собери|получи)${END}`, 'iu');
const ALERT_OFF_V1 = new RegExp(
  `\\b(?:stop|turn off|disable|cancel|mute|unsubscribe)\\b|${EDGE}(?:отключи|выключи|останови|отмени|отпиши|не\\s+присылай|не\\s+уведомляй)`,
  'iu',
);
const ALERT_WORD_V1 = new RegExp(
  `\\b(?:alerts?|notifications?|notify|notifying|notices?)\\b|${EDGE}(?:уведомл\\p{L}*|оповещ\\p{L}*|алерт\\p{L}*|сообщени\\p{L}*)`,
  'iu',
);
const ALERT_ON_V1 = new RegExp(
  `\\b(?:notify|alert|tell|remind|ping|message|let)\\s+me\\b|\\b(?:turn on|enable|set up|start)\\b|${EDGE}(?:сообщи|напомни|уведоми|оповести|напиши|предупреди|включи)\\p{L}*`,
  'iu',
);

export function russianV1(message: string): boolean {
  return /[а-яё]/iu.test(message);
}

/**
 * A question about the person's own Aerodrome rewards: "Check my Aerodrome
 * rewards", "What can I claim on Aerodrome?", «Сколько я могу забрать в
 * Aerodrome?». Not an order to collect them (that is the claim), not an
 * alert, and not a question about a pool, which names nobody's rewards.
 */
export function aerodromeRewardsReadV1(message: string): boolean {
  const text = message.trim();
  if (!AERODROME_V1.test(text) || CLAIM_ORDER_V1.test(text) || aerodromeRewardAlertV1(text)) return false;
  return OWN_V1.test(text) && TOPIC_V1.test(text) && ASK_V1.test(text);
}

export type AerodromeRewardAlertIntentV1 =
  | { kind: 'on'; thresholdUsdCents: number }
  | { kind: 'off' }
  | { kind: 'invalid'; reason: 'below_min' | 'above_max' };

/** "Notify me when my Aerodrome rewards reach $5" / "Stop Aerodrome reward
 * alerts", in English or Russian. Null for anything else. */
export function aerodromeRewardAlertV1(message: string): AerodromeRewardAlertIntentV1 | null {
  const text = message.trim();
  if (!AERODROME_V1.test(text) || !TOPIC_V1.test(text) && !ALERT_WORD_V1.test(text)) return null;
  if (ALERT_OFF_V1.test(text) && ALERT_WORD_V1.test(text)) return { kind: 'off' };
  if (!ALERT_ON_V1.test(text) || !TOPIC_V1.test(text)) return null;
  const cents = aerodromeRewardThresholdCentsV1(text);
  if (cents === null) return { kind: 'on', thresholdUsdCents: AERODROME_REWARD_ALERT_DEFAULT_CENTS_V1 };
  if (cents < AERODROME_REWARD_ALERT_MIN_CENTS_V1) return { kind: 'invalid', reason: 'below_min' };
  if (cents > AERODROME_REWARD_ALERT_MAX_CENTS_V1) return { kind: 'invalid', reason: 'above_max' };
  return { kind: 'on', thresholdUsdCents: cents };
}

/** "$5", "5$", "5.50 USD", "20 долларов": whole cents, or null when no amount is named. */
export function aerodromeRewardThresholdCentsV1(message: string): number | null {
  const found = message.match(
    new RegExp(`\\$\\s*(\\d{1,9}(?:[.,]\\d{1,2})?)|(\\d{1,9}(?:[.,]\\d{1,2})?)\\s*(?:\\$|usdc?\\b|dollars?\\b|долл\\p{L}*|бакс\\p{L}*)`, 'iu'),
  );
  const amount = found?.[1] ?? found?.[2];
  if (!amount) return null;
  return Math.round(Number(amount.replace(',', '.')) * 100);
}

/** Dollars from whole cents: $5, $5.50, $1,250. */
export function centsV1(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

export type AerodromeRewardAlertOutcomeV1 = 'created' | 'moved' | 'unchanged' | 'stopped' | 'none' | 'below_min' | 'above_max';

/** The console's answer to an alert request. `telegram` is whether a chat
 * hears this wallet, or null when that could not be read. */
export function aerodromeRewardAlertReplyV1(input: {
  outcome: AerodromeRewardAlertOutcomeV1;
  thresholdUsdCents?: number;
  telegram?: boolean | null;
  russian: boolean;
}): string {
  const { russian } = input;
  const amount = centsV1(input.thresholdUsdCents ?? AERODROME_REWARD_ALERT_DEFAULT_CENTS_V1);
  switch (input.outcome) {
    case 'below_min':
      return russian ? 'Минимум $1: меньше этого сбор стоит примерно столько же, сколько приносит.' : 'The smallest amount is $1: below it, collecting costs about what it brings.';
    case 'above_max':
      return russian ? 'Выберите сумму до $10,000.' : 'Pick an amount up to $10,000.';
    case 'stopped':
      return russian ? 'Уведомления о наградах Aerodrome для этого кошелька выключены.' : 'Aerodrome reward alerts are off for this wallet.';
    case 'none':
      return russian ? 'Для этого кошелька уведомлений о наградах Aerodrome не было.' : 'There was no Aerodrome reward alert for this wallet.';
    default: {
      const head = input.outcome === 'unchanged'
        ? russian ? `Уже включено: порог ${amount}.` : `Already on at ${amount}.`
        : input.outcome === 'moved'
          ? russian ? `Порог изменён на ${amount}.` : `Moved to ${amount}.`
          : russian ? 'Готово.' : 'Done.';
      const how = russian
        ? `Когда награды, которые этот кошелёк может забрать на Aerodrome, дойдут до ${amount}, Miorail сообщит один раз — в Telegram и в Base App, где уведомления доходят до этого кошелька. Все пулы читаются примерно раз в 6 часов; после сбора следующее накопление снова будет сообщено.`
        : `When what this wallet can claim on Aerodrome reaches ${amount}, Miorail tells you once, in Telegram and in Base App, wherever notifications reach this wallet. Every pool is read about every 6 hours; after you claim, the next build-up is told again.`;
      const telegram = input.telegram === false
        ? [russian ? 'Telegram к этому кошельку пока не подключён: Settings → Telegram.' : 'Telegram is not connected to this wallet yet: Settings → Telegram.']
        : [];
      return [head, how, ...telegram].join('\n');
    }
  }
}
