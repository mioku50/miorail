/**
 * Reviewed Base MCP provider intents.
 *
 * The Markdown plugin specs are documentation, not runtime authority. This
 * registry is the code-owned bridge between a user phrase and the Miorail
 * surface that is allowed to handle it. Adding an example here makes the
 * phrase understood; it does not silently promote the provider's lifecycle
 * stage or grant calldata execution.
 */

export type BaseMcpProviderLifecycleStageV1 =
  | 'documented'
  | 'manifested'
  | 'adapter'
  | 'scored'
  | 'proven';

export type BaseMcpProviderExampleSurfaceV1 =
  | 'read'
  | 'action'
  | 'routable';

export type BaseMcpProviderExampleDispositionV1 =
  | 'read_in_extensions'
  | 'handoff_to_routes'
  | 'handoff_to_provider_ui'
  | 'typed_x402_required'
  | 'adapter_required';

export interface BaseMcpProviderExampleV1 {
  id: string;
  prompt: string;
  surface: BaseMcpProviderExampleSurfaceV1;
  disposition: BaseMcpProviderExampleDispositionV1;
}

export interface BaseMcpProviderIntentSpecV1 {
  pluginId: string;
  aliases: readonly string[];
  /** Product owner chosen explicitly in the architecture map. */
  productSurface: 'routes' | 'extensions';
  lifecycleStage: BaseMcpProviderLifecycleStageV1;
  examples: readonly BaseMcpProviderExampleV1[];
}

const e = (
  id: string,
  prompt: string,
  surface: BaseMcpProviderExampleSurfaceV1,
  disposition: BaseMcpProviderExampleDispositionV1,
): BaseMcpProviderExampleV1 => ({ id, prompt, surface, disposition });

/**
 * Example prompts are adapted from the pinned Base plugin specifications.
 * Their disposition records current Miorail capability truth.
 */
export const BASE_MCP_PROVIDER_INTENTS_V1: readonly BaseMcpProviderIntentSpecV1[] = [
  {
    pluginId: 'aerodrome', aliases: ['aerodrome', 'aero'], productSurface: 'routes', lifecycleStage: 'manifested', examples: [
      e('swap', 'Swap 0.001 ETH to USDC on Aerodrome', 'routable', 'handoff_to_routes'),
      e('buy', 'Buy AERO with 1 USDC on Aerodrome', 'routable', 'handoff_to_routes'),
      e('liquidity', 'Show the WETH/USDC Aerodrome pool and its liquidity', 'read', 'read_in_extensions'),
      e('claim', 'Claim my Aerodrome fees', 'action', 'adapter_required'),
    ],
  },
  {
    pluginId: 'avantis', aliases: ['avantis', 'perps', 'perpetuals'], productSurface: 'extensions', lifecycleStage: 'manifested', examples: [
      e('open', 'Open a 10x long BTC/USD with 100 USDC on Avantis', 'action', 'handoff_to_provider_ui'),
      e('positions', 'Show my open Avantis positions and PnL', 'read', 'read_in_extensions'),
      e('close', 'Close my BTC long on Avantis', 'action', 'handoff_to_provider_ui'),
      e('tp', 'Set take profit at 80000 on my Avantis ETH position', 'action', 'handoff_to_provider_ui'),
    ],
  },
  {
    pluginId: 'balancer', aliases: ['balancer'], productSurface: 'routes', lifecycleStage: 'manifested', examples: [
      e('swap', 'Swap 100 USDC for WETH on Base through Balancer', 'routable', 'handoff_to_routes'),
      e('yield', 'Show the best Balancer pool for ETH yield on Base', 'routable', 'handoff_to_routes'),
      e('liquidity', 'Add 500 USDC and 0.2 WETH liquidity on Balancer', 'routable', 'handoff_to_routes'),
    ],
  },
  {
    pluginId: 'bankr', aliases: ['bankr'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('latest', 'Show the latest Bankr launches on Base', 'read', 'read_in_extensions'),
      e('inspect', 'Inspect this Bankr token address on Base', 'read', 'read_in_extensions'),
      e('buy', 'Buy the newest Bankr launch with 0.001 ETH', 'routable', 'handoff_to_routes'),
    ],
  },
  {
    pluginId: 'bitrefill', aliases: ['bitrefill', 'gift card', 'esim'], productSurface: 'routes', lifecycleStage: 'scored', examples: [
      e('browse', 'Browse Bitrefill gift cards available in the United States', 'read', 'read_in_extensions'),
      e('amazon', 'Find a 25 USD Amazon US gift card on Bitrefill', 'routable', 'handoff_to_routes'),
      e('checkout', 'Buy the selected Bitrefill gift card with USDC on Base', 'action', 'adapter_required'),
    ],
  },
  {
    pluginId: 'brickken', aliases: ['brickken', 'erc-8004', 'erc8004'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('register', 'Register my agent on Base with Brickken', 'action', 'typed_x402_required'),
      e('wallet', 'Set my Base wallet as the Brickken agent wallet', 'action', 'typed_x402_required'),
      e('transfer', 'Send my Brickken agent NFT to my Base wallet', 'action', 'typed_x402_required'),
    ],
  },
  {
    pluginId: 'clawnch', aliases: ['clawnch'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('latest', 'Show the latest Clawnch launches', 'read', 'read_in_extensions'),
      e('volume', 'Show top Clawnch tokens on Base by volume', 'read', 'read_in_extensions'),
      e('launch', 'Launch Cool Project with symbol COOL on Clawnch', 'action', 'adapter_required'),
    ],
  },
  {
    pluginId: 'flaunch', aliases: ['flaunch'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('latest', 'Show the newest Flaunch coins on Base', 'read', 'read_in_extensions'),
      e('buy', 'Buy this Flaunch token with 0.001 ETH', 'routable', 'handoff_to_routes'),
      e('launch', 'Launch a memecoin on Flaunch', 'action', 'adapter_required'),
    ],
  },
  {
    pluginId: 'gmgn', aliases: ['gmgn', 'gmgh'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('market', 'Show GMGN market intelligence for this Base token', 'read', 'read_in_extensions'),
      e('quote', 'Get a GMGN quote to swap 10 USDC for this Base token', 'routable', 'handoff_to_routes'),
    ],
  },
  {
    pluginId: 'hydrex', aliases: ['hydrex'], productSurface: 'routes', lifecycleStage: 'manifested', examples: [
      e('swap', 'Swap 5 USDC to ETH on Hydrex', 'routable', 'handoff_to_routes'),
      e('positions', 'Show my Hydrex liquidity positions', 'routable', 'handoff_to_routes'),
      e('liquidity', 'Add 100 USDC and 0.04 ETH liquidity on Hydrex', 'routable', 'handoff_to_routes'),
    ],
  },
  {
    pluginId: 'kyberswap', aliases: ['kyberswap', 'kyber'], productSurface: 'routes', lifecycleStage: 'proven', examples: [
      e('swap', 'Compare a 100 USDC to ETH route using KyberSwap on Base', 'routable', 'handoff_to_routes'),
      e('quote', 'Get a KyberSwap quote for 0.01 ETH to USDC on Base', 'routable', 'handoff_to_routes'),
    ],
  },
  {
    pluginId: 'moonwell', aliases: ['moonwell'], productSurface: 'routes', lifecycleStage: 'proven', examples: [
      e('markets', 'Show Moonwell USDC supply markets on Base', 'read', 'read_in_extensions'),
      e('supply', 'Supply 100 USDC on Moonwell', 'routable', 'handoff_to_routes'),
      e('borrow', 'Borrow USDC against my collateral on Moonwell', 'routable', 'handoff_to_routes'),
      e('health', 'Check my Moonwell positions and health factor', 'read', 'read_in_extensions'),
    ],
  },
  {
    pluginId: 'morpho', aliases: ['morpho'], productSurface: 'routes', lifecycleStage: 'proven', examples: [
      e('vaults', 'Show the best USDC Morpho vaults on Base', 'routable', 'handoff_to_routes'),
      e('deposit', 'Deposit 100 USDC into a Morpho vault on Base', 'routable', 'handoff_to_routes'),
      e('positions', 'Show my Morpho positions on Base', 'read', 'read_in_extensions'),
      e('health', 'Check my Morpho borrow health on Base', 'read', 'read_in_extensions'),
    ],
  },
  {
    pluginId: 'o1-exchange', aliases: ['o1.exchange', 'o1 exchange'], productSurface: 'routes', lifecycleStage: 'manifested', examples: [
      e('quote', 'Get an o1.exchange quote for 10 USDC to ETH on Base', 'routable', 'handoff_to_routes'),
      e('swap', 'Swap 10 USDC to ETH with o1.exchange on Base', 'routable', 'handoff_to_routes'),
    ],
  },
  {
    pluginId: 'opensea', aliases: ['opensea', 'open sea', 'nft'], productSurface: 'routes', lifecycleStage: 'documented', examples: [
      e('drops', 'Show upcoming NFT drops on Base from OpenSea', 'read', 'read_in_extensions'),
      e('listing', 'Show the best current listing for this NFT on OpenSea', 'read', 'read_in_extensions'),
      e('buy', 'Buy this NFT on OpenSea', 'routable', 'handoff_to_routes'),
    ],
  },
  {
    pluginId: 'printr', aliases: ['printr'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('cost', 'Show the Printr launch cost for Base and Arbitrum', 'read', 'read_in_extensions'),
      e('status', 'Show my Printr deployment status on all chains', 'read', 'read_in_extensions'),
      e('launch', 'Launch a token named Deep Supply with symbol DSUP on Base using Printr', 'action', 'adapter_required'),
    ],
  },
  {
    pluginId: 'uniswap', aliases: ['uniswap', 'uni v4', 'uniswap v4'], productSurface: 'routes', lifecycleStage: 'proven', examples: [
      e('swap', 'Swap 100 USDC to ETH with Uniswap on Base', 'routable', 'handoff_to_routes'),
      e('create-lp', 'Create a Uniswap V4 liquidity position on Base', 'action', 'adapter_required'),
      e('fees', 'Show fees for my Uniswap V4 liquidity positions on Base', 'read', 'read_in_extensions'),
    ],
  },
  {
    pluginId: 'venice', aliases: ['venice', 'venice ai'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('models', 'Show the models available from Venice AI', 'read', 'read_in_extensions'),
      e('private', 'Privately summarize this text with Venice AI', 'action', 'adapter_required'),
      e('top-up', 'Top up my Venice x402 balance with 5 USDC on Base', 'action', 'typed_x402_required'),
    ],
  },
  {
    pluginId: 'virtuals', aliases: ['virtuals', 'virtuals protocol'], productSurface: 'extensions', lifecycleStage: 'documented', examples: [
      e('agents', 'List my Virtuals agents', 'read', 'read_in_extensions'),
      e('create', 'Create a Virtuals agent with email and card', 'action', 'adapter_required'),
      e('otp', 'Check my Virtuals email OTP status', 'read', 'read_in_extensions'),
    ],
  },
  {
    pluginId: 'yo', aliases: ['yo protocol', 'yo vault', 'yield optimizer'], productSurface: 'routes', lifecycleStage: 'manifested', examples: [
      e('vaults', 'Show YO Protocol vaults on Base', 'routable', 'handoff_to_routes'),
      e('position', 'Show my YO Protocol position on Base', 'routable', 'handoff_to_routes'),
      e('deposit', 'Deposit 100 USDC into a YO vault on Base', 'routable', 'handoff_to_routes'),
      e('withdraw', 'Withdraw my YO vault position on Base', 'routable', 'handoff_to_routes'),
    ],
  },
] as const;

export const BASE_MCP_PROVIDER_INTENTS_BY_ID_V1: Readonly<Record<string, BaseMcpProviderIntentSpecV1>> =
  Object.freeze(Object.fromEntries(BASE_MCP_PROVIDER_INTENTS_V1.map((entry) => [entry.pluginId, entry])));
