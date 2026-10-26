// Found reads one Base block. Simulations are eth_call only; no signing or broadcasting API.
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from 'viem';
import { multicall3Abi } from './abi.js';
import { ADDRESSES } from './registry.js';
import { Batch, valueOf, type Provider } from './rpc.js';
import { FOUND, aeroPositionAbi, foundAggregateAbi, foundDiscoveryAbi, foundTokenAbi, uniPositionAbi } from './found-abi.js';
import { emptyFoundReport, type FoundReport, type FoundVenue } from './found-report.js';
import { priceFoundTokens, sumFoundCents } from './found-prices.js';

const ZERO = '0x0000000000000000000000000000000000000000';
// The V2 factory has no NFT manager. A failed probe of any other factory stays unknown.
const V2_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const MAX_NFTS = 10_000;
const MAX_GAUGES = 10_000;
const MAX_UINT128 = 2n ** 128n - 1n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const address = (a: string) => a.toLowerCase() as Address;
const chunks = <T>(items: T[], size = 80): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const issue = (venue: FoundVenue, text: string) => { if (!venue.issues.includes(text)) venue.issues.push(text); };

export function addFoundAmount(venue: FoundVenue, token: string, raw: bigint): void {
  if (raw <= 0n) return;
  const prior = venue.amounts.find((a) => same(a.token, token));
  if (prior) prior.raw = (BigInt(prior.raw) + raw).toString();
  else venue.amounts.push({ token: address(token), raw: raw.toString() });
}

interface Manager { address: Address; aero: boolean }
interface Gauge { address: Address; factory: Address | null }
interface GaugeIndex { block: bigint; count: number; signature: string; entries: Gauge[] }
export interface FoundReadOptions {
  providers: readonly Provider[];
  fetcher?: typeof fetch;
  now?: () => Date;
  /** A time budget is always disclosed as incomplete coverage, never as zero. */
  budgetMs?: number;
}

export function createFoundReader(options: FoundReadOptions) {
  const { providers } = options;
  const now = options.now ?? (() => new Date());
  // Voter.createGauge writes each pool's gauge once and appends to pools. Reuse only this
  // immutable index, not wallet reads. A changed factory set or count invalidates the cache.
  let index: GaugeIndex | null = null;

  return async (owner: Address, progress: (report: FoundReport) => void = () => {}): Promise<FoundReport> => {
    const report = emptyFoundReport(owner);
    report.state = 'reading';
    const [uni, aero, rewards] = report.venues as [FoundVenue, FoundVenue, FoundVenue];
    const started = performance.now();
    // Keep the provider that answered first. Repeating a rejected primary before every read
    // can consume the entire time budget even while the fallback is healthy.
    const ordered = [...providers];
    const prefer = (label: string) => ordered.sort((a, b) => Number(b.label === label) - Number(a.label === label));
    const checkBudget = () => { if (performance.now() - started > (options.budgetMs ?? 180_000)) throw new Error('Found time budget'); };
    const publish = () => progress(structuredClone(report));
    let block: bigint;
    const run = async (batch: Batch) => { checkBudget(); if (batch.size) prefer((await batch.run(ordered, block)).provider); };
    const anchor = new Batch();
    const height = anchor.add(ADDRESSES.multicall3, multicall3Abi, 'getBlockNumber', []);
    const clock = anchor.add(ADDRESSES.multicall3, multicall3Abi, 'getCurrentBlockTimestamp', []);
    try {
      prefer((await anchor.run(ordered)).provider);
      if (!height.outcome.ok || !clock.outcome.ok) throw new Error('Block unread');
      block = height.outcome.value;
      report.reading = { block: String(block), blockTime: new Date(Number(clock.outcome.value) * 1_000).toISOString(), assembledAt: now().toISOString() };
    } catch {
      report.state = 'unavailable';
      for (const v of report.venues) { v.state = 'partial'; issue(v, 'Base did not answer; nothing concluded about this wallet.'); }
      return report;
    }
    publish();
    let observationCode: Hex | undefined;

    // Every simulation retries another provider at the exact same block. Discard its complete
    // result on a decode failure; no mixture of before/after balances from different calls.
    async function simulate<T>(to: Address, data: Hex, decode: (data: Hex) => T, code?: Hex): Promise<T> {
      for (const p of [...ordered]) {
        checkBudget();
        try {
          const result = await p.client.call({ account: owner, to, data, blockNumber: block, gas: 20_000_000n,
            ...(code ? { stateOverride: [{ address: owner, code }] } : {}),
          });
          if (result.data) { const decoded = decode(result.data); prefer(p.label); return decoded; }
        } catch { /* Never expose a transport message: it can include an RPC key. */ }
      }
      throw new Error('Simulation unavailable');
    }

    async function walletSimulation<T>(calls: Array<{ target: Address; allowFailure: boolean; callData: Hex }>, decode: (results: readonly { success: boolean; returnData: Hex }[]) => T): Promise<T> {
      checkBudget();
      if (!observationCode || observationCode === '0x') for (const p of ordered) {
        try { observationCode = await p.client.getCode({ address: ADDRESSES.multicall3, blockNumber: block }); if (observationCode && observationCode !== '0x') break; } catch { /* next provider */ }
      }
      if (!observationCode || observationCode === '0x') throw new Error('Observation code unread');
      return simulate(owner, encodeFunctionData({ abi: foundAggregateAbi, functionName: 'aggregate3', args: [calls] }), (raw) => {
        const result = decodeFunctionResult({ abi: foundAggregateAbi, functionName: 'aggregate3', data: raw });
        if (result.length !== calls.length || result.some((r) => !r.success)) throw new Error('Observation unread');
        return decode(result);
      }, observationCode);
    }
    const balanceCall = (token: Address) => ({ target: token, allowFailure: false, callData: encodeFunctionData({ abi: foundTokenAbi, functionName: 'balanceOf', args: [owner] }) });
    const balance = (raw: Hex) => decodeFunctionResult({ abi: foundTokenAbi, functionName: 'balanceOf', data: raw });

    async function readManagers(venue: FoundVenue, managers: Manager[], discoveryComplete = true) {
      venue.state = 'reading';
      const batch = new Batch();
      const counts = managers.map((m) => ({ m, slot: batch.add(m.address, uniPositionAbi, 'balanceOf', [owner]) }));
      await run(batch);
      const allCounts = discoveryComplete && counts.every((c) => c.slot.outcome.ok && c.slot.outcome.value <= BigInt(Number.MAX_SAFE_INTEGER));
      const total = counts.reduce((sum, c) => sum + (c.slot.outcome.ok && c.slot.outcome.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(c.slot.outcome.value) : 0), 0);
      venue.coverage.total = allCounts ? total : null;
      venue.positions = allCounts ? total : null;
      if (!allCounts) issue(venue, 'Some NFT managers or balances could not be read; the full position count is unknown.');
      let remaining = MAX_NFTS;
      for (const { m, slot } of counts) {
        if (!slot.outcome.ok) continue;
        const count = Number(slot.outcome.value > BigInt(MAX_NFTS) ? BigInt(MAX_NFTS) : slot.outcome.value);
        const limit = Math.min(count, remaining);
        remaining -= limit;
        if (slot.outcome.value > BigInt(limit)) issue(venue, `The ${MAX_NFTS.toLocaleString('en-US')} NFT safety limit was reached; this check is partial.`);
        for (let offset = 0; offset < limit; offset += 80) {
          const ids = new Batch();
          const slots = Array.from({ length: Math.min(80, limit - offset) }, (_, i) => ids.add(m.address, uniPositionAbi, 'tokenOfOwnerByIndex', [owner, BigInt(offset + i)]));
          await run(ids);
          const infos = new Batch();
          const positions = slots.map((s) => {
            if (!s.outcome.ok) return null;
            return { id: s.outcome.value, slot: m.aero
              ? infos.add(m.address, aeroPositionAbi, 'positions', [s.outcome.value])
              : infos.add(m.address, uniPositionAbi, 'positions', [s.outcome.value]) };
          });
          await run(infos);
          const live: Array<{ id: bigint; token0: Address; token1: Address }> = [];
          for (const p of positions) {
            venue.coverage.visited++;
            if (!p || !p.slot.outcome.ok) { venue.coverage.failed++; continue; }
            const [, , token0, token1, , , , liquidity, , , owed0, owed1] = p.slot.outcome.value;
            if (liquidity === 0n && owed0 === 0n && owed1 === 0n) venue.coverage.measured++;
            else live.push({ id: p.id, token0, token1 });
          }
          async function collect(part: typeof live): Promise<void> {
            const calls = part.flatMap((p) => [balanceCall(p.token0), balanceCall(p.token1), {
              target: m.address, allowFailure: false,
              callData: encodeFunctionData({ abi: uniPositionAbi, functionName: 'collect', args: [{ tokenId: p.id, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }] }),
            }, balanceCall(p.token0), balanceCall(p.token1)]);
            try {
              const decoded = await walletSimulation(calls, (result) => {
                return part.map((_, i) => {
                  const at = i * 5;
                  const quoted = decodeFunctionResult({ abi: uniPositionAbi, functionName: 'collect', data: result[at + 2]!.returnData });
                  const actual = [balance(result[at + 3]!.returnData) - balance(result[at]!.returnData), balance(result[at + 4]!.returnData) - balance(result[at + 1]!.returnData)] as const;
                  if (actual.some((a, k) => a < 0n || a > quoted[k]!)) throw new Error('Unexpected collect balance delta');
                  return actual;
                });
              });
              decoded.forEach(([a, b], i) => {
                const p = part[i]!;
                addFoundAmount(venue, p.token0, a); addFoundAmount(venue, p.token1, b);
                const amounts = [{ token: address(p.token0), raw: String(a) }, { token: address(p.token1), raw: String(b) }].filter((x) => x.raw !== '0');
                if (amounts.length) venue.claims.push({ contract: m.address, tokenId: String(p.id), amounts });
              });
              venue.coverage.measured += part.length;
            } catch {
              // Isolate one bad position or token; it must not erase its neighbours' readings.
              if (part.length > 1) for (const p of part) await collect([p]);
              else venue.coverage.failed++;
            }
          }
          for (const part of chunks(live, 8)) await collect(part);
          publish();
        }
      }
      finish(venue);
    }

    function finish(v: FoundVenue) {
      if (v.coverage.failed) issue(v, 'Some contract reads or simulations failed; those amounts are not measured.');
      v.state = v.issues.length === 0 && v.coverage.total !== null && v.coverage.measured === v.coverage.total ? 'complete' : 'partial';
      publish();
    }

    try { await readManagers(uni, [{ address: FOUND.uniswapV3, aero: false }]); }
    catch { issue(uni, 'The check stopped before every NFT was measured.'); finish(uni); }

    try {
      const discovery = new Batch();
      const registry = discovery.add(FOUND.voter, foundDiscoveryAbi, 'factoryRegistry', []);
      const factoriesSlot = discovery.add(FOUND.factoryRegistry, foundDiscoveryAbi, 'poolFactories', []);
      const countSlot = discovery.add(FOUND.voter, foundDiscoveryAbi, 'length', []);
      await run(discovery);
      const factories = valueOf(factoriesSlot);
      if (!registry.outcome.ok || !same(registry.outcome.value, FOUND.factoryRegistry) || !factories || factories.length > 32) throw new Error('Factory registry unread or changed');
      if (!countSlot.outcome.ok || countSlot.outcome.value > BigInt(MAX_GAUGES)) throw new Error('Gauge index unread or capped');
      const count = Number(countSlot.outcome.value);
      report.discovery.voterPools = count;
      const signature = factories.map((f) => f.toLowerCase()).sort().join(',');
      let catalog: Gauge[];
      if (index && index.block <= block && index.count === count && index.signature === signature && block - index.block < 150n) catalog = index.entries;
      else {
        catalog = [];
        for (let offset = 0; offset < count; offset += 80) {
          const b = new Batch();
          const pools = Array.from({ length: Math.min(80, count - offset) }, (_, i) => b.add(FOUND.voter, foundDiscoveryAbi, 'pools', [BigInt(offset + i)]));
          await run(b);
          const lookup = new Batch();
          const details = pools.map((p) => p.outcome.ok ? { gauge: lookup.add(FOUND.voter, foundDiscoveryAbi, 'gauges', [p.outcome.value]), factory: lookup.add(p.outcome.value, foundDiscoveryAbi, 'factory', []) } : null);
          await run(lookup);
          for (const d of details) {
            if (!d || !d.gauge.outcome.ok || same(d.gauge.outcome.value, ZERO)) continue;
            catalog.push({ address: d.gauge.outcome.value, factory: d.factory.outcome.ok ? d.factory.outcome.value : null });
          }
          publish();
        }
        if (catalog.length === count) index = { block, count, signature, entries: catalog };
      }
      // Removed factories can still have wallet-owned NFTs and live gauges. Read the union of
      // today's registry and every historical factory in Voter's append-only pool index.
      const allFactories = new Map(factories.map((f) => [f.toLowerCase(), f]));
      for (const g of catalog) if (g.factory) allFactories.set(g.factory.toLowerCase(), g.factory);
      if (allFactories.size > 32) throw new Error('Factory safety limit');
      const plans = new Batch();
      const factoryPlans = [...allFactories.values()].map((f) => ({ f, slot: plans.add(FOUND.factoryRegistry, foundDiscoveryAbi, 'factoriesToPoolFactory', [f]) }));
      await run(plans);
      const managers: Manager[] = [];
      const clFactories = new Set<string>();
      let complete = catalog.length === count && catalog.every((g) => g.factory !== null);
      for (const { f, slot } of factoryPlans) {
        if (same(f, V2_FACTORY)) continue;
        if (!slot.outcome.ok) { complete = false; continue; }
        const b = new Batch();
        const nft = b.add(slot.outcome.value[1], foundDiscoveryAbi, 'nft', []);
        const fee = b.add(f, foundDiscoveryAbi, 'tickSpacingToFee', [200]);
        await run(b);
        if (!nft.outcome.ok || same(nft.outcome.value, ZERO) || !fee.outcome.ok) { complete = false; continue; }
        const verify = new Batch();
        const managerFactory = verify.add(nft.outcome.value, uniPositionAbi, 'factory', []);
        await run(verify);
        if (!managerFactory.outcome.ok || !same(managerFactory.outcome.value, f)) { complete = false; continue; }
        clFactories.add(f.toLowerCase());
        const managerAddress = nft.outcome.value;
        if (!managers.some((m) => same(m.address, managerAddress))) managers.push({ address: managerAddress, aero: true });
      }
      report.discovery.nftManagers = managers.length;
      const gauges = [...new Map(catalog.filter((g) => g.factory !== null && clFactories.has(g.factory.toLowerCase())).map((g) => [g.address.toLowerCase(), g])).values()];
      report.discovery.classifiedPools = catalog.filter((g) => g.factory !== null && (same(g.factory, V2_FACTORY) || clFactories.has(g.factory.toLowerCase()))).length;
      report.discovery.unidentifiedPools = count - report.discovery.classifiedPools;
      try { await readManagers(aero, managers, complete); }
      catch { issue(aero, 'The check stopped before every NFT was measured.'); finish(aero); }

      rewards.state = 'reading';
      if (!complete || report.discovery.unidentifiedPools) issue(rewards, 'Not every Voter pool or factory could be identified; the full CL gauge count is unknown.');
      // Incomplete discovery cannot turn a measured subset into a full denominator.
      rewards.coverage.total = rewards.issues.length ? null : gauges.length;
      let staked = 0;
      for (const part of chunks(gauges, 40)) {
        const b = new Batch();
        const plans = part.map((g) => ({ g, count: b.add(g.address, foundDiscoveryAbi, 'stakedLength', [owner]), voter: b.add(g.address, foundDiscoveryAbi, 'voter', []), token: b.add(g.address, foundDiscoveryAbi, 'rewardToken', []) }));
        await run(b);
        for (const plan of plans) {
          checkBudget();
          rewards.coverage.visited++;
          if (!plan.count.outcome.ok || !plan.voter.outcome.ok || !same(plan.voter.outcome.value, FOUND.voter) || !plan.token.outcome.ok || !same(plan.token.outcome.value, FOUND.aero)) { rewards.coverage.failed++; continue; }
          const n = plan.count.outcome.value;
          if (n > BigInt(MAX_NFTS)) { rewards.coverage.failed++; issue(rewards, 'A gauge exceeds the per-account NFT safety limit.'); continue; }
          staked += Number(n);
          if (n === 0n) { rewards.coverage.measured++; continue; }
          try {
            // The code of the code-owned Multicall3 becomes an observation lens at the wallet
            // only inside eth_call. Voter and gauge code/storage stay real. claimRewards sees
            // the wallet as sender, and AERO balance deltas include actual payout penalties.
            const payout = await walletSimulation([balanceCall(FOUND.aero), { target: FOUND.voter, allowFailure: false, callData: encodeFunctionData({ abi: foundDiscoveryAbi, functionName: 'claimRewards', args: [[plan.g.address]] }) }, balanceCall(FOUND.aero)], (result) => {
              const before = balance(result[0]!.returnData);
              const after = balance(result[2]!.returnData);
              if (after < before) throw new Error('Payout negative');
              return after - before;
            });
            addFoundAmount(rewards, FOUND.aero, payout);
            if (payout > 0n) rewards.claims.push({ contract: plan.g.address, tokenId: null, amounts: [{ token: address(FOUND.aero), raw: String(payout) }] });
            rewards.coverage.measured++;
          } catch { rewards.coverage.failed++; }
        }
        publish();
      }
      rewards.positions = rewards.coverage.failed === 0 && rewards.coverage.total !== null ? staked : null;
      finish(rewards);
    } catch {
      for (const v of [aero, rewards]) if (v.state !== 'complete') { issue(v, 'Aerodrome discovery or reads did not finish; nothing concluded for the missing part.'); finish(v); }
    }

    const amounts = new Map<string, bigint>();
    for (const v of report.venues) for (const a of v.amounts) amounts.set(a.token, (amounts.get(a.token) ?? 0n) + BigInt(a.raw));
    report.tokens = [...amounts].map(([token, raw]) => ({ token, raw: String(raw), symbol: null, decimals: null, valueCents: null, quote: null }));
    for (const part of chunks(report.tokens, 40)) {
      try {
        const b = new Batch();
        const plans = part.map((t) => ({ t, symbol: b.add(address(t.token), foundTokenAbi, 'symbol', []), decimals: b.add(address(t.token), foundTokenAbi, 'decimals', []) }));
        await run(b);
        for (const { t, symbol, decimals } of plans) {
          if (symbol.outcome.ok && /^[A-Za-z0-9._ -]{1,32}$/.test(symbol.outcome.value)) t.symbol = symbol.outcome.value;
          if (decimals.outcome.ok) t.decimals = decimals.outcome.value;
        }
      } catch { /* Exact raw amounts survive an unavailable token metadata read. */ }
    }
    await priceFoundTokens(report.tokens, options.fetcher, now(), Math.min(10_000, Math.max(0, (options.budgetMs ?? 180_000) - (performance.now() - started))));
    const complete = report.venues.every((v) => v.state === 'complete');
    const priced = report.tokens.filter((t) => t.valueCents !== null);
    report.valueCents = priced.length || (complete && report.tokens.length === 0) ? sumFoundCents(priced).toString() : null;
    report.valueComplete = complete && priced.length === report.tokens.length;
    report.state = complete ? 'complete' : 'partial';
    report.reading.assembledAt = now().toISOString();
    publish();
    return report;
  };
}
