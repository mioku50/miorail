// Centralized chain-mode constants derived from VITE_CHAIN_ENV. Replaces the
// same `import.meta.env.VITE_CHAIN_ENV === 'mainnet-readonly'` recomputation
// that was duplicated across six components. F3 will upgrade parts of this to
// be driven by useStatus() (honest runtime state) instead of the build-time env.
export const CHAIN_ENV: string = import.meta.env.VITE_CHAIN_ENV || 'sepolia';
export const isMainnetReadonly: boolean = CHAIN_ENV === 'mainnet-readonly';
export const expectedChainId: number = CHAIN_ENV === 'sepolia' ? 84532 : 8453;
export const explorerBaseUrl: string = isMainnetReadonly ? 'https://basescan.org' : 'https://sepolia.basescan.org';
