// Code-owned registry: the contracts and assets Still reads on Base mainnet. Addresses enter the
// product only from here, from the chain or from the person's own words.
//
// Checked on chain on 2026-10-25 around block 53,074,895:
// - the Aave V4 "Coinbase Stocks" spoke and hub, found through Aave's GraphQL API and confirmed
//   by the spoke's own getters; the reserve list is still read from the spoke on every load;
// - the oracle address, from the spoke's ORACLE();
// - Morpho Blue market ids; their parameters are immutable and re-read and checked on every load;
// - each stock token's name, ISIN and decimals, from the B20 token's own name(),
//   extraMetadata("isin") and decimals().

import type { Address, Hex } from 'viem';

export const BASE_CHAIN_ID = 8453;

export const ADDRESSES = {
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  weth: '0x4200000000000000000000000000000000000006',
  cbbtc: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  aaveSpoke: '0x17905Db0e4A3514467539956c084180616AE7B8D',
  aaveHub: '0xa4d5947Eb727A052bae69C593FfC84247EC9864E',
  aaveOracle: '0xaBaf048fD7675Ea34a84332371ffd5D55E322A47',
  morpho: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  // Coinbase's tokenized-stock registry: answers 0xd4197e82(token) with (multiplierWad, paused).
  // It has no published ABI; the multiplier word was matched against each token's multiplier().
  coinbaseStockRegistry: '0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD',
  // Primary names on Base (ENSIP-19 reverse registrar, and Basenames' own resolver for names set
  // before it). Both answered "jesse.base.eth" for its address on 2026-10-25.
  ensL2ReverseRegistrar: '0x0000000000D8e504002cC26E3Ec46D81971C1664',
  basenamesL2Resolver: '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD',
} as const satisfies Record<string, Address>;

export type StockId = 'AAPLc' | 'AMZNc' | 'GOOGLc' | 'METAc' | 'MSFTc' | 'NVDAc' | 'TSLAc';
export type CryptoId = 'cbBTC' | 'ETH';
export type AssetId = StockId | CryptoId;

export interface StockAsset {
  readonly kind: 'stock';
  readonly id: StockId;
  readonly token: Address;
  readonly decimals: number;
  /** What people call it. */
  readonly name: string;
  /** The token's own name(). */
  readonly legalName: string;
  /** The share's exchange ticker. */
  readonly ticker: string;
  readonly isin: string;
}

export interface CryptoAsset {
  readonly kind: 'crypto';
  readonly id: CryptoId;
  readonly token: Address;
  readonly decimals: number;
  readonly name: string;
  /** The token people hold: cbBTC, or ETH counted together with WETH. */
  readonly symbol: string;
  readonly morphoMarket: Hex;
  /** Native ETH counts too: the same signature can wrap it into WETH. */
  readonly includesNativeEth: boolean;
}

export type Asset = StockAsset | CryptoAsset;

export const STOCKS: readonly StockAsset[] = [
  { kind: 'stock', id: 'AAPLc', token: '0xb200000000000000000000C2e324d24d7eEcd1fb', decimals: 8, name: 'Apple', legalName: 'Apple Inc.', ticker: 'AAPL', isin: 'US0378331005' },
  { kind: 'stock', id: 'AMZNc', token: '0xb200000000000000000000d9192b6B456483C2E8', decimals: 8, name: 'Amazon', legalName: 'Amazon.com Inc.', ticker: 'AMZN', isin: 'US0231351067' },
  { kind: 'stock', id: 'GOOGLc', token: '0xb2000000000000000000002D0BA3164cc74f58B7', decimals: 8, name: 'Alphabet', legalName: 'Alphabet Inc.', ticker: 'GOOGL', isin: 'US02079K3059' },
  { kind: 'stock', id: 'METAc', token: '0xb2000000000000000000008bC8786B856E61707C', decimals: 8, name: 'Meta', legalName: 'Meta Platforms Inc.', ticker: 'META', isin: 'US30303M1027' },
  { kind: 'stock', id: 'MSFTc', token: '0xB200000000000000000000Ab99cFa739E253872B', decimals: 8, name: 'Microsoft', legalName: 'Microsoft Corporation', ticker: 'MSFT', isin: 'US5949181045' },
  { kind: 'stock', id: 'NVDAc', token: '0xb20000000000000000000078ee7ce2fE4908108C', decimals: 8, name: 'NVIDIA', legalName: 'NVIDIA Corporation', ticker: 'NVDA', isin: 'US67066G1040' },
  { kind: 'stock', id: 'TSLAc', token: '0xb2000000000000000000001e800a7f5189430cD0', decimals: 8, name: 'Tesla', legalName: 'Tesla Inc.', ticker: 'TSLA', isin: 'US88160R1014' },
];

export const CRYPTO: readonly CryptoAsset[] = [
  {
    kind: 'crypto',
    id: 'cbBTC',
    token: ADDRESSES.cbbtc,
    decimals: 8,
    name: 'Bitcoin',
    symbol: 'cbBTC',
    morphoMarket: '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836',
    includesNativeEth: false,
  },
  {
    kind: 'crypto',
    id: 'ETH',
    token: ADDRESSES.weth,
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
    morphoMarket: '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda',
    includesNativeEth: true,
  },
];

export const ASSETS: readonly Asset[] = [...STOCKS, ...CRYPTO];

export function stockByToken(token: Address): StockAsset | undefined {
  const key = token.toLowerCase();
  return STOCKS.find((s) => s.token.toLowerCase() === key);
}

export function assetById(id: AssetId): Asset {
  const asset = ASSETS.find((a) => a.id === id);
  if (!asset) throw new Error(`unknown asset ${id}`);
  return asset;
}
