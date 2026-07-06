import { formatUnits, getAddress, parseUnits, zeroAddress } from 'viem';
import { CONTROLLER_ABI, ERC20_ABI, ITOKEN_ABI, ORACLE_ABI } from './abis.js';
import { LENDING_DATA_ABI } from './abis.js';
import { sameAddress } from './config.js';
import { resolveMarket } from './resolve.js';

const MARKET_PARAM_NAMES = [
  'collateralFactor',
  'borrowFactor',
  'borrowCapacity',
  'supplyCapacity',
  'mintPaused',
  'redeemPaused',
  'borrowPaused',
];

const EXP_SCALE = 1000000000000000000n;

function normalizeSymbol(symbol) {
  if (symbol === 'iCFX') return 'CFX';
  return symbol.startsWith('i') ? symbol.slice(1) : symbol;
}

function mapMarketParams(params) {
  return Object.fromEntries(MARKET_PARAM_NAMES.map((name, index) => [name, params[index]]));
}

async function readUnderlyingMetadata(client, underlying) {
  const [symbol, decimals, name] = await Promise.all([
    client.readContract({ address: underlying, abi: ERC20_ABI, functionName: 'symbol' }),
    client.readContract({ address: underlying, abi: ERC20_ABI, functionName: 'decimals' }),
    client.readContract({ address: underlying, abi: ERC20_ABI, functionName: 'name' }),
  ]);
  return { symbol, decimals: Number(decimals), name };
}

async function discoverMarket(client, config, iToken) {
  const [iTokenSymbol, iTokenDecimals, underlying, cash, rawParams] = await Promise.all([
    client.readContract({ address: iToken, abi: ITOKEN_ABI, functionName: 'symbol' }),
    client.readContract({ address: iToken, abi: ITOKEN_ABI, functionName: 'decimals' }),
    client.readContract({ address: iToken, abi: ITOKEN_ABI, functionName: 'underlying' }),
    client.readContract({ address: iToken, abi: ITOKEN_ABI, functionName: 'getCash' }),
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'markets',
      args: [iToken],
    }),
  ]);

  const native = sameAddress(underlying, zeroAddress);
  const underlyingMetadata = native
    ? { symbol: config.chain === 'conflux' ? 'CFX' : normalizeSymbol(iTokenSymbol), decimals: Number(iTokenDecimals), name: 'Native CFX' }
    : await readUnderlyingMetadata(client, underlying);

  return {
    source: 'chain',
    iToken: getAddress(iToken),
    iTokenSymbol,
    iTokenDecimals: Number(iTokenDecimals),
    symbol: underlyingMetadata.symbol ?? normalizeSymbol(iTokenSymbol),
    underlying: getAddress(underlying),
    underlyingSymbol: underlyingMetadata.symbol,
    underlyingName: underlyingMetadata.name,
    decimals: underlyingMetadata.decimals,
    native,
    cash: cash.toString(),
    marketParams: mapMarketParams(rawParams),
  };
}

export async function discoverMarkets(client, config) {
  const [iTokens, priceOracle, rewardDistributor] = await Promise.all([
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'getAlliTokens',
    }),
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'priceOracle',
    }),
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'rewardDistributor',
    }),
  ]);

  if (iTokens.length === 0) {
    throw new Error('Unitus controller returned no markets');
  }

  const markets = [];
  for (const iToken of iTokens) {
    markets.push(await discoverMarket(client, config, iToken));
  }

  return {
    chain: config.chain,
    pool: config.pool,
    controller: config.controller,
    lendingData: config.lendingData,
    priceOracle,
    rewardDistributor,
    marketCount: markets.length,
    markets,
  };
}

export function formatTokenAmount(amount, decimals) {
  return formatUnits(BigInt(amount), decimals);
}

function findMarketByIToken(markets, iToken) {
  return markets.find((market) => sameAddress(market.iToken, iToken)) ?? {
    iToken,
    symbol: iToken,
    decimals: 18,
  };
}

function formatRatio(ratio) {
  if (ratio === 'Infinity') return ratio;
  const ratioText = formatUnits(BigInt(ratio), 18);
  return Number(ratioText).toString();
}

function mapTokenPositions(tokens, amounts, decimals, markets, extra = () => ({})) {
  return tokens.map((iToken, index) => {
    const market = findMarketByIToken(markets, iToken);
    return {
      symbol: market.symbol,
      amount: formatTokenAmount(amounts[index], Number(decimals[index])),
      ...extra(iToken),
      iToken,
    };
  });
}

export async function getPosition(client, config, markets, address) {
  const [totalValue, tokenData, equityData, enteredMarkets] = await Promise.all([
    client.readContract({
      address: config.lendingData,
      abi: LENDING_DATA_ABI,
      functionName: 'getAccountTotalValue',
      args: [address],
    }),
    client.readContract({
      address: config.lendingData,
      abi: LENDING_DATA_ABI,
      functionName: 'getAccountTokens',
      args: [address],
    }),
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'calcAccountEquity',
      args: [address],
    }),
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'getEnteredMarkets',
      args: [address],
    }),
  ]);

  const [supplyTokens, supplyAmounts, supplyDecimals, borrowTokens, borrowAmounts, borrowDecimals] = tokenData;
  const shortfall = equityData[1];
  const adequacyRatio = totalValue[3];

  return {
    success: true,
    chain: config.chain,
    protocol: 'unitus',
    address,
    adequacyRatio: formatRatio(adequacyRatio),
    isHealthy: BigInt(shortfall) === 0n && (borrowTokens.length === 0 || BigInt(adequacyRatio) > 1000000000000000000n),
    shortfallUsd: formatUnits(BigInt(shortfall), 18),
    marketCount: markets.length,
    supplies: mapTokenPositions(
      supplyTokens,
      supplyAmounts,
      supplyDecimals,
      markets,
      (iToken) => ({ asCollateral: enteredMarkets.some((entered) => sameAddress(entered, iToken)) }),
    ),
    borrows: mapTokenPositions(borrowTokens, borrowAmounts, borrowDecimals, markets),
  };
}

function parseSafetyFactor(safety = 0.9) {
  return BigInt(Math.round(Number(safety) * 1e6)) * 1000000000000n;
}

async function readAccountTotalValue(client, config, address) {
  const [supplyValue, collateralValue, borrowValue, adequacyRatio] = await client.readContract({
    address: config.lendingData,
    abi: LENDING_DATA_ABI,
    functionName: 'getAccountTotalValue',
    args: [address],
  });
  return {
    supplyValue: BigInt(supplyValue),
    collateralValue: BigInt(collateralValue),
    borrowValue: BigInt(borrowValue),
    adequacyRatio: BigInt(adequacyRatio),
  };
}

function selectPreviewAmount(action, amount, supplyData, borrowData, decimals) {
  const requestedAmount = amount === 'max' ? amount : parseUnits(String(amount), decimals);
  if (action === 'withdraw') {
    const safeAvailableToWithdraw = supplyData[4];
    return {
      resolvedAmount: amount === 'max' ? safeAvailableToWithdraw : requestedAmount,
      maxWithdraw: supplyData[3],
      safeMaxWithdraw: safeAvailableToWithdraw,
      poolCash: undefined,
    };
  }
  if (action === 'borrow') {
    const safeAvailableToBorrow = borrowData[2];
    return {
      resolvedAmount: amount === 'max' ? safeAvailableToBorrow : requestedAmount,
      maxBorrow: borrowData[1],
      safeMaxBorrow: safeAvailableToBorrow,
    };
  }
  if (action === 'repay') {
    const maxRepay = borrowData[4];
    return {
      resolvedAmount: amount === 'max' ? maxRepay : requestedAmount,
      maxRepay,
    };
  }
  if (action === 'supply') {
    return {
      resolvedAmount: requestedAmount,
      maxSupply: supplyData[2],
    };
  }
  throw new Error(`Unsupported Unitus preview action: ${action}`);
}

function formatPreviewFields(fields, decimals) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => {
      if (typeof value === 'bigint') return [key, formatTokenAmount(value, decimals)];
      return [key, value];
    }),
  );
}

function marketParam(market, name) {
  const value = market.marketParams?.[name];
  return value === undefined ? null : BigInt(value);
}

function tokenValue(amount, price, _decimals) {
  return (amount * price) / EXP_SCALE;
}

function weightedValue(value, factor) {
  return (value * factor) / EXP_SCALE;
}

function ratio(collateralValue, borrowValue) {
  if (borrowValue === 0n) return 'Infinity';
  return (collateralValue * EXP_SCALE) / borrowValue;
}

async function readOraclePrice(client, config, market) {
  const priceOracle = await client.readContract({
    address: config.controller,
    abi: CONTROLLER_ABI,
    functionName: 'priceOracle',
  });
  return readMarketPrice(client, priceOracle, market);
}

async function readMarketPrice(client, priceOracle, market) {
  const [price, available] = await client.readContract({
    address: priceOracle,
    abi: ORACLE_ABI,
    functionName: 'getUnderlyingPriceAndStatus',
    args: [market.iToken],
  });
  return { price: BigInt(price), available };
}

function findRiskMarket(markets, iToken) {
  const market = findMarketByIToken(markets, iToken);
  if (!market.marketParams) {
    throw new Error(`missing market parameters for ${iToken}`);
  }
  return market;
}

async function readRiskState(client, config, markets, address) {
  const [tokenData, enteredMarkets, priceOracle] = await Promise.all([
    client.readContract({
      address: config.lendingData,
      abi: LENDING_DATA_ABI,
      functionName: 'getAccountTokens',
      args: [address],
    }),
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'getEnteredMarkets',
      args: [address],
    }),
    client.readContract({
      address: config.controller,
      abi: CONTROLLER_ABI,
      functionName: 'priceOracle',
    }),
  ]);
  const [supplyTokens, supplyAmounts, supplyDecimals, borrowTokens, borrowAmounts, borrowDecimals] = tokenData;
  let adjustedCollateralValue = 0n;
  let adjustedBorrowValue = 0n;

  for (let index = 0; index < supplyTokens.length; index++) {
    const iToken = supplyTokens[index];
    if (!enteredMarkets.some((entered) => sameAddress(entered, iToken))) continue;
    const market = findRiskMarket(markets, iToken);
    const collateralFactor = marketParam(market, 'collateralFactor');
    if (collateralFactor === null || collateralFactor === 0n) continue;
    const { price, available } = await readMarketPrice(client, priceOracle, market);
    if (!available || price === 0n) {
      return { warning: 'underlying price is unavailable' };
    }
    const value = tokenValue(BigInt(supplyAmounts[index]), price, Number(supplyDecimals[index]));
    adjustedCollateralValue += weightedValue(value, collateralFactor);
  }

  for (let index = 0; index < borrowTokens.length; index++) {
    const market = findRiskMarket(markets, borrowTokens[index]);
    const borrowFactor = marketParam(market, 'borrowFactor');
    if (borrowFactor === null || borrowFactor === 0n) {
      return { warning: 'missing borrow factor for borrow simulation' };
    }
    const { price, available } = await readMarketPrice(client, priceOracle, market);
    if (!available || price === 0n) {
      return { warning: 'underlying price is unavailable' };
    }
    const value = tokenValue(BigInt(borrowAmounts[index]), price, Number(borrowDecimals[index]));
    adjustedBorrowValue += weightedValue(value, borrowFactor);
  }

  return { adjustedCollateralValue, adjustedBorrowValue };
}

async function estimateAdequacyRatioAfter(client, config, action, market, amount, accountValue) {
  if (!['withdraw', 'borrow'].includes(action)) return null;

  const { price, available } = await readOraclePrice(client, config, market);
  if (!available || price === 0n) {
    return { adequacyRatioAfter: null, warning: 'underlying price is unavailable' };
  }

  const value = tokenValue(amount, price, market.decimals);
  const riskState = await readRiskState(client, config, accountValue.markets, accountValue.address);
  if (riskState.warning) {
    return { adequacyRatioAfter: null, warning: riskState.warning };
  }

  if (action === 'withdraw') {
    const collateralFactor = marketParam(market, 'collateralFactor');
    if (collateralFactor === null || collateralFactor === 0n) {
      return { adequacyRatioAfter: null, warning: 'missing collateral factor for withdraw simulation' };
    }
    const collateralReduction = weightedValue(value, collateralFactor);
    const collateralAfter = riskState.adjustedCollateralValue > collateralReduction
      ? riskState.adjustedCollateralValue - collateralReduction
      : 0n;
    return { adequacyRatioAfter: ratio(collateralAfter, riskState.adjustedBorrowValue) };
  }

  const borrowFactor = marketParam(market, 'borrowFactor');
  if (borrowFactor === null || borrowFactor === 0n) {
    return { adequacyRatioAfter: null, warning: 'missing borrow factor for borrow simulation' };
  }
  const borrowIncrease = weightedValue(value, borrowFactor);
  return {
    adequacyRatioAfter: ratio(riskState.adjustedCollateralValue, riskState.adjustedBorrowValue + borrowIncrease),
  };
}

function evaluatePreviewSafety(action, resolvedAmount, selected, market, adequacyRatioAfter) {
  const warnings = [];
  let willSucceed = ['supply', 'repay'].includes(action);
  const poolCash = market.cash === undefined ? null : BigInt(market.cash);

  if (resolvedAmount === 0n) {
    willSucceed = false;
    warnings.push('resolved amount must be greater than zero');
  }

  if (action === 'supply' && selected.maxSupply !== undefined && resolvedAmount > selected.maxSupply) {
    willSucceed = false;
    warnings.push('requested amount exceeds max supply');
  }
  if (action === 'repay' && selected.maxRepay !== undefined && resolvedAmount > selected.maxRepay) {
    willSucceed = false;
    warnings.push('requested amount exceeds max repay');
  }
  if (action === 'withdraw') {
    if (warnings.length === 0) willSucceed = true;
    if (poolCash === null) {
      willSucceed = false;
      warnings.push('market cash is unavailable');
    }
    if (selected.safeMaxWithdraw !== undefined && resolvedAmount > selected.safeMaxWithdraw) {
      willSucceed = false;
      warnings.push('requested amount exceeds safe max withdraw');
    }
    if (poolCash !== null && resolvedAmount > poolCash) {
      willSucceed = false;
      warnings.push('requested amount exceeds pool cash');
    }
  }
  if (action === 'borrow') {
    if (warnings.length === 0) willSucceed = true;
    if (poolCash === null) {
      willSucceed = false;
      warnings.push('market cash is unavailable');
    }
    if (selected.safeMaxBorrow !== undefined && resolvedAmount > selected.safeMaxBorrow) {
      willSucceed = false;
      warnings.push('requested amount exceeds safe max borrow');
    }
    if (poolCash !== null && resolvedAmount > poolCash) {
      willSucceed = false;
      warnings.push('requested amount exceeds pool cash');
    }
  }
  if (['withdraw', 'borrow'].includes(action)) {
    if (adequacyRatioAfter === null) {
      willSucceed = false;
      warnings.push('adequacyRatioAfter could not be estimated');
    } else if (adequacyRatioAfter !== 'Infinity' && adequacyRatioAfter <= EXP_SCALE) {
      willSucceed = false;
      warnings.push('adequacyRatioAfter must remain greater than 1');
    }
  }

  return { willSucceed, warnings };
}

export async function previewAction(client, config, markets, address, options) {
  const market = resolveMarket(markets, options.asset);
  const safeMaxFactor = parseSafetyFactor(options.safety);
  const [accountValue, supplyData, borrowData] = await Promise.all([
    readAccountTotalValue(client, config, address),
    client.readContract({
      address: config.lendingData,
      abi: LENDING_DATA_ABI,
      functionName: 'getAccountSupplyData',
      args: [market.iToken, address, safeMaxFactor],
    }),
    client.readContract({
      address: config.lendingData,
      abi: LENDING_DATA_ABI,
      functionName: 'getAccountBorrowData',
      args: [market.iToken, address, safeMaxFactor],
    }),
  ]);

  const selected = selectPreviewAmount(
    options.action,
    options.amount,
    supplyData,
    borrowData,
    market.decimals,
  );
  const resolvedRaw = typeof selected.resolvedAmount === 'bigint'
    ? selected.resolvedAmount
    : BigInt(selected.resolvedAmount);
  const afterEstimate = await estimateAdequacyRatioAfter(
    client,
    config,
    options.action,
    market,
    resolvedRaw,
    { ...accountValue, address, markets },
  );
  const safety = evaluatePreviewSafety(
    options.action,
    resolvedRaw,
    selected,
    market,
    afterEstimate?.adequacyRatioAfter ?? null,
  );
  if (afterEstimate?.warning) safety.warnings.push(afterEstimate.warning);
  if (afterEstimate?.warning) safety.willSucceed = false;

  return {
    success: true,
    action: options.action,
    asset: market.symbol,
    requested: options.amount,
    resolvedAmount: formatTokenAmount(resolvedRaw, market.decimals),
    ...formatPreviewFields(selected, market.decimals),
    adequacyRatioBefore: formatRatio(accountValue.adequacyRatio),
    adequacyRatioAfter: afterEstimate?.adequacyRatioAfter === undefined || afterEstimate?.adequacyRatioAfter === null
      ? null
      : formatRatio(afterEstimate.adequacyRatioAfter),
    willSucceed: safety.willSucceed,
    warnings: safety.warnings,
    usesSafeMax: options.amount === 'max',
    iToken: market.iToken,
  };
}
