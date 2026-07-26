import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'RouteIntelligenceConsole.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// T65.1 Final §2/§5/§6 — the web console's NFT journey.
//
// What the panels render is covered by @mioagent/ui's rendering tests. What is
// covered HERE is the wiring those tests cannot see: that this surface mounts
// every stage, and that it reaches the wallet through the ONE shared
// implementation rather than around it.
// ---------------------------------------------------------------------------

describe('the web console completes the NFT flow', () => {
  test('every stage of the journey is mounted', () => {
    for (const stage of ['NftRouteCardPanel', 'NftReviewPanel', 'NftProofPanel']) {
      assert.ok(source.includes(`<${stage}`), `${stage} must be rendered, not merely imported`);
    }
    assert.ok(/screen === 'route' && nftCard/.test(source), 'Comparing lands on the NFT Route Card');
    assert.ok(/screen === 'review' && nftPrepared/.test(source), 'the Route Card leads to Review');
    assert.ok(/screen === 'proof' && \(nftProof \|\| nftSubmission\)/.test(source), 'a submission leads to Proof');
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
    // No second implementation, no direct wagmi call, no Base MCP.
    assert.ok(!/useSendCalls|sendCalls\.|sendCallsV1/.test(source), 'the console must never call the wallet directly');
    assert.ok(!/(?<!wallet_)send_calls/.test(source), 'Base MCP send_calls is not a submission path');
  });

  test('reconciliation runs after a proof id exists, once, and never signs', () => {
    assert.ok(/nftReconcile\.mutate\(\{ proofId: next\.proofId \}\)/.test(source), 'reconcile is driven by the recorded proof id');
    assert.ok(/nftReconciled\.current === next\.proofId/.test(source), 'a proof is reconciled at most once per result');
    const mutations = source.match(/nftReconcile\.mutate\(/g) ?? [];
    assert.equal(mutations.length, 1, 'reconciliation has exactly one call site');
  });

  test('the client sends no calldata, target, value or recipient', () => {
    // Every NFT request this surface makes, by field. A `data:` or `to:` here
    // would mean the client had started composing transactions.
    const nftCalls = source.match(/nft(Compare|Prepare|Reconcile)\.mutate\(\{[^}]*\}/g) ?? [];
    assert.ok(nftCalls.length >= 2, 'the NFT mutations must be present to be checked');
    for (const call of nftCalls) {
      for (const forbidden of ['data:', 'calldata', 'valueWei:', 'recipient:', 'to:']) {
        assert.ok(!call.includes(forbidden), `an NFT request must not carry ${forbidden}`);
      }
    }
  });

  test('T65.2A: an NFT comparison counts as a comparison', () => {
    // Left out, it made the Compare button clickable mid-run and the elapsed
    // pill read "done" while OpenSea was still being asked.
    assert.ok(/comparePending =[\s\S]{0,200}nftCompare\.isPending/.test(source), 'nftCompare must be part of comparePending');
  });

  test('T65.2A: an NFT card ends the Comparing screen', () => {
    // Without a settled effect the family had no way off Comparing at all.
    assert.ok(/nftSettled/.test(source), 'an nftSettled effect must exist');
    assert.ok(/if \(!nftCard \|\| nftSettled\.current\) return/.test(source), 'it must fire once, on a card');
    // A card is not a failure — `unavailable` still names the token.
    assert.ok(/comparePending \|\| projection \|\| earnCard \|\| commerceCard \|\| nftCard/.test(source));
  });

  test('T65.2A: an NFT run that produced no card is terminal, with a reason', () => {
    assert.ok(/nftCompare\.data\?\.outcome === 'needs_clarification'/.test(source));
    assert.ok(/nftCompare\.data\?\.outcome === 'unsupported'/.test(source));
    assert.ok(/nftCompare\.error/.test(source), 'a transport failure must be surfaced too');
    assert.ok(/nftFailure/.test(source), 'the NFT failure must reach comparingFailure');
  });

  test('T65.2A: the price rail shows a real snapshot', () => {
    assert.ok(/useMarketSnapshot\(\)/.test(source), 'the console must read a market snapshot');
    assert.ok(/price=\{marketRail\.price\}/.test(source), 'the rail must render it');
    assert.ok(!/price=\{null\}/.test(source), 'the rail must no longer hard-code an absent price');
    // Depth stays honestly unavailable: no liquidity source is connected.
    assert.ok(/depth=\{null\}/.test(source), 'depth must stay unavailable rather than be derived from a spot price');
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
