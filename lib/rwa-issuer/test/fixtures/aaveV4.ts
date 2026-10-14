import { AAVE_V4_BASE_HUB_V1, AAVE_V4_BASE_SPOKE_V1, AAVE_V4_BASE_USDC_V1 } from '../../src/aaveV4.js';
export const STOCK = '0xb20000000000000000000078ee7ce2fe4908108c';
export const USER = '0x1111111111111111111111111111111111111111';
export const SPOKE_ID = 'test-base-mag7-spoke';
const figure = (value: string) => ({ value });
const amount = (tokens: string, usd = tokens) => ({ amount: figure(tokens), exchange: figure(usd) });
export function reservesFixtureV1() {
  return [STOCK, AAVE_V4_BASE_USDC_V1].map((address, index) => ({
    id: `test-reserve-${index}`, chain: { chainId: 8453 },
    spoke: { id: SPOKE_ID, address: AAVE_V4_BASE_SPOKE_V1, chain: { chainId: 8453 } },
    asset: { underlying: { address, info: { symbol: index === 0 ? 'NVDAc' : 'USDC', decimals: index === 0 ? 8 : 6 } }, hub: { address: AAVE_V4_BASE_HUB_V1, chain: { chainId: 8453 } } },
    canSupply: true, canBorrow: index === 1, canUseAsCollateral: index === 0,
    status: { active: true, frozen: false, paused: false },
    settings: { collateral: index === 0, borrowable: index === 1, suppliable: true,
      collateralFactor: figure(index === 0 ? '0.7' : '0'), maxLiquidationBonus: figure('0.055'), liquidationFee: figure('0.1'), collateralRisk: figure('0'), supplyCap: amount('1000'), borrowCap: amount(index === 0 ? '0' : '2000') },
    summary: { supplied: amount('100', index === 0 ? '22000' : '100'), borrowed: amount(index === 0 ? '0' : '25'), suppliable: amount('900'), borrowable: amount(index === 0 ? '0' : '75'), supplyApy: figure(index === 0 ? '0' : '0.0123'), borrowApy: figure(index === 0 ? '0' : '0.023456') },
  }));
}
export function positionFixtureV1() {
  return {
    user: USER, spoke: { id: SPOKE_ID, address: AAVE_V4_BASE_SPOKE_V1, chain: { chainId: 8453 } },
    totalCollateral: { current: figure('2000') }, totalDebt: { current: figure('500') },
    netAccruedInterest: figure('-0.125'), netBorrowApy: { current: figure('0.0333') },
    healthFactor: { current: '2.8' }, remainingBorrowingPower: figure('900'),
  };
}
