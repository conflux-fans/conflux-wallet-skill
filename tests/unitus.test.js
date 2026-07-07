import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zeroAddress } from 'viem';

import { CONTROLLER_ABI, ITOKEN_ABI, LENDING_DATA_ABI, ORACLE_ABI } from '../src/lib/unitus/abis.js';
import { getUnitusConfig, validateUnitusConfig } from '../src/lib/unitus/config.js';
import { discoverMarkets, getPosition, previewAction } from '../src/lib/unitus/read.js';
import { buildUnitusTransactions } from '../src/lib/unitus/write.js';

function fn(abi, name) {
  return abi.find((item) => item.type === 'function' && item.name === name);
}

const ONE_DOLLAR_PRICE_FOR_6_DECIMALS = 1000000000000000000000000000000n;

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
    assert.ok(fn(ORACLE_ABI, 'getUnderlyingPriceAndStatus'));
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
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDT',
      decimals: 6,
      cash: '1000000000',
      marketParams: {
        collateralFactor: 800000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            1000000000000000000000n,
            1000000000000000000000n,
            200000000000000000000n,
            5000000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [500000000n, 1000000000n, 300000000n, 250000000n, 225000000n, 123n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [120000000n, 300000000n, 270000000n, 900000000n, 120000000n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[market.iToken], [1250000000n], [6], [market.iToken], [200000000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [market.iToken];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
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
    assert.notEqual(withdraw.adequacyRatioAfter, null);
    assert.equal(borrow.resolvedAmount, '270');
    assert.equal(borrow.safeMaxBorrow, '270');
    assert.notEqual(borrow.adequacyRatioAfter, null);
    assert.equal(repay.resolvedAmount, '120');
    assert.equal(repay.maxRepay, '120');
  });

  it('allows withdraw preview when after-operation adequacy ratio remains healthy', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDT',
      decimals: 6,
      cash: '1000000000',
      marketParams: {
        collateralFactor: 800000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            1000000000000000000000n,
            1000000000000000000000n,
            400000000000000000000n,
            2500000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [500000000n, 1000000000n, 300000000n, 250000000n, 225000000n, 123n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [120000000n, 300000000n, 270000000n, 900000000n, 120000000n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[market.iToken], [1250000000n], [6], [market.iToken], [400000000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [market.iToken];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'withdraw',
      asset: 'USDT',
      amount: '100',
    });

    assert.equal(preview.adequacyRatioAfter, '2.3');
    assert.equal(preview.willSucceed, true);
    assert.deepEqual(preview.warnings, []);
  });

  it('blocks withdraw preview when requested amount exceeds safe max', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDT',
      decimals: 6,
      cash: '1000000000',
      marketParams: {
        collateralFactor: 800000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            1000000000000000000000n,
            1000000000000000000000n,
            400000000000000000000n,
            2500000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [500000000n, 1000000000n, 300000000n, 250000000n, 225000000n, 123n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [120000000n, 300000000n, 270000000n, 900000000n, 120000000n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[market.iToken], [1250000000n], [6], [market.iToken], [400000000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [market.iToken];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'withdraw',
      asset: 'USDT',
      amount: '226',
    });

    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings[0], /exceeds safe max withdraw/);
  });

  it('allows borrow preview when after-operation adequacy ratio remains healthy', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDC',
      decimals: 6,
      cash: '1000000000',
      marketParams: {
        collateralFactor: 800000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            1000000000000000000000n,
            1000000000000000000000n,
            400000000000000000000n,
            2500000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 300000000n, 250000000n, 225000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 300000000n, 270000000n, 900000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[market.iToken], [1250000000n], [6], [market.iToken], [400000000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [market.iToken];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'borrow',
      asset: 'USDC',
      amount: '100',
    });

    assert.equal(preview.adequacyRatioAfter, '2');
    assert.equal(preview.willSucceed, true);
    assert.deepEqual(preview.warnings, []);
  });

  it('uses collateral factors from supplied assets for borrow after-ratio', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const iCfx = '0x00000000000000000000000000000000000000c1';
    const iUsdt0 = '0x00000000000000000000000000000000000000d1';
    const markets = [
      {
        iToken: iCfx,
        iTokenSymbol: 'iCFX',
        underlying: zeroAddress,
        symbol: 'CFX',
        decimals: 18,
        cash: '1000000000000000000000',
        marketParams: {
          collateralFactor: 700000000000000000n,
          borrowFactor: 1000000000000000000n,
        },
      },
      {
        iToken: iUsdt0,
        iTokenSymbol: 'iUSDT0',
        underlying: '0x00000000000000000000000000000000000000e1',
        symbol: 'USDT0',
        decimals: 6,
        cash: '1000000000',
        marketParams: {
          collateralFactor: 850000000000000000n,
          borrowFactor: 1000000000000000000n,
        },
      },
    ];
    const client = {
      async readContract({ address, functionName, args }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            40000000000000000n,
            40000000000000000n,
            0n,
            0n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 300000000n, 250000000n, 225000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 300000000n, 270000000n, 900000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[iCfx], [1000000000000000000n], [18], [], [], []];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [iCfx];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          if (args[0] === iCfx) return [40000000000000000n, true];
          if (args[0] === iUsdt0) return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, markets, wallet, {
      action: 'borrow',
      asset: 'USDT0',
      amount: '0.028',
    });

    assert.equal(preview.adequacyRatioAfter, '1');
    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings.join('\n'), /adequacyRatioAfter must remain greater than 1/);
  });

  it('divides existing and new borrow values by borrow factor for after-ratio', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const iCfx = '0x00000000000000000000000000000000000000c1';
    const iUsdt0 = '0x00000000000000000000000000000000000000d1';
    const markets = [
      {
        iToken: iCfx,
        iTokenSymbol: 'iCFX',
        underlying: zeroAddress,
        symbol: 'CFX',
        decimals: 18,
        cash: '1000000000000000000000',
        marketParams: {
          collateralFactor: 700000000000000000n,
          borrowFactor: 1000000000000000000n,
        },
      },
      {
        iToken: iUsdt0,
        iTokenSymbol: 'iUSDT0',
        underlying: '0x00000000000000000000000000000000000000e1',
        symbol: 'USDT0',
        decimals: 6,
        cash: '1000000000',
        marketParams: {
          collateralFactor: 850000000000000000n,
          borrowFactor: 700000000000000000n,
        },
      },
    ];
    const client = {
      async readContract({ address, functionName, args }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            40000000000000000n,
            40000000000000000n,
            7000000000000000n,
            4000000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 300000000n, 250000000n, 225000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [7000n, 300000000n, 270000000n, 900000000n, 7000n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[iCfx], [1000000000000000000n], [18], [iUsdt0], [7000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [iCfx];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          if (args[0] === iCfx) return [40000000000000000n, true];
          if (args[0] === iUsdt0) return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, markets, wallet, {
      action: 'borrow',
      asset: 'USDT0',
      amount: '0.007',
    });

    assert.equal(preview.adequacyRatioAfter, '1.4');
    assert.equal(preview.willSucceed, true);
    assert.deepEqual(preview.warnings, []);
  });

  it('blocks borrow preview when requested amount exceeds pool cash', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDC',
      decimals: 6,
      cash: '50000000',
      marketParams: {
        collateralFactor: 800000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            1000000000000000000000n,
            1000000000000000000000n,
            400000000000000000000n,
            2500000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 300000000n, 250000000n, 225000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 300000000n, 270000000n, 900000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[market.iToken], [1250000000n], [6], [market.iToken], [400000000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [market.iToken];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'borrow',
      asset: 'USDC',
      amount: '100',
    });

    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings[0], /exceeds pool cash/);
  });

  it('blocks borrow preview when the oracle price is unavailable', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDC',
      decimals: 6,
      cash: '1000000000',
      marketParams: {
        collateralFactor: 800000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            1000000000000000000000n,
            1000000000000000000000n,
            400000000000000000000n,
            2500000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 300000000n, 250000000n, 225000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 300000000n, 270000000n, 900000000n, 0n, 6];
        }
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') return [0n, false];
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'borrow',
      asset: 'USDC',
      amount: '100',
    });

    assert.equal(preview.adequacyRatioAfter, null);
    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings.join('\n'), /underlying price is unavailable/);
  });

  it('blocks write previews when the resolved amount is zero', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDT0',
      decimals: 6,
      cash: '1000000000',
      marketParams: {
        collateralFactor: 850000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') return [0n, 0n, 0n, 0n];
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 0n, 0n, 0n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 0n, 0n, 1000000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[], [], [], [], [], []];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'withdraw',
      asset: 'USDT0',
      amount: 'max',
    });

    assert.equal(preview.resolvedAmount, '0');
    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings.join('\n'), /resolved amount must be greater than zero/);
  });

  it('resolves supply max to the max supply amount', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDT0',
      decimals: 6,
      marketParams: {
        collateralFactor: 850000000000000000n,
        borrowFactor: 1000000000000000000n,
        mintPaused: false,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') return [0n, 0n, 0n, 0n];
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 61974n, 0n, 0n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') return [0n, 0n, 0n, 1000000000n, 0n, 6];
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'supply',
      asset: 'USDT0',
      amount: 'max',
    });

    assert.equal(preview.resolvedAmount, '0.061974');
    assert.equal(preview.maxSupply, '0.061974');
    assert.equal(preview.willSucceed, true);
  });

  it('blocks native supply max when it would spend the full gas token balance', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const market = {
      iToken: '0x00000000000000000000000000000000000000c1',
      iTokenSymbol: 'iCFX',
      underlying: zeroAddress,
      symbol: 'CFX',
      decimals: 18,
      native: true,
      marketParams: {
        collateralFactor: 700000000000000000n,
        borrowFactor: 1000000000000000000n,
        mintPaused: false,
      },
    };
    const client = {
      async getBalance({ address }) {
        assert.equal(address, wallet);
        return 1000000000000000000n;
      },
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') return [0n, 0n, 0n, 0n];
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000000000000n, 1000000000000000000n, 0n, 0n, 0n, 18];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') return [0n, 0n, 0n, 1000000000000000000n, 0n, 18];
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'supply',
      asset: 'CFX',
      amount: 'max',
    });

    assert.equal(preview.resolvedAmount, '1');
    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings.join('\n'), /native supply amount must leave balance for gas/);
  });

  it('blocks previews for paused market actions', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDT0',
      decimals: 6,
      cash: '1000000000',
      marketParams: {
        collateralFactor: 850000000000000000n,
        borrowFactor: 1000000000000000000n,
        mintPaused: true,
        redeemPaused: true,
        borrowPaused: true,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [1000000000000000000000n, 1000000000000000000000n, 0n, 0n];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [500000000n, 1000000000n, 300000000n, 250000000n, 225000000n, 123n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 300000000n, 270000000n, 900000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[market.iToken], [1250000000n], [6], [], [], []];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [market.iToken];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const supply = await previewAction(client, config, [market], wallet, {
      action: 'supply',
      asset: 'USDT0',
      amount: '1',
    });
    const withdraw = await previewAction(client, config, [market], wallet, {
      action: 'withdraw',
      asset: 'USDT0',
      amount: '1',
    });
    const borrow = await previewAction(client, config, [market], wallet, {
      action: 'borrow',
      asset: 'USDT0',
      amount: '1',
    });

    assert.equal(supply.willSucceed, false);
    assert.match(supply.warnings.join('\n'), /mint is paused/);
    assert.equal(withdraw.willSucceed, false);
    assert.match(withdraw.warnings.join('\n'), /redeem is paused/);
    assert.equal(borrow.willSucceed, false);
    assert.match(borrow.warnings.join('\n'), /borrow is paused/);
  });

  it('does not reduce adjusted collateral when withdrawing a non-collateral zero-factor asset', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const iCfx = '0x00000000000000000000000000000000000000c1';
    const iAxCnh = '0x00000000000000000000000000000000000000d1';
    const markets = [
      {
        iToken: iCfx,
        iTokenSymbol: 'iCFX',
        underlying: zeroAddress,
        symbol: 'CFX',
        decimals: 18,
        cash: '1000000000000000000000',
        marketParams: {
          collateralFactor: 700000000000000000n,
          borrowFactor: 1000000000000000000n,
        },
      },
      {
        iToken: iAxCnh,
        iTokenSymbol: 'iAxCNH',
        underlying: '0x00000000000000000000000000000000000000e1',
        symbol: 'AxCNH',
        decimals: 6,
        cash: '1000000000',
        marketParams: {
          collateralFactor: 0n,
          borrowFactor: 1000000000000000000n,
          redeemPaused: false,
        },
      },
    ];
    const client = {
      async readContract({ address, functionName, args }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [0n, 0n, 10000000000000000000n, 2800000000000000000n];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [100000000n, 1000000000n, 300000000n, 250000000n, 225000000n, 123n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 0n, 0n, 1000000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[iCfx, iAxCnh], [1000000000000000000n, 100000000n], [18, 6], [iAxCnh], [10000000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [iCfx];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          if (args[0] === iCfx) return [40000000000000000000n, true];
          if (args[0] === iAxCnh) return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, markets, wallet, {
      action: 'withdraw',
      asset: 'AxCNH',
      amount: '1',
    });

    assert.equal(preview.adequacyRatioAfter, '2.8');
    assert.equal(preview.willSucceed, true);
    assert.deepEqual(preview.warnings, []);
  });

  it('blocks borrow preview when market cash is unavailable', async () => {
    const config = getUnitusConfig('conflux');
    const wallet = '0x0000000000000000000000000000000000000abc';
    const oracle = '0x00000000000000000000000000000000000000f1';
    const market = {
      iToken: '0x00000000000000000000000000000000000000d1',
      symbol: 'USDC',
      decimals: 6,
      marketParams: {
        collateralFactor: 800000000000000000n,
        borrowFactor: 1000000000000000000n,
      },
    };
    const client = {
      async readContract({ address, functionName }) {
        if (address === config.lendingData && functionName === 'getAccountTotalValue') {
          return [
            1000000000000000000000n,
            1000000000000000000000n,
            400000000000000000000n,
            2500000000000000000n,
          ];
        }
        if (address === config.lendingData && functionName === 'getAccountSupplyData') {
          return [0n, 1000000000n, 300000000n, 250000000n, 225000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountBorrowData') {
          return [0n, 300000000n, 270000000n, 900000000n, 0n, 6];
        }
        if (address === config.lendingData && functionName === 'getAccountTokens') {
          return [[market.iToken], [1250000000n], [6], [market.iToken], [400000000n], [6]];
        }
        if (address === config.controller && functionName === 'getEnteredMarkets') return [market.iToken];
        if (address === config.controller && functionName === 'priceOracle') return oracle;
        if (address === oracle && functionName === 'getUnderlyingPriceAndStatus') {
          return [ONE_DOLLAR_PRICE_FOR_6_DECIMALS, true];
        }
        throw new Error(`unexpected call ${address}.${functionName}`);
      },
    };

    const preview = await previewAction(client, config, [market], wallet, {
      action: 'borrow',
      asset: 'USDC',
      amount: '100',
    });

    assert.equal(preview.willSucceed, false);
    assert.match(preview.warnings.join('\n'), /market cash is unavailable/);
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
