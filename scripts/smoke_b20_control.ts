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
 * The ordinary ERC-20 is checked SEPARATELY and on purpose: a detector that
 * says yes to everything passes a B20-only smoke test perfectly.
 */
import {
  createB20ReaderV1,
  inspectB20TokenV1,
  validateB20InspectRequestV1,
} from '@mioagent/b20-control';

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
  const rpcUrl = required('BASE_MAINNET_RPC_URL', 'BASE_RPC_URL');
  const token = required('SMOKE_B20_TOKEN_ADDRESS');
  const erc20 = (process.env.SMOKE_ERC20_ADDRESS ?? CANONICAL_USDC).trim();

  // Never the URL itself.
  console.log('B20 Control smoke — Base mainnet (8453)');
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
    line(field.label, field.status === 'exact_chain_read' ? (field.value ?? '') : `— ${field.status}`);
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
