// ABI fragments for the calls Still makes. Aave V4 shapes are taken from the verified spoke
// implementation (SpokeInstance 0x81a73c28…3b19, Sourcify, 2026-10-25) and the oracle
// (0xaBaf048f…2A47); the hub implementation is not verified anywhere we looked, so only its
// scalar getters and SpokeConfig (same layout in every published IHub) are used.

import { parseAbi } from 'viem';

export const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);

export const multicall3Abi = parseAbi([
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function getCurrentBlockTimestamp() view returns (uint256 timestamp)',
  'function getBlockNumber() view returns (uint256 blockNumber)',
]);

export const aaveSpokeAbi = parseAbi([
  'function ORACLE() view returns (address)',
  'function getReserveCount() view returns (uint256)',
  'function getReserve(uint256 reserveId) view returns ((address underlying, address hub, uint16 assetId, uint8 decimals, uint24 collateralRisk, uint8 flags, uint32 dynamicConfigKey))',
  'function getReserveConfig(uint256 reserveId) view returns ((uint24 collateralRisk, bool paused, bool frozen, bool borrowable, bool receiveSharesEnabled))',
  'function getDynamicReserveConfig(uint256 reserveId, uint32 dynamicConfigKey) view returns ((uint16 collateralFactor, uint32 maxLiquidationBonus, uint16 liquidationFee))',
  'function getUserReserveStatus(uint256 reserveId, address user) view returns (bool usingAsCollateral, bool borrowing)',
  'function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)',
  'function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)',
  'function getUserPosition(uint256 reserveId, address user) view returns ((uint120 drawnShares, uint120 premiumShares, int200 premiumOffsetRay, uint120 suppliedShares, uint32 dynamicConfigKey))',
  'function getUserAccountData(address user) view returns ((uint256 riskPremium, uint256 avgCollateralFactor, uint256 healthFactor, uint256 totalCollateralValue, uint256 totalDebtValueRay, uint256 activeCollateralCount, uint256 borrowCount))',
]);

export const aaveOracleAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function getReservePrice(uint256 reserveId) view returns (uint256)',
  'function getReserveSource(uint256 reserveId) view returns (address)',
]);

export const aaveHubAbi = parseAbi([
  'function getAssetLiquidity(uint256 assetId) view returns (uint256)',
  'function getAssetDrawnRate(uint256 assetId) view returns (uint256)',
  'function getSpokeConfig(uint256 assetId, address spoke) view returns ((uint40 addCap, uint40 drawCap, uint24 riskPremiumThreshold, bool active, bool halted))',
  'function getSpokeAddedAssets(uint256 assetId, address spoke) view returns (uint256)',
  'function getSpokeTotalOwed(uint256 assetId, address spoke) view returns (uint256)',
  'function MAX_ALLOWED_SPOKE_CAP() view returns (uint40)',
]);

export const chainlinkFeedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export const morphoAbi = parseAbi([
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
]);

export const morphoOracleAbi = parseAbi(['function price() view returns (uint256)']);

export const morphoIrmAbi = parseAbi([
  'function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)',
]);

// Raw selector of the Coinbase registry getter (see registry.ts). Decoded by hand.
export const COINBASE_REGISTRY_SELECTOR = '0xd4197e82';
