import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zeroAddress } from 'viem';

import { CONTROLLER_ABI, ITOKEN_ABI, LENDING_DATA_ABI } from '../src/lib/unitus/abis.js';
import { getUnitusConfig, validateUnitusConfig } from '../src/lib/unitus/config.js';
import { discoverMarkets, getPosition, previewAction } from '../src/lib/unitus/read.js';
import { buildUnitusTransactions } from '../src/lib/unitus/write.js';

function fn(abi, name) {
  return abi.find((item) => item.type === 'function' && item.name === name);
}

describe('Unitus config', () => {
  it('uses env overrides for the minimum bootstrap addresses', () => {
    const env = {
      UNITUS_CONFLUX_CONTROLLER: '0x0000000000000000000000000000000000000101',
      UNITUS_CONFLUX_LENDING_DATA: '0x0000000000000000000000000000000000000202',
    };

    const config = getUnitusConfig('conflux', { env });

    assert.equal(config.chain, 'conflux');
    assert.equal(config.chainId, 1030);
    assert.equal(config.controller, env.UNITUS_CONFLUX_CONTROLLER);
    assert.equal(config.lendingData, env.UNITUS_CONFLUX_LENDING_DATA);
    assert.equal(config.source, 'env');
    assert.equal(Object.hasOwn(config, 'markets'), false);
  });

  it('rejects a LendingData contract for a different controller', async () => {
    const config = getUnitusConfig('conflux');
    const client = {
      async readContract({ address, functionName }) {
        assert.equal(address, config.lendingData);
        assert.equal(functionName, 'controller');
        return '0x0000000000000000000000000000000000000999';
      },
    };

    await assert.rejects(
      validateUnitusConfig(client, config),
      /LendingData controller mismatch/,
    );
  });
});

describe('Unitus ABI', () => {
  it('contains the minimum functions needed for dynamic discovery', () => {
    assert.ok(fn(CONTROLLER_ABI, 'getAlliTokens'));
    assert.ok(fn(CONTROLLER_ABI, 'markets'));
    assert.ok(fn(CONTROLLER_ABI, 'priceOracle'));
    assert.ok(fn(CONTROLLER_ABI, 'rewardDistributor'));
    assert.ok(fn(ITOKEN_ABI, 'underlying'));
    assert.ok(fn(ITOKEN_ABI, 'symbol'));
    assert.ok(fn(LENDING_DATA_ABI, 'getAccountSupplyData'));
    assert.ok(fn(LENDING_DATA_ABI, 'controller'));
  });
});

describe('Unitus market discovery', () => {
  it('discovers markets from the controller and treats zero-address underlying as native CFX', async () => {
    const config = getUnitusConfig('conflux');
    const iCfx = '0x00000000000000000000000000000000000000c1';
    const iUsdt = '0x00000000000000000000000000000000000000d1';
    const usdt = '0x00000000000000000000000000000000000000e1';
    const calls = [];
    const client = {
      async readContract({ address, functionName }) {
        calls.push({ address, functionName });
        if (address === config.controller && functionName === 'getAlliTokens') return [iCfx, iUsdt];
        if (address === config.controller && functionName === 'markets') return [1n, 2n, 3n, 4n, true, false, false];
        if (address === config.controller && functionName === 'priceOracle') return '0x00000000000000000000000000000000000000f1';
        if (address === config.controller && functionName === 'rewardDistributor') return '0x00000000000000000000000000000000000000f2';
        if (address === iCfx && functionName === 'symbol') return 'iCFX';
        if (address === iCfx && functionName === 'decimals') return 18;
        if (address === iCfx && functionName === 'underlying') return zeroAddress;
        if (address === iCfx && functionName === 'getCash') return 10n;
        if (address === iUsdt && functionName === 'symbol') return 'iUSDT';
        if (address === iUsdt && functionName === 'decimals') return 18;
        if (address === iUsdt && functionName === 'underlying') return usdt;
        if (address === iUsdt && functionName === 'getCash') return 20n;
        if (address === usdt && functionName === 'symbol') return 'USDT';
        if (address === usdt && functionName === 'decimals') return 6;
        if (address === usdt && functionName === 'name') return 'Tether USD';
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const result = await discoverMarkets(client, config);

    assert.equal(result.markets.length, 2);
    assert.equal(result.markets[0].symbol, 'CFX');
    assert.equal(result.markets[0].native, true);
    assert.equal(result.markets[0].underlying, zeroAddress);
    assert.equal(result.markets[1].symbol, 'USDT');
    assert.equal(result.markets[1].underlyingSymbol, 'USDT');
    assert.equal(result.priceOracle, '0x00000000000000000000000000000000000000f1');
    assert.equal(result.rewardDistributor, '0x00000000000000000000000000000000000000f2');
    assert.equal(calls.some((call) => call.address === zeroAddress), false);
  });
});

describe('Unitus position and preview', () => {
  it('maps LendingData token arrays into supply and borrow positions', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const iUsdt = '0x00000000000000000000000000000000000000d1';
    const iUsdc = '0x00000000000000000000000000000000000000d2';
    const markets = [
      { iToken: iUsdt, symbol: 'USDT', decimals: 6, iTokenSymbol: 'iUSDT' },
      { iToken: iUsdc, symbol: 'USDC', decimals: 6, iTokenSymbol: 'iUSDC' },
    ];
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [1000n, 1000n, 200n, 1850000000000000000n];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[iUsdt], [1000000000n], [6], [iUsdc], [200000000n], [6]];
        }
        if (address === config.controller && functionName === 'calcAccountEquity') {
          return [800n, 0n, 1000n, 200n];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [iUsdt];
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const position = await getPosition(client, config, markets, wallet);

    assert.equal(position.adequacyRatio, '1.85');
    assert.equal(position.isHealthy, true);
    assert.equal(position.shortfallUsd, '0');
    assert.deepEqual(position.supplies, [
      { symbol: 'USDT', amount: '1000', asCollateral: true, iToken: iUsdt },
    ]);
    assert.deepEqual(position.borrows, [
      { symbol: 'USDC', amount: '200', iToken: iUsdc },
    ]);
  });

  it('treats an empty no-shortfall account as healthy even when adequacy ratio is zero', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') return [0n, 0n, 0n, 0n];
        if (address === config.lendingData && functionName === 'getAccountTokens') return [[], [], [], [], [], []];
        if (address === config.controller && functionName === 'calcAccountEquity') return [0n, 0n, 0n, 0n];
        if (address === config.controller && functionName === 'getEnteredMarkets') return [];
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const position = await getPosition(client, config, [], wallet);

    assert.equal(position.isHealthy, true);
  });

  it('uses safe max indexes for withdraw, borrow, and repay previews', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const market = { iToken: '0x00000000000000000000000000000000000000d1', symbol: 'USDT', decimals: 6 };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [1000n, 1000n, 200n, 1850000000000000000n];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [500000000n, 1000000000n, 300000000n, 250000000n, 225000000n, 123n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [120000000n, 300000000n, 270000000n, 900000000n, 120000000n, 6];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const withdraw = await previewAction(client, config, [market], wallet, {
      action: 'withdraw',
      asset: 'USDT',
      amount: 'max',
    });
    const borrow = await previewAction(client, config, [market], wallet, {
      action: 'borrow',
      asset: 'USDT',
      amount: 'max',
    });
    const repay = await previewAction(client, config, [market], wallet, {
      action: 'repay',
      asset: 'USDT',
      amount: 'max',
    });

    assert.equal(withdraw.resolvedAmount, '225');
    assert.equal(withdraw.safeMaxWithdraw, '225');
    assert.equal(borrow.resolvedAmount, '270');
    assert.equal(borrow.safeMaxBorrow, '270');
    assert.equal(repay.resolvedAmount, '120');
    assert.equal(repay.maxRepay, '120');
  });

  it('marks supply preview as unsafe when requested amount exceeds max supply', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const market = { iToken: '0x00000000000000000000000000000000000000d1', symbol: 'USDT0', decimals: 6 };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') return [0n, 0n, 0n, 0n];
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000n, 61974n, 0n, 0n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') return [0n, 0n, 0n, 1000000n, 0n, 6];
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'supply',
      asset: 'USDT0',
      amount: '1',
    });

    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings[0], /exceeds max supply/);
  });
});

describe('Unitus transaction planning', () => {
  it('plans ERC20 supply as approve followed by mintForSelfAndEnterMarket', () => {
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      underlying: '0x00000000000000000000000000000000000000e1',
      symbol: 'USDT',
      decimals: 6,
      native: false,
    };

    const txs = buildUnitusTransactions({
      action: 'supply',
      market,
      amount: '12.5',
      collateral: true,
      user: '0x0000000000000000000000000000000000000abc',
    });

    assert.equal(txs.length, 2);
    assert.equal(txs[0].description, 'Approve USDT for Unitus iToken');
    assert.equal(txs[0].address, market.underlying);
    assert.equal(txs[0].functionName, 'approve');
    assert.deepEqual(txs[0].args, [market.iToken, 12500000n]);
    assert.equal(txs[1].address, market.iToken);
    assert.equal(txs[1].functionName, 'mintForSelfAndEnterMarket');
    assert.deepEqual(txs[1].args, [12500000n]);
  });

  it('plans native CFX repay as payable repayBorrow without approval', () => {
    const market = {
      iToken: '0x00000000000000000000000000000000000000c1',
      underlying: zeroAddress,
      symbol: 'CFX',
      decimals: 18,
      native: true,
    };

    const txs = buildUnitusTransactions({
      action: 'repay',
      market,
      amount: '1.25',
      user: '0x0000000000000000000000000000000000000abc',
    });

    assert.equal(txs.length, 1);
    assert.equal(txs[0].address, market.iToken);
    assert.equal(txs[0].functionName, 'repayBorrow');
    assert.deepEqual(txs[0].args, []);
    assert.equal(txs[0].value, 1250000000000000000n);
  });
});
