import assert from 'node:assert/strict';
import test from 'node:test';
import { computeMirror } from '@mioagent/still-engine';

import { EXAMPLE, calendar, snapshot, universe } from '../../../lib/still-engine/test/fixtures.js';
import { groundProposalV1, rulesProposalV1, type StillAgentPlanV1, type StillAgentProposalV1 } from './stillAgentPlan.js';

const WALLET = `0x${'1'.repeat(40)}` as const;
// The example: NVIDIA pledged on Aave against $240.17; Apple, Tesla and Bitcoin in the wallet.
const report = computeMirror({
  universe: universe(),
  snapshot: snapshot(EXAMPLE),
  calendar: calendar(),
  subject: { address: WALLET, name: null, input: WALLET },
  assembledAt: new Date('2026-10-21T15:00:01Z'),
});

const plan = (question: string): StillAgentPlanV1 | null => {
  const proposal = rulesProposalV1(question, report);
  return proposal ? groundProposalV1(proposal, question, report) : null;
};
const grounded = (proposal: StillAgentProposalV1, question: string) => groundProposalV1(proposal, question, report);

test('the rules read price moves in both languages, with their direction from the words', () => {
  assert.deepEqual(plan('Что будет при падении NVDA на 30%?'), { task: 'scenario', edits: [{ kind: 'price', asset: 'NVDAc', changeBps: -3000 }] });
  assert.deepEqual(plan('What happens if NVIDIA rises 12.5%?'), { task: 'scenario', edits: [{ kind: 'price', asset: 'NVDAc', changeBps: 1250 }] });
  assert.deepEqual(plan('если биткоин подешевеет вдвое'), { task: 'scenario', edits: [{ kind: 'price', asset: 'cbBTC', changeBps: -5000 }] });
  assert.deepEqual(plan('What if BTC goes to $60k?'), { task: 'scenario', edits: [{ kind: 'price_to', asset: 'cbBTC', cents: 6_000_000n }] });
  // Two assets, two moves, each with its own direction.
  assert.deepEqual(plan('What if NVDA drops 30% and BTC rises 10%?'), {
    task: 'scenario',
    edits: [
      { kind: 'price', asset: 'NVDAc', changeBps: -3000 },
      { kind: 'price', asset: 'cbBTC', changeBps: 1000 },
    ],
  });
  // "My stocks" is every stock the wallet holds, and nothing it does not.
  assert.deepEqual(plan('Если все мои акции упадут на 20%?'), {
    task: 'scenario',
    edits: ['AAPLc', 'NVDAc', 'TSLAc'].map((asset) => ({ kind: 'price', asset, changeBps: -2000 })),
  });
  // A third, said in words, is the person's number too.
  assert.deepEqual(plan('Что будет с займом, если все акции подешевеют на треть?'), {
    task: 'scenario',
    edits: ['AAPLc', 'NVDAc', 'TSLAc'].map((asset) => ({ kind: 'price', asset, changeBps: -3333 })),
  });
  // A move with no size is asked for one, never given one.
  assert.deepEqual(plan('what happens if nvidia crashes?'), { task: 'needs', what: 'percent' });
});

test('the rules read borrowing, repaying, pledging and interest, and resolve the loan', () => {
  assert.deepEqual(plan('What if NVDA drops 20% and I borrow $100 more?'), {
    task: 'scenario',
    edits: [
      { kind: 'price', asset: 'NVDAc', changeBps: -2000 },
      { kind: 'borrow', venue: 'aave-v4', usdcAtomic: 100_000_000n },
    ],
  });
  assert.deepEqual(plan('Как безопаснее уменьшить долг на $100?'), { task: 'repay_options', usdcAtomic: 100_000_000n, venue: null });
  assert.deepEqual(plan('Как погасить весь долг?'), { task: 'repay_options', usdcAtomic: 'all', venue: null });
  assert.deepEqual(plan('Как уменьшить долг?'), { task: 'repay_options', usdcAtomic: null, venue: null });
  assert.deepEqual(plan('What if I add 0.5 TSLA as collateral?'), {
    task: 'scenario',
    edits: [{ kind: 'deposit', asset: 'TSLAc', raw: 50_000_000n, source: 'wallet' }],
  });
  // More than the wallet holds is counted as tokens it does not have yet.
  assert.deepEqual(plan('What if I add 2 TSLA as collateral?'), {
    task: 'scenario',
    edits: [{ kind: 'deposit', asset: 'TSLAc', raw: 200_000_000n, source: 'new' }],
  });
  assert.deepEqual(plan('How much interest will I pay per year?'), { task: 'interest', days: 365 });
  assert.deepEqual(plan('Сколько процентов по займу за 3 месяца?'), { task: 'interest', days: 90 });
  assert.deepEqual(plan('Сколько стоит мой займ в месяц?'), { task: 'interest', days: 30 });
  assert.deepEqual(plan('How much would I owe after paying back $50?'), { task: 'repay_options', usdcAtomic: 50_000_000n, venue: null });
  assert.deepEqual(plan('Почему моя сумма займа уменьшилась?'), { task: 'limit' });
});

test('a proposal is grounded in the question’s own words, whoever wrote it', () => {
  // The numbers must be the question's.
  assert.deepEqual(grounded({ task: 'scenario', price: [{ asset: 'NVDA', changePct: 25 }] }, 'what if nvidia drops a lot?'), { task: 'needs', what: 'percent' });
  assert.deepEqual(grounded({ task: 'scenario', borrowUsd: 500 }, 'what if I borrow more?'), { task: 'needs', what: 'amount' });
  assert.deepEqual(grounded({ task: 'repay_options', repayUsd: 50 }, 'how do I pay this down?'), { task: 'needs', what: 'amount' });
  // So must the asset, and the direction comes from the words, never from a sign the model chose.
  assert.deepEqual(grounded({ task: 'scenario', price: [{ asset: 'TSLA', changePct: 10 }] }, 'what if nvidia falls 10%?'), { task: 'needs', what: 'asset' });
  assert.deepEqual(grounded({ task: 'scenario', price: [{ asset: 'NVDA', changePct: -10 }] }, 'nvidia 10% higher?'), {
    task: 'scenario',
    edits: [{ kind: 'price', asset: 'NVDAc', changeBps: 1000 }],
  });
  assert.deepEqual(grounded({ task: 'scenario', price: [{ asset: 'NVDA', changePct: 10 }] }, 'nvidia 10%?'), { task: 'needs', what: 'direction' });
  // "All" must be said to be meant.
  assert.deepEqual(grounded({ task: 'repay_options', repayUsd: 'all' }, 'how do I pay this down?'), { task: 'needs', what: 'amount' });
  // An asset Still does not read is out of scope, not guessed at.
  assert.deepEqual(grounded({ task: 'scenario', price: [{ asset: 'DOGE', changePct: 10 }] }, 'what if doge falls 10%?'), { task: 'unsupported', reason: 'not_reviewed_asset' });
  // A loan the question does not name is not the model's to pick.
  assert.deepEqual(grounded({ task: 'repay_options', repayUsd: 100, venue: 'morpho_cbbtc' }, 'repay $100?'), { task: 'repay_options', usdcAtomic: 100_000_000n, venue: null });
  // Words written as numbers stay the person's numbers.
  assert.deepEqual(grounded({ task: 'scenario', price: [{ asset: 'ETH', toUsd: 1500 }] }, 'what if eth goes to $1,500?'), {
    task: 'scenario',
    edits: [{ kind: 'price_to', asset: 'ETH', cents: 150_000n }],
  });
});
