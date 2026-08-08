import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** Every class console.css defines a rule for. */
const definedConsoleClasses = new Set(
  readFileSync(new URL('../src/console/console.css', import.meta.url), 'utf8')
    .match(/\.[A-Za-z][A-Za-z0-9_-]*/g)
    ?.map((selector) => selector.slice(1)) ?? [],
);

import {
  B20ControlCardPanel,
  B20ControlsPanel,
  B20EvidencePanel,
  B20FieldsPanel,
  B20_NOT_B20_COPY_V1,
  shortB20HashV1,
  type B20CardLikeV1,
} from '../src/console/B20Panels';

const HASH = `0x${'ab'.repeat(32)}`;

function card(overrides: Partial<B20CardLikeV1> = {}): B20CardLikeV1 {
  return {
    tokenAddress: '0xb2000000000000000000007bf6d5cbb0e24cb301',
    displayName: 'Brian',
    displaySymbol: 'BRIAN',
    variant: 'asset',
    detectionOutcome: 'b20',
    blockNumber: '49059662',
    blockHash: HASH,
    observedAt: '2026-07-27T12:00:00.000Z',
    fields: [
      { key: 'total_supply', label: 'Total supply', status: 'exact_chain_read', value: '1000', reason: null, evidenceHash: HASH },
      { key: 'supply_cap', label: 'Supply cap', status: 'unavailable', value: null, reason: 'The read did not answer (rate_limited).', evidenceHash: null },
      { key: 'stablecoin_currency', label: 'Declared currency', status: 'unsupported_by_variant', value: null, reason: 'Not part of the asset variant.', evidenceHash: null },
    ],
    statements: [
      { key: 'pause_transfers', statement: 'Whoever holds PAUSE_ROLE can pause transfers of this token.', observedState: 'unconstrained', evidenceHash: HASH },
      { key: 'freeze_and_seize', statement: 'Whoever holds BURN_BLOCKED_ROLE can burn a blocked balance.', observedState: 'unknown', evidenceHash: null },
    ],
    unavailable: ['Who holds DEFAULT_ADMIN_ROLE: B20 exposes no way to list role holders.'],
    boundaries: ['Holders and holder concentration are not read.', 'This card scores nothing.'],
    ...overrides,
  };
}

function render(element: React.ReactElement | null): string {
  return element === null ? '' : renderToStaticMarkup(element);
}

describe('the B20 card shows facts and never a grade', () => {
  test('nothing rendered anywhere resembles a score', () => {
    const model = card();
    const html = [
      render(<B20ControlCardPanel card={model} />),
      render(<B20ControlsPanel card={model} />),
      render(<B20FieldsPanel card={model} />),
      render(<B20EvidencePanel card={model} />),
    ].join('').toLowerCase();
    for (const banned of ['safety score', 'overall confidence', '/100', 'safe token', 'unsafe', 'risk score', '%']) {
      assert.equal(html.includes(banned), false, `the card must not render ${banned}`);
    }
  });

  test('the block is shown, because every value is a claim about that block', () => {
    const html = render(<B20ControlCardPanel card={card()} />);
    assert.match(html, /49059662/);
    assert.match(html, new RegExp(shortB20HashV1(HASH).replace('…', '…')));
  });

  test('an ordinary ERC-20 is told what was checked and what is not offered', () => {
    const html = render(
      <B20ControlCardPanel card={card({ detectionOutcome: 'not_b20', variant: null, displayName: null, displaySymbol: null })} />,
    );
    assert.ok(html.includes(B20_NOT_B20_COPY_V1[0]));
    assert.ok(html.includes(B20_NOT_B20_COPY_V1[1]));
  });

  test('an ordinary ERC-20 gets no control statements at all', () => {
    const html = render(<B20ControlsPanel card={card({ statements: [] })} />);
    assert.equal(html, '', 'no statements means no panel, not an empty heading');
  });

  test('a failed read is never rendered as a fact about the token', () => {
    const html = render(<B20ControlCardPanel card={card({ detectionOutcome: 'rpc_failure', blockNumber: null })} />);
    assert.match(html, /says nothing about the token/);
    assert.match(html, /not reached/);
  });

  test('a row without a value shows its reason where the value would go', () => {
    const html = render(<B20FieldsPanel card={card()} />);
    assert.match(html, /The read did not answer \(rate_limited\)\./);
    assert.match(html, /Not part of the asset variant\./);
    // And no empty cell that could read as zero.
    assert.equal(/<span><\/span>/.test(html), false);
  });

  test('the controls panel says outright that holders are not readable', () => {
    const html = render(<B20ControlsPanel card={card()} />);
    assert.match(html, /no way to list role holders/);
    assert.match(html, /currently open/);
    assert.match(html, /not observed/);
  });

  test('the boundaries and the gaps are both on screen', () => {
    const html = render(<B20EvidencePanel card={card()} />);
    assert.match(html, /Holders and holder concentration are not read/);
    assert.match(html, /DEFAULT_ADMIN_ROLE/);
    assert.match(html, /What this card does not cover/);
  });

  test('only rows that were read appear under Evidence', () => {
    const html = render(<B20EvidencePanel card={card()} />);
    assert.match(html, /Total supply/);
    // A row with no chain read has no evidence hash to show.
    assert.equal(/Supply cap<\/span>\s*<span class="mono">0x/.test(html), false);
  });

  test('every panel uses console classes that already exist', () => {
    const model = card();
    const html = [
      render(<B20ControlCardPanel card={model} />),
      render(<B20ControlsPanel card={model} />),
      render(<B20FieldsPanel card={model} />),
      render(<B20EvidencePanel card={model} />),
    ].join('');
    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1]!.split(/\s+/));
    // Inventing a class ships unstyled text, which has happened twice before.
    //
    // Read from the stylesheet rather than from a list kept here. The list
    // version failed the moment these panels started using `.k` and `.v` —
    // classes console.css has defined all along — which is a guard reporting
    // its own staleness as a defect in the code it guards.
    for (const name of new Set(classes)) {
      assert.ok(definedConsoleClasses.has(name), `unknown console class: ${name}`);
    }
  });
});
