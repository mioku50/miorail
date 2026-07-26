import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'MiniConsole.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// T65.1 Final §5/§6 — the miniapp's NFT journey.
//
// The same sequence as the web console, through the same panels and the same
// wallet implementation. The miniapp used to stop at the Route Card; these
// hold the rest of the flow in place.
// ---------------------------------------------------------------------------

describe('the miniapp completes the NFT flow', () => {
  test('every stage of the journey is mounted', () => {
    for (const stage of ['NftRouteCardPanel', 'NftReviewPanel', 'NftProofPanel']) {
      assert.ok(source.includes(`<${stage}`), `${stage} must be rendered, not merely imported`);
    }
    assert.ok(/screen === "route" && nftCard/.test(source), 'Comparing lands on the NFT Route Card');
    assert.ok(/screen === "review" && nftPrepared/.test(source), 'the Route Card leads to Review');
    assert.ok(/screen === "proof" && \(nftProof \|\| nftSubmission\)/.test(source), 'a submission leads to Proof');
  });

  test('a new goal clears the NFT flow', () => {
    // Otherwise a finished NFT purchase keeps claiming the Proof screen from
    // whatever family the user asks for next.
    for (const reset of ['nftPrepare.reset()', 'setNftSubmission(null)', 'setNftProof(null)', 'nftReconciled.current = null']) {
      assert.ok(source.includes(reset), `a new comparison must run ${reset}`);
    }
  });

  test('the wallet is reached only through the shared submission button', () => {
    assert.ok(/<BlueprintSubmitButton\s+goal="nft"/.test(source), 'the NFT review uses the shared submit button');
    assert.ok(!/useSendCalls|sendCalls\.|sendCallsV1/.test(source), 'the miniapp must never call the wallet directly');
    assert.ok(!/(?<!wallet_)send_calls/.test(source), 'Base MCP send_calls is not a submission path');
  });

  test('buying stays behind the execution flag', () => {
    assert.ok(
      /onReview=\{address && flags\?\.nftExecutionV1 === true/.test(source),
      'Review is offered only with a connected wallet and the execution flag on',
    );
    assert.ok(/read-only until it is enabled/.test(source), 'a disabled gate states why');
  });

  test('reconciliation runs once, after a proof id exists', () => {
    assert.ok(/nftReconciled\.current === next\.proofId/.test(source), 'a proof is reconciled at most once per result');
    const mutations = source.match(/nftReconcile\.mutate\(/g) ?? [];
    assert.equal(mutations.length, 1, 'reconciliation has exactly one call site');
  });

  test('T65.2A: the same activation fixes are here', () => {
    assert.ok(/comparePending =[\s\S]{0,200}nftCompare\.isPending/.test(source), 'nftCompare must be part of comparePending');
    assert.ok(/if \(!nftCard \|\| nftSettled\.current\) return/.test(source), 'an nftSettled effect must fire once, on a card');
    assert.ok(/earnCard \|\| commerceCard \|\| nftCard/.test(source), 'a card is not a failed run');
    assert.ok(/nftCompare\.data\?\.outcome === "unsupported"/.test(source), 'an unsupported NFT goal is terminal');
    assert.ok(/nftCompare\.error/.test(source), 'a transport failure must be surfaced too');
  });

  test('T65.2A: the price rail shows a real snapshot here too', () => {
    assert.ok(/useMarketSnapshot\(\)/.test(source));
    assert.ok(/price=\{marketRail\.price\}/.test(source));
    assert.ok(!/price=\{null\}/.test(source));
    assert.ok(/depth=\{null\}/.test(source), 'depth stays unavailable until a liquidity source exists');
  });

  test('T65.2A: an unread status is not reported as a disabled flag', () => {
    // Every gate reads status.data. Before it answers, each flag looks off —
    // which used to render as "route intelligence is off on this server" and
    // sent operators hunting for a flag that was already enabled.
    assert.ok(/statusGate/.test(source), 'a distinct status gate must exist');
    assert.ok(/status\.error/.test(source), 'a failed status read must be named');
    assert.ok(/statusGate \?\? dispatch\.blockedReason/.test(source), 'it must take precedence over the family gate');
  });

  test('T65.2A: an NFT starter makes the family reachable without guessing a phrasing', () => {
    assert.ok(/id: ["']nft["']/.test(source), 'the plan screen must offer an NFT starter');
    assert.ok(/NFT gate is off on this server/.test(source), 'and say when the gate is off');
  });
});
