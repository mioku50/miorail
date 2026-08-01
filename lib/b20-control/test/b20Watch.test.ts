import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  b20WatchNeedsAttentionV1,
  b20WatchSummaryV1,
  diffB20SnapshotsV1,
} from '../src/watch.js';
import type { B20ControlFieldKeyV1, B20ControlSnapshotV1 } from '../src/contracts.js';

// ---------------------------------------------------------------------------
// T67F — B20 Control Watch.
//
// Most of these tests are about what the diff must REFUSE to say. A watch that
// invents a change is worse than no watch: it comes with an evidence hash and a
// block number, which is exactly what makes people believe it.
// ---------------------------------------------------------------------------

type FieldInput = {
  key: B20ControlFieldKeyV1;
  label?: string;
  value: string | null;
  status?: 'exact_chain_read' | 'unavailable' | 'not_enumerable' | 'unsupported_by_variant';
  reason?: string | null;
  evidenceHash?: string | null;
};

/** A snapshot shaped structurally. The schema's hash refinements are exercised
 * by b20Control.test.ts; this module never validates, it only reads. */
function snapshot(input: {
  token?: string;
  block: string;
  observedAt?: string;
  fields: FieldInput[];
}): B20ControlSnapshotV1 {
  return {
    tokenAddress: input.token ?? '0xb200000000000000000000d6f666fe8b27595c01',
    blockNumber: input.block,
    observedAt: input.observedAt ?? '2026-08-02T10:00:00.000Z',
    fields: input.fields.map((field) => ({
      key: field.key,
      label: field.label ?? field.key,
      status: field.status ?? (field.value === null ? 'unavailable' : 'exact_chain_read'),
      value: field.value,
      reason: field.reason ?? null,
      evidenceHash: field.evidenceHash ?? `0x${field.key}`,
    })),
  } as unknown as B20ControlSnapshotV1;
}

const CAP = (value: string): FieldInput => ({ key: 'supply_cap', label: 'Supply cap', value });
const PAUSED = (value: string): FieldInput => ({ key: 'paused_features', label: 'Paused features', value });

describe('the diff refuses to invent a change', () => {
  test('a field that became unreadable is a gap, never a change', () => {
    // The defect this rule exists to prevent: reading "no cap" out of a failed
    // read and reporting "supply cap removed" — an acute alert, with an
    // evidence hash, about something that did not happen.
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [CAP('1000000')] }),
      snapshot({ block: '200', fields: [{ key: 'supply_cap', value: null, reason: 'the node did not answer' }] }),
    );
    assert.deepEqual(watch.changes, []);
    assert.equal(watch.gaps.length, 1);
    assert.equal(watch.gaps[0]!.direction, 'became_unreadable');
    assert.equal(watch.gaps[0]!.reason, 'the node did not answer');
  });

  test('a field that became readable is a gap, not a change either', () => {
    // There is no "before" to compare against. Reporting the first successful
    // read as a change would fire an alert every time an RPC recovered.
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'supply_cap', value: null }] }),
      snapshot({ block: '200', fields: [CAP('1000000')] }),
    );
    assert.deepEqual(watch.changes, []);
    assert.equal(watch.gaps[0]!.direction, 'became_readable');
  });

  test('two readings of different tokens are refused, not filtered', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ token: '0xaaa', block: '100', fields: [CAP('1')] }),
      snapshot({ token: '0xbbb', block: '200', fields: [CAP('2')] }),
    );
    assert.equal(watch.status, 'not_comparable');
    assert.deepEqual(watch.changes, []);
    assert.match(watch.notComparableReason!, /different tokens/);
  });

  test('the first observation compares against nothing and says so', () => {
    const watch = diffB20SnapshotsV1(null, snapshot({ block: '100', fields: [CAP('1')] }));
    assert.equal(watch.status, 'first_observation');
    assert.match(b20WatchSummaryV1(watch), /nothing to compare/);
  });

  test('two readings at the same block cannot differ', () => {
    // A snapshot is scoped to exactly one block. Two readings at one block that
    // disagree mean one of them is wrong, not that the token changed.
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [CAP('1')] }),
      snapshot({ block: '100', fields: [CAP('999')] }),
    );
    assert.deepEqual(watch.changes, []);
    assert.equal(watch.status, 'compared');
  });

  test('an unchanged token produces no changes and a stated block range', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [CAP('1000000'), PAUSED('none paused')] }),
      snapshot({ block: '200', fields: [CAP('1000000'), PAUSED('none paused')] }),
    );
    assert.deepEqual(watch.changes, []);
    assert.match(b20WatchSummaryV1(watch), /No control changed between block 100 and block 200/);
  });
});

describe('what a holder is exposed to', () => {
  test('a pause landing on transfers is acute and says you cannot sell', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [PAUSED('none paused')] }),
      snapshot({ block: '200', fields: [PAUSED('TRANSFER')] }),
    );
    assert.equal(watch.changes[0]!.kind, 'transfers_paused');
    assert.equal(watch.changes[0]!.severity, 'acute');
    assert.match(watch.changes[0]!.detail, /cannot move or sell/);
    assert.equal(b20WatchNeedsAttentionV1(watch), true);
  });

  test('a pause landing on mint only is not acute', () => {
    // It changes what the token permits and exposes a holder to nothing.
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [PAUSED('none paused')] }),
      snapshot({ block: '200', fields: [PAUSED('MINT')] }),
    );
    assert.equal(watch.changes[0]!.severity, 'material');
    assert.equal(b20WatchNeedsAttentionV1(watch), false);
  });

  test('lifting a transfer pause is reported, and is not acute', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [PAUSED('TRANSFER')] }),
      snapshot({ block: '200', fields: [PAUSED('none paused')] }),
    );
    assert.equal(watch.changes[0]!.kind, 'transfers_unpaused');
    assert.equal(watch.changes[0]!.severity, 'material');
  });

  test('a raised cap is acute; a lowered one is not', () => {
    const raised = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [CAP('1000')] }),
      snapshot({ block: '200', fields: [CAP('9000')] }),
    );
    assert.equal(raised.changes[0]!.kind, 'supply_cap_raised');
    assert.equal(raised.changes[0]!.severity, 'acute');

    const lowered = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [CAP('9000')] }),
      snapshot({ block: '200', fields: [CAP('1000')] }),
    );
    assert.equal(lowered.changes[0]!.kind, 'supply_cap_lowered');
    assert.equal(lowered.changes[0]!.severity, 'informational');
  });

  test('removing the cap entirely is acute', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [CAP('1000')] }),
      snapshot({ block: '200', fields: [CAP('no cap')] }),
    );
    assert.equal(watch.changes[0]!.kind, 'supply_cap_removed');
    assert.match(watch.changes[0]!.detail, /no on-chain ceiling/);
  });

  test('a rebase is acute because nothing appears in a transaction history', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'rebase_multiplier', value: '1.000000' }] }),
      snapshot({ block: '200', fields: [{ key: 'rebase_multiplier', value: '0.500000' }] }),
    );
    assert.equal(watch.changes[0]!.severity, 'acute');
    assert.match(watch.changes[0]!.detail, /No transfer is involved/);
  });

  test('a rename says the address is the identity', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'token_symbol', value: 'TN' }] }),
      snapshot({ block: '200', fields: [{ key: 'token_symbol', value: 'USDC' }] }),
    );
    assert.equal(watch.changes[0]!.kind, 'symbol_changed');
    assert.equal(watch.changes[0]!.severity, 'acute');
    assert.match(watch.changes[0]!.detail, /only the contract address identifies it/);
  });

  test('a transfer policy change is acute', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'transfer_receiver_policy', value: 'no policy' }] }),
      snapshot({ block: '200', fields: [{ key: 'transfer_receiver_policy', value: 'policy 14' }] }),
    );
    assert.equal(watch.changes[0]!.kind, 'transfer_policy_changed');
    assert.equal(watch.changes[0]!.severity, 'acute');
    assert.match(watch.changes[0]!.detail, /may now be refused/);
  });

  test('a metadata URI edit never looks like a paused transfer', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'contract_uri', value: 'ipfs://a' }] }),
      snapshot({ block: '200', fields: [{ key: 'contract_uri', value: 'ipfs://b' }] }),
    );
    assert.equal(watch.changes[0]!.severity, 'informational');
    assert.equal(b20WatchNeedsAttentionV1(watch), false);
  });
});

describe('what it does not claim', () => {
  test('a supply increase reports the effect, never who minted', () => {
    // B20 answers hasRole(role, address) for an address you already suspect and
    // offers no way to enumerate holders. "MINT_ROLE was granted" is not
    // observable, so it is not said.
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'total_supply', value: '1000' }] }),
      snapshot({ block: '200', fields: [{ key: 'total_supply', value: '5000' }] }),
    );
    const change = watch.changes[0]!;
    assert.equal(change.kind, 'supply_increased');
    for (const forbidden of ['MINT_ROLE', 'granted', 'the owner', 'admin', 'the team']) {
      assert.ok(!change.detail.includes(forbidden), `the detail claims "${forbidden}"`);
    }
    assert.match(change.detail, /smaller share of the total/);
  });

  test('no detail predicts a price or a future', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({
        block: '100',
        fields: [CAP('1000'), PAUSED('none paused'), { key: 'token_name', value: 'A' }],
      }),
      snapshot({
        block: '200',
        fields: [CAP('no cap'), PAUSED('TRANSFER'), { key: 'token_name', value: 'B' }],
      }),
    );
    assert.equal(watch.changes.length, 3);
    for (const change of watch.changes) {
      for (const forbidden of ['rug', 'scam', 'likely', 'probably', 'will ', 'risky', 'safe']) {
        assert.ok(
          !change.detail.toLowerCase().includes(forbidden),
          `"${change.kind}" says "${forbidden}"`,
        );
      }
    }
  });

  test('the summary counts, and never grades', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [CAP('1000'), { key: 'contract_uri', value: 'a' }] }),
      snapshot({ block: '200', fields: [CAP('no cap'), { key: 'contract_uri', value: 'b' }] }),
    );
    const summary = b20WatchSummaryV1(watch);
    assert.equal(summary, '2 controls changed · 1 affecting holders directly');
    assert.ok(!/\/100|score|rating/i.test(summary));
  });
});

describe('the report is checkable', () => {
  test('every change carries both evidence hashes', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ ...CAP('1000'), evidenceHash: '0xbefore' }] }),
      snapshot({ block: '200', fields: [{ ...CAP('no cap'), evidenceHash: '0xafter' }] }),
    );
    assert.equal(watch.changes[0]!.evidenceBefore, '0xbefore');
    assert.equal(watch.changes[0]!.evidenceAfter, '0xafter');
    assert.equal(watch.fromBlock, '100');
    assert.equal(watch.toBlock, '200');
  });

  test('acute changes sort first', () => {
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'contract_uri', value: 'a' }, CAP('1000')] }),
      snapshot({ block: '200', fields: [{ key: 'contract_uri', value: 'b' }, CAP('no cap')] }),
    );
    assert.deepEqual(
      watch.changes.map((change) => change.severity),
      ['acute', 'informational'],
    );
  });

  test('an unrecognised field that moved is still reported', () => {
    // Silence about a control that changed is the one outcome worse than an
    // imprecise sentence about it.
    const watch = diffB20SnapshotsV1(
      snapshot({ block: '100', fields: [{ key: 'stablecoin_currency', label: 'Currency', value: 'USD' }] }),
      snapshot({ block: '200', fields: [{ key: 'stablecoin_currency', label: 'Currency', value: 'EUR' }] }),
    );
    assert.equal(watch.changes.length, 1);
    assert.equal(watch.changes[0]!.before, 'USD');
    assert.equal(watch.changes[0]!.after, 'EUR');
  });
});
