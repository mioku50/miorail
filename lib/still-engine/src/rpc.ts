// Reading Base: providers, one-block batches through Multicall3, and the failure taxonomy.
//
// A failed read is never an empty read. Each call in a batch comes back as its own outcome;
// a batch that no provider answered throws a ChainUnavailable that names every attempt.
// Provider URLs carry keys, so only a label derived from the host ever leaves this module.

import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseAbi,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
  type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { ADDRESSES } from './registry.js';

export interface Provider {
  /** Host-derived label such as "alchemy"; never the URL. */
  readonly label: string;
  readonly client: PublicClient;
}

export function providerLabel(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
  if (host.endsWith('.alchemy.com')) return 'alchemy';
  if (host.endsWith('.infura.io')) return 'infura';
  if (host === 'mainnet.base.org') return 'base-public';
  if (host.endsWith('.quiknode.pro')) return 'quicknode';
  if (host.endsWith('drpc.org')) return 'drpc';
  return 'rpc';
}

export function createProviders(urls: readonly string[], userAgent = 'still/0.1'): Provider[] {
  return urls
    .filter((url) => url.trim().length > 0)
    .map((url) => ({
      label: providerLabel(url),
      client: createPublicClient({
        chain: base,
        transport: http(url, {
          retryCount: 1,
          retryDelay: 300,
          timeout: 12_000,
          fetchOptions: { headers: { 'user-agent': userAgent } },
        }),
      }) as PublicClient,
    }));
}

export type FailureKind = 'throttled' | 'unavailable' | 'rejected';

export interface ProviderAttempt {
  provider: string;
  kind: FailureKind;
}

/** No provider answered: our failure, never a fact about the wallet. */
export class ChainUnavailable extends Error {
  readonly attempts: readonly ProviderAttempt[];
  constructor(attempts: readonly ProviderAttempt[]) {
    super(`no provider answered: ${attempts.map((a) => `${a.provider} ${a.kind}`).join(', ') || 'none configured'}`);
    this.name = 'ChainUnavailable';
    this.attempts = attempts;
  }
}

/** Classify a transport error by status, JSON-RPC code and wording, never by wording alone. */
export function classifyFailure(error: unknown): FailureKind {
  const seen = new Set<unknown>();
  let status: number | undefined;
  let code: number | undefined;
  let text = '';
  for (let e: unknown = error; e && typeof e === 'object' && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const o = e as { status?: unknown; code?: unknown; message?: unknown; details?: unknown; name?: unknown };
    if (typeof o.status === 'number') status ??= o.status;
    if (typeof o.code === 'number') code ??= o.code;
    text += ` ${String(o.name ?? '')} ${String(o.message ?? '')} ${String(o.details ?? '')}`;
  }
  if (status === 429 || code === 429 || code === -32005 || code === -32007 || code === -32011 || code === -33200 || code === -33300) {
    return 'throttled';
  }
  if (/rate limit|request limit|too many requests|throttl|capacity exceeded/i.test(text)) return 'throttled';
  if (status === 402) return 'rejected';
  if (status !== undefined && status >= 400 && status < 500) return 'rejected';
  return 'unavailable';
}

// Declared view (it is payable onchain) so it can be read with eth_call, as viem's own multicall does.
const aggregate3Abi = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
]);

/** One call's outcome. A revert is the contract's answer; undecodable means the shape surprised us. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: 'reverted' | 'undecodable' };

export interface Slot<T> {
  readonly outcome: Outcome<T>;
}

interface PendingCall {
  target: Address;
  callData: Hex;
  decode: (data: Hex) => unknown;
  slot: { outcome: Outcome<unknown> };
}

type ViewName<abi extends Abi> = ContractFunctionName<abi, 'view' | 'pure'>;

/** A set of reads executed together in one eth_call, so every answer comes from the same block. */
export class Batch {
  readonly #calls: PendingCall[] = [];

  add<const abi extends Abi, name extends ViewName<abi>>(
    target: Address,
    abi: abi,
    functionName: name,
    args: ContractFunctionArgs<abi, 'view' | 'pure', name>,
  ): Slot<ContractFunctionReturnType<abi, 'view' | 'pure', name>> {
    const encode = encodeFunctionData as (p: { abi: Abi; functionName: string; args: readonly unknown[] }) => Hex;
    const decode = decodeFunctionResult as (p: { abi: Abi; functionName: string; data: Hex }) => unknown;
    return this.raw(target, encode({ abi, functionName, args: args as readonly unknown[] }), (data) =>
      decode({ abi, functionName, data }),
    ) as Slot<ContractFunctionReturnType<abi, 'view' | 'pure', name>>;
  }

  raw<T>(target: Address, callData: Hex, decode: (data: Hex) => T): Slot<T> {
    const slot: { outcome: Outcome<unknown> } = { outcome: { ok: false, reason: 'undecodable' } };
    this.#calls.push({ target, callData, decode, slot });
    return slot as Slot<T>;
  }

  get size(): number {
    return this.#calls.length;
  }

  /** Runs on the first provider that answers; throws ChainUnavailable when none does. */
  async run(providers: readonly Provider[], blockNumber?: bigint): Promise<{ provider: string }> {
    const attempts: ProviderAttempt[] = [];
    for (const provider of providers) {
      try {
        const results = await provider.client.readContract({
          address: ADDRESSES.multicall3,
          abi: aggregate3Abi,
          functionName: 'aggregate3',
          args: [this.#calls.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }))],
          ...(blockNumber === undefined ? { blockTag: 'latest' as const } : { blockNumber }),
        });
        if (results.length !== this.#calls.length) throw new Error('multicall answered a different number of results');
        results.forEach((result, i) => {
          const call = this.#calls[i]!;
          if (!result.success) {
            call.slot.outcome = { ok: false, reason: 'reverted' };
            return;
          }
          try {
            call.slot.outcome = { ok: true, value: call.decode(result.returnData) };
          } catch {
            call.slot.outcome = { ok: false, reason: 'undecodable' };
          }
        });
        return { provider: provider.label };
      } catch (error) {
        attempts.push({ provider: provider.label, kind: classifyFailure(error) });
      }
    }
    throw new ChainUnavailable(attempts);
  }
}

/** The value of a read, or undefined when it failed. Callers keep the failure visible. */
export function valueOf<T>(slot: Slot<T>): T | undefined {
  return slot.outcome.ok ? slot.outcome.value : undefined;
}
