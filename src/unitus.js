#!/usr/bin/env node

import { encodeFunctionData, formatEther } from 'viem';
import { pathToFileURL } from 'node:url';
import { printUpdateNag } from './check-update.js';
import { getAddress, exists, getWalletClient } from './lib/wallet.js';
import { createPublicClientWithRetry } from './lib/rpc.js';
import { estimateGas, estimateGasLimit, formatGwei } from './lib/gas.js';
import { getExplorerTxUrl } from './lib/chains.js';
import { getUnitusConfig, validateUnitusConfig } from './lib/unitus/config.js';
import { discoverMarkets, getPosition, previewAction } from './lib/unitus/read.js';
import { resolveMarket } from './lib/unitus/resolve.js';
import { buildUnitusTransactions, executeUnitusTransactions } from './lib/unitus/write.js';

const args = process.argv.slice(2);
const jsonFlag = args.includes('--json');
const yesFlag = args.includes('--yes') || args.includes('-y');
const helpFlag = args.includes('--help') || args.includes('-h');
const collateralFlag = args.includes('--collateral');

function showHelp() {
  console.log(`
Unitus Lending on Conflux eSpace

Usage:
  node src/unitus.js markets <chain> [--json]
  node src/unitus.js position <chain> [--json]
  node src/unitus.js preview <action> <chain> <asset> <amount|max> [--collateral] [--json]
  node src/unitus.js <supply|withdraw|borrow|repay> <chain> <asset> <amount|max> [--collateral] --yes [--json]

Examples:
  node src/unitus.js markets conflux --json
  node src/unitus.js position conflux --json
  node src/unitus.js preview supply conflux USDT0 10 --collateral --json
  node src/unitus.js supply conflux USDT0 10 --collateral --yes --json
`);
}

function exitWithError(message, code = 1) {
  if (jsonFlag) {
    console.log(JSON.stringify({ success: false, error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(code);
}

function safeMessage(error) {
  return error?.shortMessage ?? error?.message ?? String(error);
}

function positionalArgs() {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' || arg === '--yes' || arg === '-y' || arg === '--help' || arg === '-h' || arg === '--collateral') continue;
    if (arg === '--safety') {
      i++;
      continue;
    }
    result.push(arg);
  }
  return result;
}

function safetyOption() {
  const idx = args.indexOf('--safety');
  if (idx === -1) return undefined;
  const safety = Number(args[idx + 1]);
  if (!Number.isFinite(safety) || safety <= 0 || safety >= 1) {
    exitWithError('--safety must be a number greater than 0 and less than 1');
  }
  return safety;
}

function requireWallet() {
  if (!exists()) {
    exitWithError('No wallet found. Run setup.js first to generate a wallet.');
  }
  return getAddress();
}

async function loadUnitus(chainName) {
  const config = getUnitusConfig(chainName);
  const client = createPublicClientWithRetry(chainName);
  await validateUnitusConfig(client, config);
  return { config, client, marketsResult: await discoverMarkets(client, config) };
}

function printResult(result) {
  const replacer = (_key, value) => (typeof value === 'bigint' ? value.toString() : value);
  if (jsonFlag) {
    console.log(JSON.stringify(result, replacer, 2));
  } else {
    console.log(JSON.stringify(result, replacer, 2));
  }
}

export async function estimateTxGas(chainName, publicClient, walletAddress, txs, gasQuote = null) {
  const gas = gasQuote ?? await estimateGas(chainName);
  const estimates = [];
  for (const tx of txs) {
    const data = tx.data ?? encodeFunctionData({
      abi: tx.abi,
      functionName: tx.functionName,
      args: tx.args,
    });
    const gasLimit = await estimateGasLimit(publicClient, {
      account: walletAddress,
      to: tx.address,
      value: tx.value,
      data,
    }).catch(() => null);
    estimates.push({ ...gas, gasLimit });
  }
  return estimates;
}

async function main() {
  if (helpFlag || args.length === 0) {
    showHelp();
    return;
  }

  printUpdateNag();
  const [command, maybeActionOrChain, maybeChain, maybeAsset, maybeAmount] = positionalArgs();

  try {
    if (command === 'markets') {
      const chainName = maybeActionOrChain;
      if (!chainName) exitWithError('Missing chain argument');
      const { marketsResult } = await loadUnitus(chainName);
      printResult({ success: true, ...marketsResult });
      return;
    }

    if (command === 'position') {
      const chainName = maybeActionOrChain;
      if (!chainName) exitWithError('Missing chain argument');
      const address = requireWallet();
      const { config, client, marketsResult } = await loadUnitus(chainName);
      printResult(await getPosition(client, config, marketsResult.markets, address));
      return;
    }

    if (command === 'preview') {
      const action = maybeActionOrChain;
      const chainName = maybeChain;
      const asset = maybeAsset;
      const amount = maybeAmount;
      if (!action || !chainName || !asset || !amount) exitWithError('Missing preview arguments');
      const address = requireWallet();
      const { config, client, marketsResult } = await loadUnitus(chainName);
      printResult(await previewAction(client, config, marketsResult.markets, address, {
        action,
        asset,
        amount,
        collateral: collateralFlag,
        safety: safetyOption(),
      }));
      return;
    }

    if (['supply', 'withdraw', 'borrow', 'repay'].includes(command)) {
      const chainName = maybeActionOrChain;
      const asset = maybeChain;
      const amount = maybeAsset;
      if (!chainName || !asset || !amount) exitWithError('Missing write arguments');
      if (!yesFlag) exitWithError('Write operations require explicit --yes after user confirmation');
      const address = requireWallet();
      const { config, client, marketsResult } = await loadUnitus(chainName);
      const preview = await previewAction(client, config, marketsResult.markets, address, {
        action: command,
        asset,
        amount,
        collateral: collateralFlag,
        safety: safetyOption(),
      });
      if (!preview.willSucceed || preview.warnings.length > 0) {
        printResult({ success: false, error: 'Preview did not pass write safety checks', preview });
        process.exit(1);
      }
      const market = resolveMarket(marketsResult.markets, asset);
      const txs = buildUnitusTransactions({
        action: command,
        market,
        amount: preview.resolvedAmount,
        collateral: collateralFlag,
        user: address,
        controller: config.controller,
      });
      const walletClient = getWalletClient(chainName);
      const gasEstimates = await estimateTxGas(chainName, client, address, txs);
      const hashes = await executeUnitusTransactions(walletClient, txs, {
        maxFeePerGas: gasEstimates[0]?.maxFeePerGas,
        maxPriorityFeePerGas: gasEstimates[0]?.maxPriorityFeePerGas,
      });
      printResult({
        success: true,
        action: command,
        asset: market.symbol,
        preview,
        transactions: hashes.map((tx) => ({
          ...tx,
          explorerUrl: getExplorerTxUrl(chainName, tx.txHash),
        })),
        gas: gasEstimates.map((gas) => ({
          maxFeePerGas: gas.maxFeePerGas?.toString(),
          maxPriorityFeePerGas: gas.maxPriorityFeePerGas?.toString(),
          gasLimit: gas.gasLimit?.toString() ?? null,
          maxFeeGwei: gas.maxFeePerGas ? formatGwei(gas.maxFeePerGas) : null,
          estimatedCostNative: gas.gasLimit ? formatEther(gas.gasLimit * gas.maxFeePerGas) : null,
        })),
      });
      return;
    }

    exitWithError(`Unknown Unitus command: ${command}`);
  } catch (error) {
    exitWithError(safeMessage(error));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
