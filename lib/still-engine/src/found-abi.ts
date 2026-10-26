// Public protocol interfaces; no signing or transaction submission.
import { parseAbi } from 'viem';

export const FOUND = {
  uniswapV3: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
  voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
  factoryRegistry: '0x5C3F18F06CC09CA1910767A34a20F771039E37C0',
  aero: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
} as const;

const common = [
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address,uint256) view returns (uint256)',
  'function factory() view returns (address)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)',
  'function multicall(bytes[]) payable returns (bytes[])',
] as const;
export const uniPositionAbi = parseAbi([...common,
  'function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
]);
export const aeroPositionAbi = parseAbi([...common,
  'function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
]);
export const foundDiscoveryAbi = parseAbi([
  'function factoryRegistry() view returns (address)',
  'function poolFactories() view returns (address[])',
  'function factoriesToPoolFactory(address) view returns (address,address)',
  'function nft() view returns (address)',
  'function tickSpacingToFee(int24) view returns (uint24)',
  'function length() view returns (uint256)',
  'function pools(uint256) view returns (address)',
  'function gauges(address) view returns (address)',
  'function factory() view returns (address)',
  'function voter() view returns (address)',
  'function rewardToken() view returns (address)',
  'function stakedLength(address) view returns (uint256)',
  'function claimRewards(address[])',
]);
export const foundTokenAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
export const foundAggregateAbi = parseAbi([
  'function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])',
]);
