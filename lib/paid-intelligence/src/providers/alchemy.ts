import { z } from 'zod';
import { hashApprovedCallsV1, type ExecutionCallV1 } from '@mioagent/route-domain';
import {
  SimulationProviderResponseV1Schema,
  type SimulationAssetChangeV1,
  type SimulationAssetChangesV1,
  type SimulationCallResultV1,
  type SimulationProviderResponseV1,
  type SimulationProviderStateChangeV1,
} from '../schemas.js';
import type {
  SimulationProvider,
  SimulationProviderRequestV1,
  SimulationProviderResultV1,
} from '../provider.js';

// ---------------------------------------------------------------------------
// T63B — Alchemy `eth_simulateV1` adapter for Base mainnet.
//
// It implements the EXISTING SimulationProvider interface and emits the
// EXISTING SimulationProviderResponseV1 shape, so both paid flows — T59's
// one-time x402 simulation and T60's Intelligence Budget simulation — pick it
// up through the same seam with no change to how anyone is charged.
//
// Boundaries this file exists to hold:
//   * The endpoint is built HERE from the server-side API key. There is no URL
//     input, no per-request override, and the key never leaves this module: it
//     is not returned, not put in an error detail, and not part of any hash.
//   * Blueprint calls are simulated in their persisted order, verbatim. No
//     state overrides, no balance/allowance forging, no client calldata.
//   * Validation is fail-closed. An unknown call status, a missing block, a
//     bad hex quantity or a call-count mismatch is a typed failure — never a
//     simulation that silently "passed".
// ---------------------------------------------------------------------------

export const ALCHEMY_SIMULATION_PROVIDER_ID_V1 = 'alchemy-eth-simulate-v1';
export const ALCHEMY_BASE_MAINNET_HOST_V1 = 'base-mainnet.g.alchemy.com';
/** Module-private on purpose: this adapter is Base-mainnet-only, and the id is
 * not a knob any caller should be able to reach for. */
const BASE_MAINNET_CHAIN_ID_V1 = 8453;
const DEFAULT_ALCHEMY_TIMEOUT_MS = 12_000;
const MAX_ALCHEMY_TIMEOUT_MS = 60_000;

/**
 * The normalized T63B failure taxonomy. `simulation_reverted` is deliberately
 * NOT here: a revert is a successful, paid-for answer about the transaction,
 * and it travels as `status:'reverted'` inside a valid response body — not as
 * a provider failure. `network_error` is the pre-existing transport code from
 * the T59 interface, reused for a socket-level failure that never produced an
 * HTTP status.
 */
export type AlchemySimulationFailureCodeV1 =
  | 'provider_not_configured'
  | 'provider_timeout'
  | 'provider_rate_limited'
  | 'provider_http_error'
  | 'network_error'
  | 'provider_rpc_error'
  /** The sender cannot pay for what it is being asked to send. A real answer
   * about the transaction, named rather than left as a generic RPC error. */
  | 'provider_insufficient_funds'
  /** The endpoint does not offer eth_simulateV1 — a plan or tier problem, not
   * a transient outage, so it must not read as one. */
  | 'provider_method_unsupported'
  | 'provider_invalid_schema'
  | 'provider_call_count_mismatch'
  | 'provider_chain_mismatch'
  | 'provider_blueprint_mismatch';

/** Result code carried INSIDE a valid response, kept next to the failures so
 * the whole T63B vocabulary is readable in one place. */
export const SIMULATION_REVERTED_CODE_V1 = 'simulation_reverted';

// --- JSON-RPC response contract ---------------------------------------------

const HEX_QUANTITY_V1 = /^0x[0-9a-fA-F]{1,32}$/;
const HEX_DATA_V1 = /^0x(?:[0-9a-fA-F]{2})*$/;
const HEX_ADDRESS_V1 = /^0x[0-9a-fA-F]{40}$/;
const HEX_TOPIC_V1 = /^0x[0-9a-fA-F]{64}$/;

const AlchemyLogSchemaV1 = z
  .object({
    address: z.string().regex(HEX_ADDRESS_V1, 'Expected a 20-byte log address'),
    topics: z.array(z.string().regex(HEX_TOPIC_V1, 'Expected a 32-byte topic')).max(4),
    data: z.string().regex(HEX_DATA_V1, 'Expected even-length hex log data').max(200_000),
  })
  .passthrough();

const AlchemyCallResultSchemaV1 = z
  .object({
    // Kept as a raw string: an UNKNOWN status must reach our own check and be
    // rejected there, rather than being dropped by an enum and re-read as a
    // missing field.
    status: z.string().min(1).max(32),
    gasUsed: z.string().regex(HEX_QUANTITY_V1, 'Expected a hex gas quantity'),
    returnData: z.string().regex(HEX_DATA_V1).max(200_000).optional(),
    logs: z.array(AlchemyLogSchemaV1).max(1_000).optional(),
    error: z
      .object({ message: z.string().max(1_000).optional(), data: z.string().max(20_000).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const AlchemyBlockResultSchemaV1 = z
  .object({
    number: z.string().regex(HEX_QUANTITY_V1, 'Expected a hex block number'),
    calls: z.array(AlchemyCallResultSchemaV1).max(100),
  })
  .passthrough();

const AlchemyRpcResponseSchemaV1 = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string().max(200), z.number()]),
    result: z.array(AlchemyBlockResultSchemaV1).max(10).optional(),
    error: z
      .object({
        code: z.number().optional(),
        message: z.string().max(2_000).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// --- Event decoding (T63B §5) ------------------------------------------------

/** keccak256("Transfer(address,address,uint256)") */
const ERC20_TRANSFER_TOPIC_V1 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** keccak256("Deposit(address,uint256)") */
const WETH_DEPOSIT_TOPIC_V1 = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
/** keccak256("Withdrawal(address,uint256)") */
const WETH_WITHDRAWAL_TOPIC_V1 = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
/** Canonical WETH on Base. Deposit/Withdrawal are decoded ONLY from this pinned
 * address — the same two topics on an arbitrary contract prove nothing about
 * wrapped ETH. */
const BASE_WETH_ADDRESS_V1 = '0x4200000000000000000000000000000000000006';

function addressFromTopic(topic: string): string | null {
  if (!HEX_TOPIC_V1.test(topic)) return null;
  // A 32-byte topic holding an address is left-padded with 12 zero bytes.
  if (!/^0x0{24}/.test(topic)) return null;
  return `0x${topic.slice(26)}`.toLowerCase();
}

function uint256FromHexData(data: string): string | null {
  const body = data.slice(2);
  if (body.length < 64) return null;
  // Only the FIRST word is read; a longer payload is a different event shape
  // and is left undecoded rather than guessed at.
  if (body.length !== 64) return null;
  try {
    return BigInt(`0x${body}`).toString();
  } catch {
    return null;
  }
}

interface DecodedLogsV1 {
  changes: SimulationAssetChangeV1[];
  /** A log we recognised the topic of but could not decode safely. */
  undecodable: number;
}

/**
 * Decodes ONLY events that prove an asset movement for the authenticated
 * wallet. Anything else — an unknown topic, a malformed word, a movement
 * between two third parties — is skipped. Native ETH is never inferred: it
 * emits no log, so it stays unknown by construction.
 */
function decodeAssetChangesV1(
  logs: readonly z.infer<typeof AlchemyLogSchemaV1>[],
  wallet: string,
  callIndex: number,
): DecodedLogsV1 {
  const changes: SimulationAssetChangeV1[] = [];
  let undecodable = 0;

  for (const log of logs) {
    const topic0 = log.topics[0]?.toLowerCase();
    if (!topic0) continue;
    const token = log.address.toLowerCase();

    if (topic0 === ERC20_TRANSFER_TOPIC_V1) {
      const from = log.topics[1] ? addressFromTopic(log.topics[1]) : null;
      const to = log.topics[2] ? addressFromTopic(log.topics[2]) : null;
      const amountAtomic = uint256FromHexData(log.data);
      if (!from || !to || amountAtomic === null) {
        undecodable += 1;
        continue;
      }
      // Only movements the authenticated wallet is a party to.
      if (to === wallet) {
        changes.push({ kind: 'erc20_transfer', token, direction: 'in', amountAtomic, counterparty: from, callIndex });
      } else if (from === wallet) {
        changes.push({ kind: 'erc20_transfer', token, direction: 'out', amountAtomic, counterparty: to, callIndex });
      }
      continue;
    }

    if (token !== BASE_WETH_ADDRESS_V1) continue;

    if (topic0 === WETH_DEPOSIT_TOPIC_V1 || topic0 === WETH_WITHDRAWAL_TOPIC_V1) {
      const account = log.topics[1] ? addressFromTopic(log.topics[1]) : null;
      const amountAtomic = uint256FromHexData(log.data);
      if (!account || amountAtomic === null) {
        undecodable += 1;
        continue;
      }
      if (account !== wallet) continue;
      changes.push({
        kind: topic0 === WETH_DEPOSIT_TOPIC_V1 ? 'weth_deposit' : 'weth_withdrawal',
        token,
        direction: topic0 === WETH_DEPOSIT_TOPIC_V1 ? 'in' : 'out',
        amountAtomic,
        counterparty: null,
        callIndex,
      });
    }
  }

  return { changes, undecodable };
}

function stateChangeSummaryV1(change: SimulationAssetChangeV1): SimulationProviderStateChangeV1 {
  const verb =
    change.kind === 'weth_deposit'
      ? 'wraps'
      : change.kind === 'weth_withdrawal'
        ? 'unwraps'
        : change.direction === 'in'
          ? 'receives'
          : 'sends';
  // Base units only — no symbol/decimals are known from a log, so none are shown.
  const counterparty = change.counterparty ? ` ${change.direction === 'in' ? 'from' : 'to'} ${change.counterparty}` : '';
  return {
    address: change.token,
    kind: 'token',
    summary: `Call ${change.callIndex}: wallet ${verb} ${change.amountAtomic} base units of ${change.token}${counterparty}`,
  };
}

// --- Request mapping (T63B §3) ----------------------------------------------

/** Decimal base-unit string → canonical JSON-RPC hex quantity (no leading
 * zeros, `0x0` for zero). Returns null for anything that is not an unsigned
 * integer, so a malformed persisted value can never be sent as calldata. */
export function toHexQuantityV1(value: string): string | null {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return `0x${BigInt(value).toString(16)}`;
}

export interface AlchemySafeRequestV1 {
  method: 'eth_simulateV1';
  chainId: number;
  from: string;
  blockTag: 'latest';
  calls: { to: string; value: string; data: string }[];
}

/**
 * Builds the request WITHOUT any secret. This is the only representation of
 * the request that may be hashed, logged or returned — the real endpoint (which
 * embeds the API key in its path) never appears in it.
 */
export function buildAlchemySafeRequestV1(
  walletAddress: string,
  calls: readonly ExecutionCallV1[],
): AlchemySafeRequestV1 | null {
  const mapped: AlchemySafeRequestV1['calls'] = [];
  for (const call of calls) {
    const value = toHexQuantityV1(call.valueWei);
    if (value === null) return null;
    // to/value/data come from the PERSISTED Blueprint only.
    mapped.push({ to: call.to.toLowerCase(), value, data: call.data });
  }
  return {
    method: 'eth_simulateV1',
    chainId: BASE_MAINNET_CHAIN_ID_V1,
    from: walletAddress.toLowerCase(),
    blockTag: 'latest',
    calls: mapped,
  };
}

// --- Adapter ----------------------------------------------------------------

export interface CreateAlchemySimulationProviderOptionsV1 {
  /** Server-side key. Empty/missing yields provider_not_configured — the
   * adapter is still constructible so the failure is typed, not a crash. */
  apiKey: string | undefined;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  providerId?: string;
}

function isTimeoutErrorV1(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted/i.test(message);
}

function isRateLimitRpcErrorV1(error: { code?: number; message?: string } | undefined): boolean {
  if (!error) return false;
  if (error.code === 429 || error.code === -32029 || error.code === -32005) return true;
  return /rate limit|too many requests|throughput/i.test(error.message ?? '');
}

function failureV1(
  errorCode: AlchemySimulationFailureCodeV1,
  detail: string,
  providerMessage?: string,
): SimulationProviderResultV1 {
  // `detail` is always a fixed, self-authored string — never the endpoint, the
  // key, or raw upstream text that could carry either. `providerMessage` is the
  // upstream text, and it is REDACTED before it gets here.
  return providerMessage === undefined ? { ok: false, errorCode, detail } : { ok: false, errorCode, detail, providerMessage };
}

/**
 * What Alchemy actually objected to.
 *
 * A JSON-RPC error used to collapse into one opaque `provider_rpc_error`, so a
 * wallet that simply could not afford the purchase and an endpoint without
 * eth_simulateV1 were indistinguishable — from the screen AND from the log.
 */
export function classifyAlchemyRpcErrorV1(error: { code?: number; message?: string } | undefined): AlchemySimulationFailureCodeV1 {
  const message = error?.message ?? '';
  if (/insufficient funds|insufficient balance|exceeds balance/i.test(message)) return 'provider_insufficient_funds';
  if (error?.code === -32601 || /method not found|not supported|unsupported method/i.test(message)) {
    return 'provider_method_unsupported';
  }
  return 'provider_rpc_error';
}

/**
 * Upstream text, made safe to log.
 *
 * The endpoint embeds the API key in its path, and an upstream message that
 * echoes the endpoint is exactly how a key reaches a log file. The key is
 * removed by value and every URL is dropped whether or not it carried one.
 */
export function redactAlchemyTextV1(text: string, apiKey: string): string {
  const withoutKey = apiKey.length > 0 ? text.split(apiKey).join('<redacted>') : text;
  return withoutKey.replace(/https?:\/\/\S+/gi, '<url>').slice(0, 300);
}

/**
 * Creates the Alchemy `eth_simulateV1` provider. Base mainnet only: a request
 * for any other chain is refused rather than silently pointed elsewhere.
 */
export function createAlchemySimulationProviderV1(
  options: CreateAlchemySimulationProviderOptionsV1,
): SimulationProvider {
  const apiKey = options.apiKey?.trim() ?? '';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Math.min(
    MAX_ALCHEMY_TIMEOUT_MS,
    Math.max(1_000, Math.floor(options.timeoutMs ?? DEFAULT_ALCHEMY_TIMEOUT_MS)),
  );
  const providerId = options.providerId ?? ALCHEMY_SIMULATION_PROVIDER_ID_V1;

  return {
    providerId,
    async simulate(request: SimulationProviderRequestV1): Promise<SimulationProviderResultV1> {
      if (!apiKey) return failureV1('provider_not_configured', 'Alchemy API key is not configured');
      if (request.chainId !== BASE_MAINNET_CHAIN_ID_V1) {
        return failureV1('provider_chain_mismatch', 'Alchemy simulation supports Base mainnet only');
      }
      if (request.calls.length === 0) {
        return failureV1('provider_blueprint_mismatch', 'Blueprint contains no calls to simulate');
      }
      // Defense in depth: the calls about to be simulated must be exactly the
      // ones the caller's callsHash was computed over.
      if (hashApprovedCallsV1(request.calls) !== request.callsHash) {
        return failureV1('provider_blueprint_mismatch', 'Blueprint calls do not match their calls hash');
      }

      const safeRequest = buildAlchemySafeRequestV1(request.walletAddress, request.calls);
      if (!safeRequest) {
        return failureV1('provider_blueprint_mismatch', 'Blueprint call values are not unsigned integers');
      }

      const rpcId = `miorail-sim-${request.callsHash.slice(2, 18)}`;
      const rpcBody = {
        jsonrpc: '2.0' as const,
        id: rpcId,
        method: 'eth_simulateV1' as const,
        params: [
          {
            // ONE block state call holding every Blueprint call, so ordering is
            // exactly the persisted order and nothing is re-grouped.
            blockStateCalls: [
              {
                calls: safeRequest.calls.map((call) => ({
                  from: safeRequest.from,
                  to: call.to,
                  value: call.value,
                  data: call.data,
                })),
              },
            ],
            // No stateOverrides: balances, allowances and nonces are whatever
            // the chain really holds. `validation` stays off because the batch
            // this Blueprint becomes may be fee-sponsored — turning it on would
            // report a gas-funding revert the real submission never hits.
            validation: false,
            // Off deliberately: with transfer tracing on, native ETH movement
            // is synthesised as pseudo-Transfer logs, which is exactly the
            // "invented native delta" T63B forbids.
            traceTransfers: false,
            returnFullTransactionObjects: false,
          },
          'latest',
        ],
      };

      let rawBody: string;
      try {
        const response = await fetchImpl(`https://${ALCHEMY_BASE_MAINNET_HOST_V1}/v2/${apiKey}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(rpcBody),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          if (response.status === 429) return failureV1('provider_rate_limited', 'Alchemy rate limited the simulation');
          // The status only — an upstream body can echo the request URL.
          return failureV1('provider_http_error', `Alchemy returned HTTP ${response.status}`);
        }
        rawBody = await response.text();
      } catch (error) {
        if (isTimeoutErrorV1(error)) return failureV1('provider_timeout', 'Alchemy simulation timed out');
        return failureV1('network_error', 'Alchemy simulation transport failed');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return failureV1('provider_invalid_schema', 'Alchemy response was not valid JSON');
      }
      const parsed = AlchemyRpcResponseSchemaV1.safeParse(payload);
      if (!parsed.success) return failureV1('provider_invalid_schema', 'Alchemy response failed schema validation');
      const envelope = parsed.data;

      if (envelope.id !== rpcId) {
        return failureV1('provider_invalid_schema', 'Alchemy response id does not match the request');
      }
      if (envelope.error) {
        if (isRateLimitRpcErrorV1(envelope.error)) {
          return failureV1('provider_rate_limited', 'Alchemy rate limited the simulation');
        }
        return failureV1(
          classifyAlchemyRpcErrorV1(envelope.error),
          'Alchemy returned a JSON-RPC error',
          redactAlchemyTextV1(envelope.error.message ?? `code ${envelope.error.code ?? 'unknown'}`, apiKey),
        );
      }
      if (!envelope.result || envelope.result.length === 0) {
        return failureV1('provider_invalid_schema', 'Alchemy response carried no simulation result');
      }

      const blocks = envelope.result;
      const blockNumberHex = blocks[0].number;
      let blockNumber: number;
      try {
        blockNumber = Number(BigInt(blockNumberHex));
      } catch {
        return failureV1('provider_invalid_schema', 'Alchemy block number is not a hex quantity');
      }
      if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
        return failureV1('provider_invalid_schema', 'Alchemy block number is not a positive integer');
      }

      // Calls are read in block order, then call order — the persisted
      // Blueprint order — and the total must match exactly.
      const simulatedCalls = blocks.flatMap((block) => block.calls);
      if (simulatedCalls.length !== request.calls.length) {
        return failureV1(
          'provider_call_count_mismatch',
          `Alchemy simulated ${simulatedCalls.length} of ${request.calls.length} Blueprint calls`,
        );
      }

      const wallet = request.walletAddress.toLowerCase();
      const callResults: SimulationCallResultV1[] = [];
      const assetChanges: SimulationAssetChangeV1[] = [];
      let totalGas = 0n;
      let failedCallIndex: number | null = null;
      let undecodableLogs = 0;
      let sawLogs = false;

      for (const [index, call] of simulatedCalls.entries()) {
        // Unknown status NEVER becomes success.
        if (call.status !== '0x1' && call.status !== '0x0') {
          return failureV1('provider_invalid_schema', `Alchemy call ${index} reported an unknown status`);
        }
        let gasUsed: bigint;
        try {
          gasUsed = BigInt(call.gasUsed);
        } catch {
          return failureV1('provider_invalid_schema', `Alchemy call ${index} reported an invalid gas quantity`);
        }
        if (gasUsed < 0n) {
          return failureV1('provider_invalid_schema', `Alchemy call ${index} reported a negative gas quantity`);
        }
        totalGas += gasUsed;

        const reverted = call.status === '0x0';
        if (reverted && failedCallIndex === null) failedCallIndex = index;

        const logs = call.logs ?? [];
        if (logs.length > 0) sawLogs = true;
        // A reverted call's logs are discarded by the EVM, so they prove nothing.
        const decoded = reverted ? { changes: [], undecodable: 0 } : decodeAssetChangesV1(logs, wallet, index);
        undecodableLogs += decoded.undecodable;
        assetChanges.push(...decoded.changes);

        const revertReason = reverted ? (call.error?.message?.trim() || null) : null;
        callResults.push({
          index,
          status: reverted ? 'reverted' : 'success',
          gasUsed: gasUsed.toString(),
          revertReason: revertReason && revertReason.length > 0 ? revertReason.slice(0, 1_000) : null,
          logCount: logs.length,
        });
      }

      const status: 'success' | 'reverted' = failedCallIndex === null ? 'success' : 'reverted';

      // Asset changes are only claimed "available" when the run could actually
      // prove them: every log we saw was decoded, and a successful run that
      // emitted nothing at all leaves the effects unproven rather than empty.
      let assetChangeBlock: SimulationAssetChangesV1;
      if (status === 'reverted') {
        assetChangeBlock = {
          status: 'unavailable',
          unavailableReason: 'simulation_reverted_no_state_change',
          changes: [],
        };
      } else if (undecodableLogs > 0) {
        assetChangeBlock = {
          status: 'unavailable',
          unavailableReason: 'undecodable_logs_present',
          changes: [],
        };
      } else if (assetChanges.length === 0) {
        assetChangeBlock = {
          status: 'unavailable',
          unavailableReason: sawLogs ? 'no_wallet_asset_events_decoded' : 'no_logs_emitted',
          changes: [],
        };
      } else {
        assetChangeBlock = { status: 'available', unavailableReason: null, changes: assetChanges };
      }

      const body: SimulationProviderResponseV1 = {
        status,
        blockNumber,
        gasUsed: totalGas.toString(),
        // Human-readable mirror of the PROVEN asset changes, for the existing
        // T59 response field. Bounded by the schema's own max(100).
        stateChanges: assetChangeBlock.changes.slice(0, 100).map(stateChangeSummaryV1),
        revertReason:
          failedCallIndex === null
            ? null
            : callResults[failedCallIndex]?.revertReason ?? `Call ${failedCallIndex} reverted`,
        callResults,
        failedCallIndex,
        assetChanges: assetChangeBlock,
      };

      // Self-check: the adapter never emits a body its own consumers would
      // reject. A failure here is our bug, reported as a schema failure rather
      // than thrown into the paid flow.
      const validated = SimulationProviderResponseV1Schema.safeParse(body);
      if (!validated.success) {
        return failureV1('provider_invalid_schema', 'Normalized Alchemy result failed contract validation');
      }
      return { ok: true, body: validated.data };
    },
  };
}
