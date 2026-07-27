import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADAPTER_FAMILY_V1,
  adaptersFromStatusV1,
  comparingProgressV1,
  coverageFromStatusV1,
  dispatchRouteFamilyV1,
  routeFamilyForGoalV1,
} from '../src/console/consoleFlow';

// ---------------------------------------------------------------------------
// T66C — the Private AI family inside the existing console flow.
// ---------------------------------------------------------------------------

const ON = {
  routeIntelligenceV1: true,
  earnRouteV1: true,
  commerceRouteV1: true,
  commerceExecutionV1: true,
  nftRouteV1: true,
  nftExecutionV1: true,
  privateAiRouteV1: true,
  privateAiExecutionV1: true,
};

describe('an AI goal reaches the AI engine', () => {
  test('AI wording is recognised in English and Russian', () => {
    for (const goal of [
      'Ask an AI to summarise this contract',
      'summarise these notes privately',
      'run this on Venice',
      'I need an LLM for classification',
      'приватный ии для этого текста',
      'суммируй эти заметки',
    ]) {
      assert.equal(routeFamilyForGoalV1(goal), 'private_ai', goal);
    }
  });

  test('an AI goal carrying another family’s verb still routes to AI', () => {
    // "summarise" + "swap" — the swap engine would look for a token pair in an
    // essay, which is the failure this ordering prevents.
    assert.equal(routeFamilyForGoalV1('summarise how this swap contract works'), 'private_ai');
    assert.equal(routeFamilyForGoalV1('classify these gift cards for me with an llm'), 'private_ai');
  });

  test('with the family excluded, those goals fall through to one that works', () => {
    // The AI pattern matches ordinary verbs. A deployment that will never run
    // Venice must not have "summarise" hijack a goal the swap engine can serve.
    const off = { includePrivateAi: false };
    assert.equal(routeFamilyForGoalV1('summarise how this swap contract works', off), 'swap');
    assert.equal(routeFamilyForGoalV1('classify these gift cards for me with an llm', off), 'commerce');
    // A goal that is ONLY an AI request has nowhere to fall through to, and
    // says so rather than being handed to an engine that cannot read prose.
    assert.equal(routeFamilyForGoalV1('summarise these notes privately', off), 'unknown');
  });

  test('the other families are unaffected', () => {
    assert.equal(routeFamilyForGoalV1('swap 100 USDC to ETH'), 'swap');
    assert.equal(routeFamilyForGoalV1('earn yield on 500 USDC'), 'earn');
    assert.equal(routeFamilyForGoalV1('Buy NFT BasePaint #123'), 'nft');
    assert.equal(routeFamilyForGoalV1('buy a gift card'), 'commerce');
  });

  test('the gate on routes AI goals to the AI engine', () => {
    const open = dispatchRouteFamilyV1('summarise this', ON);
    assert.equal(open.family, 'private_ai');
    assert.equal(open.engine, 'private_ai');
    assert.equal(open.blockedReason, null);
  });

  test('the gate off does not claim the goal at all', () => {
    // Unlike Earn, Commerce and NFT — which are named by precise nouns, so
    // claiming the goal and reporting the switch is useful — Private AI matches
    // ordinary verbs. Claiming a goal it can never run turns the console into
    // an advert for a feature this deployment does not offer.
    const off = { ...ON, privateAiRouteV1: false };
    const blocked = dispatchRouteFamilyV1('summarise this', off);
    assert.notEqual(blocked.family, 'private_ai');
    assert.equal(blocked.engine, null);
    assert.ok(!blocked.blockedReason?.includes('Private AI'));

    // And a goal another family can serve still reaches that family.
    assert.equal(dispatchRouteFamilyV1('summarise how this swap works', off).engine, 'swap');
  });

  test('an absent flag on a pre-T66 server reads as off', () => {
    const dispatched = dispatchRouteFamilyV1('summarise this', {
      routeIntelligenceV1: true,
      earnRouteV1: true,
    });
    assert.equal(dispatched.engine, null);
  });
});

describe('the rails describe the AI run', () => {
  test('Venice is listed as an adapter of the AI family', () => {
    assert.equal(ADAPTER_FAMILY_V1.Venice, 'private_ai');
    const adapters = adaptersFromStatusV1({ productMigration: { ...ON, paidIntelligence: false } });
    const venice = adapters.find((entry) => entry.name === 'Venice');
    assert.equal(venice?.state, 'live');
  });

  test('a flag that is off makes Venice disabled, not disconnected', () => {
    const adapters = adaptersFromStatusV1({
      productMigration: { ...ON, privateAiRouteV1: false, paidIntelligence: false },
    });
    assert.equal(adapters.find((entry) => entry.name === 'Venice')?.state, 'disabled');
  });

  test('Comparing lists Venice and no adapter from another family', () => {
    const rows = comparingProgressV1({
      family: 'private_ai',
      adapters: [
        { name: 'Venice', label: 'live', live: true, usable: true },
        { name: 'Uniswap', label: 'live', live: true, usable: true },
        { name: 'OpenSea', label: 'live', live: true, usable: true },
      ],
      answered: ['Venice'],
      terminalReason: null,
      evidenceCount: 3,
      scored: true,
    });
    const labels = rows.map((row) => row.label);
    assert.ok(labels.some((label) => label.includes('Venice model catalogue')));
    assert.ok(!labels.some((label) => label.includes('Uniswap')));
    assert.ok(!labels.some((label) => label.includes('OpenSea')));
    assert.ok(labels.includes('Model scoring'));
  });

  test('a terminal run stops every Comparing row', () => {
    const rows = comparingProgressV1({
      family: 'private_ai',
      adapters: [{ name: 'Venice', label: 'live', live: true, usable: true }],
      answered: [],
      terminalReason: 'No model is allowlisted.',
      evidenceCount: null,
      scored: false,
    });
    assert.ok(rows.every((row) => row.state !== 'running'));
  });

  test('coverage separates comparing from running', () => {
    const compareOnly = coverageFromStatusV1({
      productMigration: { ...ON, privateAiExecutionV1: false, paidIntelligence: false },
    }).find((row) => row.action.startsWith('Private AI'));
    assert.equal(compareOnly?.state, 'building');
    assert.ok(compareOnly?.sources.includes('execution gate is off'));

    const both = coverageFromStatusV1({
      productMigration: { ...ON, paidIntelligence: false },
    }).find((row) => row.action.startsWith('Private AI'));
    assert.equal(both?.state, 'ready');

    const off = coverageFromStatusV1({
      productMigration: { ...ON, privateAiRouteV1: false, paidIntelligence: false },
    }).find((row) => row.action.startsWith('Private AI'));
    assert.equal(off?.state, 'off');
    assert.equal(off?.available, false);
  });
});
