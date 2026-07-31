import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  PUBLIC_PROOF_SHARE_WARNING_V1,
  PublicProofHeaderPanel,
  PublicProofReceiptsPanel,
  PublicProofResultPanel,
  PublicProofVerificationPanel,
  ShareProofPanel,
  publicProofHeadlineCopyV1,
  type PublicProofViewV1,
} from '../src/console/PublicProofPanels';

const HASH = `0x${'ab'.repeat(32)}`;

function view(overrides: Partial<PublicProofViewV1> = {}): PublicProofViewV1 {
  return {
    publicProofId: 'a'.repeat(48),
    proofFamily: 'route',
    issuedAt: '2026-07-27T12:00:00.000Z',
    bundleHash: HASH,
    proofHash: HASH,
    approvedCallsHash: HASH,
    finalStatus: 'completed',
    schemaVersion: 'public-proof-bundle/v1',
    provider: 'Aerodrome',
    expectedOutput: '1000000000000000000',
    actualOutput: '999000000000000000',
    minimumOutput: '990000000000000000',
    deviationBps: -10,
    estimatedGas: '200000',
    actualGas: '198000',
    receipts: [{ transactionHash: `0x${'11'.repeat(32)}`, status: 'success', blockNumber: '49000000', gasUsed: '120000' }],
    eventCount: 3,
    ...overrides,
  };
}

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe('the public page is honest about what it is showing', () => {
  test('a cancelled record is never called an execution proof', () => {
    // The one failure mode worth engineering against: a stranger reading a
    // cancelled process record as evidence that money moved.
    const html = render(<PublicProofHeaderPanel view={view({ finalStatus: 'cancelled' })} />);
    assert.match(html, /never executed/);
    assert.equal(html.includes('Verified execution proof'), false);
  });

  test('a failed execution is not a success with a caveat', () => {
    const html = render(<PublicProofHeaderPanel view={view({ finalStatus: 'failed' })} />);
    assert.match(html, /Failed execution/);
  });

  test('partial failure says part of the batch did not succeed', () => {
    assert.match(publicProofHeadlineCopyV1('route', 'partial_failure'), /did not succeed/);
  });

  test('a manual reconciliation record does not claim an outcome', () => {
    assert.match(publicProofHeadlineCopyV1('route', 'reconciliation_required'), /has not been established/);
  });

  test('the two families do not share the meaning of "failed"', () => {
    // For a route it is a failed execution; for an NFT the transaction landed
    // and ownership still did not follow. Merging them would lose that.
    assert.match(publicProofHeadlineCopyV1('route', 'failed'), /Failed execution/);
    assert.match(publicProofHeadlineCopyV1('nft', 'failed'), /ownership was not established/);
    assert.match(publicProofHeadlineCopyV1('nft', 'transaction_failed'), /reverted/);
  });

  test('an unknown status is reported rather than guessed', () => {
    assert.match(publicProofHeadlineCopyV1('route', 'something_new'), /Recorded outcome: something_new/);
  });
});

describe('integrity is described precisely', () => {
  test('the scope disclaimer is always shown, pass or fail', () => {
    for (const valid of [true, false, null]) {
      const html = render(<PublicProofVerificationPanel view={view()} checks={[]} valid={valid} />);
      assert.match(html, /not a Miorail server signature/);
      assert.match(html, /not an onchain anchor/);
    }
  });

  test('verification that has not run is never rendered as a pass', () => {
    const html = render(<PublicProofVerificationPanel view={view()} checks={[]} valid={null} />);
    assert.match(html, /Checking…/);
    assert.equal(html.includes('verified locally'), false);
  });

  test('a failed verification says the bundle was modified', () => {
    const html = render(<PublicProofVerificationPanel view={view()} checks={[]} valid={false} />);
    assert.match(html, /invalid or has been modified/);
  });

  test('a skipped check is shown as skipped, not as a pass', () => {
    const html = render(
      <PublicProofVerificationPanel
        view={view()}
        valid={true}
        checks={[{ key: 'event_chain', label: 'Event chain', outcome: 'skipped', detail: 'no chain in this family' }]}
      />,
    );
    assert.match(html, /no chain in this family/);
  });
});

describe('the result panel never turns a gap into a number', () => {
  test('a missing value reads as not recorded', () => {
    const html = render(<PublicProofResultPanel view={view({ actualOutput: null, actualGas: null })} />);
    assert.match(html, /not recorded/);
    assert.equal(/<span class="mono"><\/span>/.test(html), false);
  });

  test('a reverted receipt is shown as reverted', () => {
    const html = render(
      <PublicProofReceiptsPanel
        view={view({
          receipts: [{ transactionHash: `0x${'22'.repeat(32)}`, status: 'reverted', blockNumber: null, gasUsed: null }],
        })}
      />,
    );
    assert.match(html, /reverted/);
    assert.match(html, /basescan\.org\/tx\/0x2222/);
  });

  test('no receipts says so rather than showing an empty list', () => {
    const html = render(<PublicProofReceiptsPanel view={view({ receipts: [] })} />);
    assert.match(html, /No transaction was recorded/);
  });
});

describe('publishing is never accidental', () => {
  test('the warning names what becomes public, before anything is published', () => {
    const html = render(
      <ShareProofPanel publicUrl={null} onShare={() => {}} onRevoke={() => {}} />,
    );
    // Unpublished state first: no link, and a note saying nothing is public.
    assert.match(html, /Nothing is published until you choose/);
    assert.equal(html.includes(PUBLIC_PROOF_SHARE_WARNING_V1), false, 'the warning belongs to the confirm step');
    assert.match(PUBLIC_PROOF_SHARE_WARNING_V1, /wallet address, transaction hashes and approved transaction data/);
  });

  test('a published proof offers copy, open, download and revoke', () => {
    const html = render(
      <ShareProofPanel publicUrl="/proof/abc" onShare={() => {}} onRevoke={() => {}} />,
    );
    for (const label of ['Copy link', 'Open public proof', 'Download JSON', 'Revoke link']) {
      assert.ok(html.includes(label), `${label} must be offered`);
    }
    assert.match(html, /never reissued/);
  });

  test('every panel uses console classes that already exist', () => {
    const html = [
      render(<PublicProofHeaderPanel view={view()} />),
      render(<PublicProofResultPanel view={view()} />),
      render(<PublicProofReceiptsPanel view={view()} />),
      render(<PublicProofVerificationPanel view={view()} checks={[]} valid={true} />),
      render(<ShareProofPanel publicUrl="/proof/abc" onShare={() => {}} onRevoke={() => {}} />),
    ].join('');
    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1]!.split(/\s+/));
    for (const name of new Set(classes)) {
      assert.ok(['panel', 'kv', 'note', 'mono'].includes(name), `unknown console class: ${name}`);
    }
  });
});
