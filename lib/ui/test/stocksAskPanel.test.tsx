import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  StocksAskPanel,
  STOCKS_ASK_PROMPTS_V1,
  type StocksAskPanelModelV1,
} from '../src/console/StocksAskPanel';

// The JSX below compiles to React.createElement.
void React;

// ---------------------------------------------------------------------------
// Phase 13.2 — the Stocks answer on screen.
//
// The panel renders an answer that has already been checked, so these tests
// are not about whether a model said something true. They pin the two things
// the SCREEN can get wrong: showing a claim whose citation a reader cannot
// follow, and letting a narrated sentence pass for evidence.
// ---------------------------------------------------------------------------

const ADDRESS = '0xb20000000000000000000078ee7ce2fe4908108c';
const noop = () => {};

function answer(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'stocks-ask/v1' as const,
    question: {
      underlyingKey: 'security:isin:US67066G1040',
      direction: 'buy' as const,
      requestedCashAtomic: '1000000000',
      destination: 'USDC' as const,
      asked: 'what does it cost?',
    },
    answer: {
      subjects: [ADDRESS],
      established: [
        {
          claim: `${ADDRESS} returned 999.02 USDC at the exact size`,
          sourceIds: ['e8'],
        },
      ],
      notEstablished: ['a reference price for this issuer'],
      explanation: 'The newest measurement is 42 minutes old and its evidence has expired.',
      sources: ['e8'],
    },
    answerSource: 'verified_narration' as const,
    evidence: [
      {
        id: 'e8',
        kind: 'observation' as const,
        subject: ADDRESS,
        label: `last observation of ${ADDRESS}`,
        value: 'quoted through kyberswap, 999018676 atomic USDC (999.018676 USDC)',
      },
    ],
    refused: false,
    quoteOnly: true as const,
    executionEvidenceIncluded: false as const,
    assembledAt: '2026-08-30T00:00:00.000Z',
    ...over,
  };
}

function model(over: Partial<StocksAskPanelModelV1> = {}): StocksAskPanelModelV1 {
  return {
    answer: answer() as never,
    asking: false,
    error: null,
    available: true,
    ...over,
  };
}

function html(over: Partial<StocksAskPanelModelV1> = {}): string {
  return renderToStaticMarkup(
    <StocksAskPanel model={model(over)} actions={{ onAsk: noop }} />,
  );
}

describe('the Stocks ask panel', () => {
  test('is absent, not disabled, when the surface is not offered', () => {
    assert.equal(html({ available: false }), '');
  });

  test('separates what was established from what was not', () => {
    const markup = html();
    assert.ok(markup.includes('Established'));
    assert.ok(markup.includes('Not established'));
    assert.ok(markup.includes('999.02 USDC'));
    assert.ok(markup.includes('a reference price for this issuer'));
  });

  test('a citation resolves to the row it stands on, in the page', () => {
    // An id a reader cannot follow is a decoration, not provenance.
    const markup = html();
    assert.ok(markup.includes('e8'));
    assert.ok(markup.includes('999018676 atomic USDC'), 'the cited row is rendered, not just named');
  });

  test('a citation the answer did not carry says so rather than rendering blank', () => {
    const markup = html({
      answer: answer({
        answer: {
          subjects: [ADDRESS],
          established: [{ claim: 'Something was measured.', sourceIds: ['e404'] }],
          notEstablished: [],
          explanation: 'x',
          sources: ['e404'],
        },
        evidence: [],
      }) as never,
    });
    assert.ok(markup.includes('did not travel with the answer'));
  });

  test('the reader is told whether a model wrote the sentence', () => {
    assert.ok(html().includes('Narrated, then checked'));
    assert.ok(
      html({ answer: answer({ answerSource: 'deterministic_evidence' }) as never }).includes(
        'The evidence, verbatim',
      ),
    );
  });

  test('the suggested questions are the surface’s own, and never a model’s', () => {
    const markup = html({ answer: null });
    for (const prompt of STOCKS_ASK_PROMPTS_V1) {
      assert.ok(markup.includes(prompt), prompt);
    }
    // Nothing is asked until a reader asks: an empty panel carries no answer.
    assert.equal(markup.includes('Established'), false);
  });

  test('the execution vocabulary never appears on this panel', () => {
    const markup = html();
    for (const forbidden of ['Approve', 'Sign', 'Swap now', 'wallet', 'calldata']) {
      assert.equal(markup.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
    assert.ok(markup.includes('never a promise of execution'));
  });

  test('a failed ask is stated without becoming a claim about the market', () => {
    const markup = html({ answer: null, error: 'Miorail could not answer this question.' });
    assert.ok(markup.includes('could not answer'));
    assert.equal(markup.includes('Established'), false);
  });
});
