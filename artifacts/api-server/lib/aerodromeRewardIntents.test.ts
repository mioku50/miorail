import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aerodromeRewardAlertReplyV1,
  aerodromeRewardAlertV1,
  aerodromeRewardThresholdCentsV1,
  aerodromeRewardsReadV1,
  centsV1,
  foundProtocolsNamedV1,
  foundReadV1,
  uniswapCollectOrderV1,
  uniswapFeesReadV1,
} from './aerodromeRewardIntents.js';

test('a question about my own Aerodrome rewards is a reading, in English and Russian', () => {
  for (const message of [
    'Check my Aerodrome rewards',
    'What can I claim on Aerodrome?',
    'Show my unclaimed Aerodrome fees',
    'How much have I earned on Aerodrome',
    'do I have any AERO rewards to claim?',
    'Покажи мои награды Aerodrome',
    'Сколько я могу забрать в Aerodrome?',
    'проверь мои комиссии на аэродроме',
  ]) assert.equal(aerodromeRewardsReadV1(message), true, message);
});

test('an order to collect, a pool question or an alert is not a reading', () => {
  for (const message of [
    'Claim my Aerodrome fees',
    'Collect my AERO rewards on Aerodrome',
    'Забери мои комиссии Aerodrome',
    'Show the WETH/USDC Aerodrome pool and its liquidity',
    'Show the fees of the WETH/USDC pool on Aerodrome',
    'Notify me when my Aerodrome rewards reach $5',
    'Check my Uniswap rewards',
  ]) assert.equal(aerodromeRewardsReadV1(message), false, message);
});

test('an alert names its amount, or takes $5; stopping one needs the word for alerts', () => {
  assert.deepEqual(aerodromeRewardAlertV1('Notify me when my Aerodrome rewards reach $5'), { kind: 'on', thresholdUsdCents: 500 });
  assert.deepEqual(aerodromeRewardAlertV1('Tell me when my Aerodrome fees pass 20 USD'), { kind: 'on', thresholdUsdCents: 2_000 });
  assert.deepEqual(aerodromeRewardAlertV1('Alert me about my Aerodrome rewards'), { kind: 'on', thresholdUsdCents: 500 });
  assert.deepEqual(aerodromeRewardAlertV1('Сообщи, когда награды Aerodrome дойдут до $12,50'), { kind: 'on', thresholdUsdCents: 1_250 });
  assert.deepEqual(aerodromeRewardAlertV1('Напомни, когда комиссии Aerodrome будут 7 долларов'), { kind: 'on', thresholdUsdCents: 700 });
  assert.deepEqual(aerodromeRewardAlertV1('Stop Aerodrome reward alerts'), { kind: 'off' });
  assert.deepEqual(aerodromeRewardAlertV1('Turn off my Aerodrome rewards notifications'), { kind: 'off' });
  assert.deepEqual(aerodromeRewardAlertV1('Отключи уведомления о наградах Aerodrome'), { kind: 'off' });
  assert.deepEqual(aerodromeRewardAlertV1('Notify me when my Aerodrome rewards reach $0.50'), { kind: 'invalid', reason: 'below_min' });
  assert.deepEqual(aerodromeRewardAlertV1('Notify me when my Aerodrome rewards reach $20000'), { kind: 'invalid', reason: 'above_max' });
  for (const message of ['Claim my Aerodrome fees', 'Check my Aerodrome rewards', 'Stop the Aerodrome swap', 'Notify me when my Morpho rewards reach $5']) {
    assert.equal(aerodromeRewardAlertV1(message), null, message);
  }
});

test('an amount is read from the words around it, as whole cents', () => {
  assert.equal(aerodromeRewardThresholdCentsV1('reach $5'), 500);
  assert.equal(aerodromeRewardThresholdCentsV1('reach 5$'), 500);
  assert.equal(aerodromeRewardThresholdCentsV1('reach $ 5.5'), 550);
  assert.equal(aerodromeRewardThresholdCentsV1('reach 5,25 usdc'), 525);
  assert.equal(aerodromeRewardThresholdCentsV1('дойдут до 30 баксов'), 3_000);
  assert.equal(aerodromeRewardThresholdCentsV1('reach five dollars'), null);
  assert.equal(aerodromeRewardThresholdCentsV1('reach 5'), null, 'a bare number is not a dollar amount');
});

test('the alert replies say what was kept and where it is told', () => {
  assert.equal(centsV1(500), '$5');
  assert.equal(centsV1(1_250), '$12.50');
  assert.equal(centsV1(125_000), '$1,250');
  const created = aerodromeRewardAlertReplyV1({ outcome: 'created', thresholdUsdCents: 500, telegram: false, russian: false });
  assert.match(created, /^Done\.\nWhen what this wallet can claim on Aerodrome and Uniswap reaches \$5, Miorail tells you once/);
  assert.match(created, /Telegram is not connected to this wallet yet: Settings → Telegram\.$/);
  assert.doesNotMatch(aerodromeRewardAlertReplyV1({ outcome: 'created', thresholdUsdCents: 500, telegram: true, russian: false }), /not connected/);
  assert.doesNotMatch(aerodromeRewardAlertReplyV1({ outcome: 'created', thresholdUsdCents: 500, telegram: null, russian: false }), /not connected/);
  assert.match(aerodromeRewardAlertReplyV1({ outcome: 'moved', thresholdUsdCents: 2_000, russian: false }), /^Moved to \$20\./);
  assert.match(aerodromeRewardAlertReplyV1({ outcome: 'unchanged', thresholdUsdCents: 500, russian: true }), /^Уже включено: порог \$5\./);
  assert.equal(aerodromeRewardAlertReplyV1({ outcome: 'stopped', russian: false }), 'Reward alerts are off for this wallet.');
  assert.equal(aerodromeRewardAlertReplyV1({ outcome: 'none', russian: true }), 'Для этого кошелька уведомлений о наградах не было.');
  assert.match(aerodromeRewardAlertReplyV1({ outcome: 'below_min', russian: false }), /smallest amount is \$1/);
});

test('Uniswap fees: a question reads v3, an order collects, v4 is neither', () => {
  for (const message of ['Check my Uniswap fees', 'How much can I collect on Uniswap?', 'Show my unclaimed Uniswap fees', 'Сколько я могу забрать на Uniswap?']) {
    assert.equal(uniswapFeesReadV1(message), true, message);
  }
  for (const message of ['Collect my Uniswap fees', 'Show fees for my Uniswap V4 liquidity positions', 'Swap 100 USDC on Uniswap', 'Notify me when my Uniswap fees reach $5']) {
    assert.equal(uniswapFeesReadV1(message), false, message);
  }
  assert.equal(uniswapCollectOrderV1('Collect my Uniswap fees'), true);
  assert.equal(uniswapCollectOrderV1('Забери мои комиссии Uniswap'), true);
  assert.equal(uniswapCollectOrderV1('Collect my Uniswap v4 fees'), false);
  assert.equal(uniswapCollectOrderV1('Check my Uniswap fees'), false);
});

test('Found with no protocol named: my rewards, what I can claim; never swap fees or another protocol', () => {
  for (const message of ['What can I claim?', 'Check my rewards', 'Do I have unclaimed fees?', 'Show my fees', 'Что я могу забрать?', 'Проверь мои награды', 'Есть ли у меня несобранные комиссии?']) {
    assert.equal(foundReadV1(message), true, message);
  }
  for (const message of ['What fees will I pay to swap?', 'Check my Moonwell rewards', 'Claim my rewards', 'Notify me when my rewards reach $5', 'What does my wallet hold?']) {
    assert.equal(foundReadV1(message), false, message);
  }
  assert.deepEqual(foundProtocolsNamedV1('What can I claim on Aerodrome and Uniswap?'), ['aerodrome', 'uniswap']);
  assert.deepEqual(foundProtocolsNamedV1('What can I claim?'), []);
  // One alert covers both, by any of their names or none.
  assert.deepEqual(aerodromeRewardAlertV1('Notify me when my rewards reach $5'), { kind: 'on', thresholdUsdCents: 500 });
  assert.deepEqual(aerodromeRewardAlertV1('Tell me when my Uniswap fees reach 10 USD'), { kind: 'on', thresholdUsdCents: 1_000 });
  assert.deepEqual(aerodromeRewardAlertV1('Сообщи, когда мои награды дойдут до $5'), { kind: 'on', thresholdUsdCents: 500 });
  assert.deepEqual(aerodromeRewardAlertV1('Stop reward alerts'), { kind: 'off' });
});
