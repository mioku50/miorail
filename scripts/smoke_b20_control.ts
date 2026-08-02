/**
 * T67C smoke — B20 Control Card against Base mainnet.
 *
 * READ-ONLY. This script opens `eth_call` and `eth_getBlockByNumber` and
 * nothing else. It holds no private key, builds no transaction, signs nothing
 * and broadcasts nothing — there is no code path here through which an asset
 * could move.
 *
 * It also never prints a credential. The endpoint is read from the
 * environment, used, and reported only as "configured": a managed RPC URL
 * carries its key in the path, so echoing the URL would leak it into whatever
 * captures this output.
 *
 *   BASE_MAINNET_RPC_URL   (or BASE_RPC_URL) — required
 *   SMOKE_B20_TOKEN_ADDRESS                  — required, a mainnet B20 token
 *   SMOKE_ERC20_ADDRESS                      — optional; defaults to canonical USDC
 *
 * These are read from the root `.env` as well as from the process environment,
 * because `pnpm smoke:b20-control` runs plain `tsx` with no `--env-file`: without
 * the loader a variable that IS set in `.env` is reported as missing.
 *
 * The ordinary ERC-20 is checked SEPARATELY and on purpose: a detector that
 * says yes to everything passes a B20-only smoke test perfectly.
 */
import {
  createB20ReaderV1,
  inspectB20TokenV1,
  validateB20InspectRequestV1,
} from '@mioagent/b20-control';

import { loadRootEnvFileV1, reportLoadedEnvFileV1 } from './loadEnvFile.js';

const CANONICAL_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

function required(name: string, ...fallbacks: string[]): string {
  for (const key of [name, ...fallbacks]) {
    const value = (process.env[key] ?? '').trim();
    if (value) return value;
  }
  throw new Error(`${name} is not set`);
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(28)} ${value}`);
}

async function main(): Promise<void> {
  console.log('B20 Control smoke — Base mainnet (8453)');
  // Before any lookup, so a variable set in .env is not reported as missing.
  // Keys only are printed; a real process variable always wins over the file.
  reportLoadedEnvFileV1(loadRootEnvFileV1());

  const rpcUrl = required('BASE_MAINNET_RPC_URL', 'BASE_RPC_URL');
  const token = required('SMOKE_B20_TOKEN_ADDRESS');
  const erc20 = (process.env.SMOKE_ERC20_ADDRESS ?? CANONICAL_USDC).trim();

  // Never the URL itself.
  line('RPC endpoint', 'configured');
  line('B20 token', token);
  line('Control ERC-20', erc20);
  console.log('');

  for (const address of [token, erc20]) {
    const refusal = validateB20InspectRequestV1(8453, address);
    if (refusal) throw new Error(`${address} was refused before any read: ${refusal}`);
  }

  const reader = createB20ReaderV1({ rpcUrl, timeoutMs: 15_000 });
  const now = new Date();

  // --- the B20 token --------------------------------------------------------
  const b20 = await inspectB20TokenV1({ reader }, {
    tenantId: 'smoke',
    chainId: 8453,
    tokenAddress: token,
    now,
  });
  console.log('B20 token');
  line('detection', b20.snapshot.detection.outcome);
  line('variant', b20.snapshot.detection.variant ?? '—');
  line('variant activated', String(b20.snapshot.detection.variantActivated));
  line('block', b20.snapshot.blockNumber ?? 'not reached');
  line('block hash', b20.snapshot.blockHash ?? '—');
  line('snapshot status', b20.snapshot.status);
  console.log('');
  for (const field of b20.snapshot.fields) {
    // A row without a value prints its REASON. "unavailable" alone cannot be
    // acted on: a rate-limited endpoint and a token that genuinely lacks the
    // field need different responses from whoever is reading this output.
    line(
      field.label,
      field.status === 'exact_chain_read'
        ? (field.value ?? '')
        : `— ${field.status}: ${field.reason ?? 'no reason recorded'}`,
    );
  }
  console.log('');
  for (const statement of b20.card.statements) {
    line(statement.key, statement.observedState);
  }
  console.log('');

  if (b20.snapshot.detection.outcome !== 'b20' && b20.snapshot.detection.outcome !== 'b20_uninitialised') {
    throw new Error(`SMOKE_B20_TOKEN_ADDRESS was not detected as a B20 token (${b20.snapshot.detection.outcome})`);
  }
  // Every field must be pinned to the SAME block. A smoke run that let a
  // snapshot straddle two blocks would pass while the guarantee was broken.
  const strayBlock = b20.snapshot.evidence.find(
    (record) => record.blockNumber !== b20.snapshot.blockNumber || record.blockHash !== b20.snapshot.blockHash,
  );
  if (strayBlock) throw new Error('evidence was read at a block other than the snapshot block');
  if (b20.snapshot.evidence.length === 0) throw new Error('no evidence was recorded');

  // A throttled endpoint produces a card that is honest but thin, and the run
  // still passes — the endpoint is the operator's choice, not a defect. Say so
  // plainly, because "unavailable" next to a row otherwise looks like a fact
  // about the token. `not_enumerable` rows are excluded: those are permanent.
  const failedReads = b20.snapshot.fields.filter((field) => field.status === 'unavailable');
  if (failedReads.length > 0) {
    console.log(
      `⚠ ${failedReads.length} row(s) could not be read at this block. One card costs ~17 eth_calls,\n` +
        '  now sent as a handful of batched requests. Batching cuts round trips, NOT quota:\n' +
        '  mainnet.base.org meters per call, serves roughly the first five of a batch and refuses\n' +
        '  the rest with `over rate limit` (measured 2026-08-02). Point BASE_MAINNET_RPC_URL at a\n' +
        '  keyed endpoint for a complete card.\n',
    );
  }

  // --- the ordinary ERC-20 --------------------------------------------------
  const plain = await inspectB20TokenV1({ reader }, {
    tenantId: 'smoke',
    chainId: 8453,
    tokenAddress: erc20,
    now,
  });
  console.log('Ordinary ERC-20');
  line('detection', plain.snapshot.detection.outcome);
  line('snapshot status', plain.snapshot.status);
  line('control rows', String(plain.snapshot.fields.length));
  line('statements', String(plain.card.statements.length));
  console.log('');

  if (plain.snapshot.detection.outcome !== 'not_b20') {
    throw new Error(`the control ERC-20 must be not_b20, got ${plain.snapshot.detection.outcome}`);
  }
  if (plain.card.statements.length !== 0) {
    throw new Error('an ordinary ERC-20 must carry no B20 control claims');
  }

  // --- nothing credential-shaped escaped ------------------------------------
  const serialised = JSON.stringify([b20.snapshot, plain.snapshot]);
  if (/https?:\/\//.test(serialised)) throw new Error('a URL reached a snapshot');
  if (serialised.includes(rpcUrl)) throw new Error('the RPC endpoint reached a snapshot');

  console.log('OK — B20 detected, ordinary ERC-20 refused, one block, no credential in any record.');
}

main().catch((error: unknown) => {
  // The message may carry provider text, so it is printed as a name plus a
  // redacted message rather than verbatim.
  const message = error instanceof Error ? error.message.replace(/https?:\/\/\S+/gi, '<url>') : 'unknown error';
  console.error(`FAILED — ${message}`);
  process.exitCode = 1;
});
