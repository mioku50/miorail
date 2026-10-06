// Run with node --import tsx: fixtures pass through the actual quote pipeline.
import { GmgnQuoteRouteAdapter } from '../../../../lib/swap-adapters/src/gmgn.ts';
import { makeIntent, WALLET } from '../../../../lib/swap-adapters/test/fixtures.ts';
import { createSwapRouteEngine } from '../../../../lib/route-engine/src/engine.ts';
import { buildRouteCardV1, buildRoutePlanProjectionV1 } from '../../../../lib/route-card/src/builders.ts';

const now = new Date();
const intent = makeIntent({ to: 'WETH', protocolConstraint: { mode: 'include_only', protocols: ['gmgn'] } });
const results = [];
for (const status of [200, 403, 429]) {
  const adapter = new GmgnQuoteRouteAdapter({ fetchImpl: async () => new globalThis.Response(JSON.stringify({ code: 0, data: {
    input_token: intent.fromAsset.address, output_token: intent.toAsset.address, input_amount: intent.amount.amountAtomic,
    output_amount: '38000000000000000', min_output_amount: '38000000000000000', slippage: 0,
    tx: { chain_id: 8453, from_address: WALLET, input_token_address: intent.fromAsset.address,
      output_token_address: intent.toAsset.address, amount_in: intent.amount.amountAtomic, amount_out: '38000000000000000',
      amount_min_out: '38000000000000000', amount_in_decimals: 6, amount_out_decimals: 18, slippage: 0,
      deadline: Math.floor(now.getTime() / 1000) + 60 },
  } }), { status }) });
  const evaluation = await createSwapRouteEngine().evaluate({ intent, walletAddress: WALLET, requestId: 'gmgn-browser', now, adapters: [adapter] });
  const routeCard = buildRouteCardV1(evaluation);
  const projection = buildRoutePlanProjectionV1(evaluation, { routeCard, routeRunId: intent.id });
  results.push({ outcome: 'evaluated', routeRunId: intent.id, intent, evaluation, routeCard, projection });
}
process.stdout.write(JSON.stringify(results));
