#!/usr/bin/env node

/**
 * Conflux Swap Script - Swap tokens on Conflux eSpace via espace-uniswap-lib
 * Usage:
 *   node src/swap-cfx.js conflux <fromToken> <toToken> <amount> [--slippage <percent>] [--yes] [--quote-only]
 */

import { formatUnits, isAddress, parseAbi, parseUnits } from 'viem';
import { printUpdateNag } from './check-update.js';
import { createPublicClientWithRetry } from './lib/rpc.js';
import { getChain, getExplorerTxUrl } from './lib/chains.js';
import { exists, load } from './lib/wallet.js';
import { createClient, createEthersSigner } from 'espace-uniswap-lib';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const CONFLUX_CHAIN = 'conflux';
const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function balanceOf(address) view returns (uint256)'
]);

const args = process.argv.slice(2);
const jsonFlag = args.includes('--json');
const yesFlag = args.includes('--yes') || args.includes('-y');
const helpFlag = args.includes('--help') || args.includes('-h');
const quoteOnlyFlag = args.includes('--quote-only');

let slippage = 0.5;
const slippageIdx = args.indexOf('--slippage');
if (slippageIdx !== -1 && args[slippageIdx + 1]) {
  slippage = parseFloat(args[slippageIdx + 1]);
  if (Number.isNaN(slippage) || slippage <= 0 || slippage > 50) {
    console.error('Error: Slippage must be between 0 and 50 percent');
    process.exit(1);
  }
}

function showHelp() {
  console.log(`
Conflux Token Swap

Usage: node src/swap-cfx.js [options] conflux <fromToken> <toToken> <amount>

Arguments:
  chain          Must be 'conflux' (kept for CLI compatibility)
  fromToken      Token to sell: 'cfx'/'native', 'wcfx'/'wcfx9', zero address, or ERC20 contract address
  toToken        Token to buy: 'cfx'/'native', 'wcfx'/'wcfx9', zero address, or ERC20 contract address
  amount         Amount of fromToken to swap

Options:
  --slippage <n> Slippage tolerance in percent (default: 0.5)
  --yes          Skip confirmation prompt
  --quote-only   Get a quote without executing the swap
  --json         Output in JSON format
  --help         Show this help message

Examples:
  node src/swap-cfx.js conflux cfx 0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff 1 --quote-only
  node src/swap-cfx.js conflux 0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff cfx 20 --yes
`);
}

function exitWithError(message, code = 1) {
  if (jsonFlag) {
    console.log(JSON.stringify({ success: false, error: message }));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(code);
}

function safeErrorMessage(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error.shortMessage) return error.shortMessage;
  if (error.reason) return error.reason;
  if (error.message) return error.message;
  return String(error);
}

function parsePositionalArgs(argv) {
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i] === '--slippage') i++;
      continue;
    }
    if (argv[i] === '-y' || argv[i] === '-h') continue;
    positional.push(argv[i]);
  }
  return positional;
}

function isNativeAlias(token) {
  const lower = token.toLowerCase();
  return lower === 'cfx' || lower === 'native' || lower === 'wcfx' || lower === 'wcfx9' || lower === ZERO_ADDRESS;
}

function slippagePercentToBps(slippagePercent) {
  return Math.round(slippagePercent * 100);
}

function formatDisplayAmount(amount, decimals) {
  return formatUnits(amount, decimals);
}

function formatPriceImpactForText(priceImpact) {
  return priceImpact === null ? 'N/A' : `${priceImpact.toFixed(3)}%`;
}

function debugLog(label, payload) {
  if (jsonFlag) return;
  if (payload === undefined) {
    console.log(`🧪 [debug] ${label}`);
    return;
  }
  console.log(`🧪 [debug] ${label}:`, payload);
}

function findKnownTokenByAddress(client, address) {
  return Object.values(client.tokens).find(
    (token) => token.address.toLowerCase() === address.toLowerCase()
  ) || null;
}

async function createConfluxSwapClient() {
  const chain = getChain(CONFLUX_CHAIN);
  const failures = [];

  for (const rpcUrl of chain.rpcs) {
    try {
      const client = await createClient({ rpcUrl });
      return { client, rpcUrl };
    } catch (error) {
      failures.push(`${rpcUrl}: ${safeErrorMessage(error)}`);
    }
  }

  exitWithError(`Failed to initialize Conflux swap client. ${failures.join('; ')}`);
}

async function getErc20Metadata(publicClient, address) {
  try {
    const [symbol, decimals, name] = await Promise.all([
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
      publicClient.readContract({ address, abi: ERC20_ABI, functionName: 'name' }),
    ]);

    return {
      symbol,
      decimals: Number(decimals),
      name,
    };
  } catch (error) {
    exitWithError(`Failed to get token info for ${address}: ${safeErrorMessage(error)}`);
  }
}

function createNativeTokenRef(client, chain) {
  return {
    routeToken: client.tokens.WCFX9,
    address: ZERO_ADDRESS,
    symbol: chain.nativeToken.symbol,
    decimals: chain.nativeToken.decimals,
    name: `Native ${chain.nativeToken.symbol}`,
    balanceType: 'native',
  };
}

async function resolveToken(publicClient, client, chain, tokenArg) {
  if (isNativeAlias(tokenArg)) {
    return createNativeTokenRef(client, chain);
  }

  if (!isAddress(tokenArg)) {
    exitWithError(`Invalid token address: ${tokenArg}`);
  }

  if (client.tokens.WCFX9.address.toLowerCase() === tokenArg.toLowerCase()) {
    return createNativeTokenRef(client, chain);
  }

  const knownToken = findKnownTokenByAddress(client, tokenArg);
  if (knownToken) {
    return {
      routeToken: knownToken,
      address: knownToken.address,
      symbol: knownToken.symbol,
      decimals: knownToken.decimals,
      name: knownToken.name ?? knownToken.symbol,
      balanceType: 'erc20',
    };
  }

  const metadata = await getErc20Metadata(publicClient, tokenArg);
  const TokenCtor = client.tokens.WCFX9.constructor;
  return {
    routeToken: new TokenCtor(chain.chainId, tokenArg, metadata.decimals, metadata.symbol, metadata.name),
    address: tokenArg,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
    name: metadata.name,
    balanceType: 'erc20',
  };
}

async function getBalance(publicClient, token, walletAddress) {
  if (token.balanceType === 'native') {
    return publicClient.getBalance({ address: walletAddress });
  }

  return publicClient.readContract({
    address: token.address,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [walletAddress],
  });
}

async function ensureApproval(client, token, signer, amount) {
  if (token.balanceType === 'native') return;

  await client.utils.approveIfNeeded(
    token.address,
    client.addresses.WFX_ROUTER,
    amount.toString(),
    signer
  );
}

function getRawRoute(route) {
  return route?.route?.[0]?.route ?? null;
}

function normalizeNumberLike(value, methodName = null) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (methodName && typeof value[methodName] === 'function') {
    try {
      const parsed = Number(value[methodName](6));
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  if (typeof value.toString === 'function') {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function extractPriceImpact(route) {
  const candidates = [
    route?.trade?.priceImpact,
    route?.priceImpact,
  ];

  for (const candidate of candidates) {
    const fixed = normalizeNumberLike(candidate, 'toFixed');
    if (fixed !== null) return fixed;

    const significant = normalizeNumberLike(candidate, 'toSignificant');
    if (significant !== null) return significant;
  }

  return null;
}

function extractGasEstimate(route) {
  const candidates = [
    route?.estimatedGasUsed,
    route?.gasEstimate,
    route?.totalGasUseEstimate,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate.toString();
    if (typeof candidate === 'bigint') return candidate.toString();
    if (typeof candidate.toString === 'function') {
      const value = candidate.toString();
      if (value && value !== '[object Object]') return value;
    }
  }

  return null;
}

async function getQuoteAmount(client, route, rawRoute, fromToken, inputAmountRaw) {
  if (route?.quoteAmount !== undefined && route?.quoteAmount !== null) {
    return BigInt(route.quoteAmount.toString());
  }

  if (route?.quote?.quotient !== undefined && route?.quote?.quotient !== null) {
    return BigInt(route.quote.quotient.toString());
  }

  const quoteOutput = await client.v3.getQuoteOutput(rawRoute, fromToken.routeToken, inputAmountRaw);
  return BigInt(quoteOutput[0].toString());
}

async function getSwapQuote(client, fromToken, toToken, inputAmountRaw, walletAddress, slippageBps) {
  debugLog('findRoute params', {
    fromToken: fromToken.symbol,
    fromAddress: fromToken.address,
    toToken: toToken.symbol,
    toAddress: toToken.address,
    inputAmountRaw,
    walletAddress,
    slippageBps,
  });

  const route = await client.v3.findRoute(
    fromToken.routeToken,
    toToken.routeToken,
    inputAmountRaw,
    walletAddress,
    { slippageBps }
  );

  const rawRoute = getRawRoute(route);
  const priceImpact = extractPriceImpact(route);
  const gasEstimate = extractGasEstimate(route);

  debugLog('findRoute result', {
    routeFound: Boolean(route),
    hasRawRoute: Boolean(rawRoute),
    routeCandidates: Array.isArray(route?.route) ? route.route.length : 0,
    priceImpact,
    gasEstimate,
  });

  if (!rawRoute) {
    exitWithError('No route found for this token pair on Conflux.');
  }

  const quoteAmount = await getQuoteAmount(client, route, rawRoute, fromToken, inputAmountRaw);
  debugLog('quote result', {
    quoteAmountRaw: quoteAmount.toString(),
    outputToken: toToken.symbol,
  });

  return {
    route,
    quoteAmount,
    priceImpact,
    gasEstimate,
  };
}

async function confirm(message) {
  if (yesFlag || jsonFlag) return true;

  process.stdout.write(`${message} (y/N): `);
  return new Promise((resolve) => {
    process.stdin.once('data', (data) => {
      const response = data.toString().trim().toLowerCase();
      resolve(response === 'y' || response === 'yes');
    });
  });
}

async function main() {
  try {
    if (helpFlag) {
      showHelp();
      return;
    }

    const positional = parsePositionalArgs(args);
    const [chainArg, fromTokenArg, toTokenArg, amountStr] = positional;

    if (!chainArg || !fromTokenArg || !toTokenArg || !amountStr) {
      exitWithError('Missing required arguments. Use --help for usage information.');
    }

    if (chainArg.toLowerCase() !== CONFLUX_CHAIN) {
      exitWithError(`swap-cfx.js only supports '${CONFLUX_CHAIN}'. Received: ${chainArg}`);
    }

    if (!exists()) {
      exitWithError('No wallet found. Run setup.js first to generate a wallet.');
    }

    const chain = getChain(CONFLUX_CHAIN);
    const publicClient = createPublicClientWithRetry(CONFLUX_CHAIN);
    const { client } = await createConfluxSwapClient();
    const wallet = load();
    const signer = createEthersSigner(wallet.privateKey, client.provider);
    const walletAddress = wallet.address;

    const [fromToken, toToken] = await Promise.all([
      resolveToken(publicClient, client, chain, fromTokenArg),
      resolveToken(publicClient, client, chain, toTokenArg),
    ]);

    if (fromToken.routeToken.address.toLowerCase() === toToken.routeToken.address.toLowerCase()) {
      exitWithError('Cannot swap a token to itself.');
    }

    const inputAmount = parseUnits(amountStr, fromToken.decimals);
    const inputAmountRaw = inputAmount.toString();
    const balance = await getBalance(publicClient, fromToken, walletAddress);
    if (balance < inputAmount) {
      const formattedBalance = formatDisplayAmount(balance, fromToken.decimals);
      exitWithError(`Insufficient ${fromToken.symbol} balance. Have: ${formattedBalance}, Need: ${amountStr}`);
    }

    if (!jsonFlag) {
      console.log(`\n🔍 Getting quote: ${amountStr} ${fromToken.symbol} → ${toToken.symbol} on ${chain.name}...`);
    }

    const slippageBps = slippagePercentToBps(slippage);
    const quote = await getSwapQuote(client, fromToken, toToken, inputAmountRaw, walletAddress, slippageBps);
    const formattedOutput = formatDisplayAmount(quote.quoteAmount, toToken.decimals);

    if (quoteOnlyFlag) {
      if (jsonFlag) {
        console.log(JSON.stringify({
          success: true,
          quote: {
            fromToken: { address: fromToken.address, symbol: fromToken.symbol, amount: amountStr },
            toToken: { address: toToken.address, symbol: toToken.symbol, amount: formattedOutput },
            priceImpact: quote.priceImpact,
            gasEstimate: quote.gasEstimate,
            slippage,
            chain: CONFLUX_CHAIN,
          }
        }, null, 2));
      } else {
        console.log(`
📊 Swap Quote:
  Sell:         ${amountStr} ${fromToken.symbol}
  Buy:          ${formattedOutput} ${toToken.symbol}
  Price Impact: ${formatPriceImpactForText(quote.priceImpact)}
  Gas Estimate: ${quote.gasEstimate ?? 'N/A'}
  Slippage:     ${slippage}%
  Chain:        ${chain.name}
`);
      }
      return;
    }

    if (!jsonFlag) {
      console.log(`
🔄 Swap Details:
  Sell:         ${amountStr} ${fromToken.symbol}
  Buy:          ~${formattedOutput} ${toToken.symbol}
  Price Impact: ${formatPriceImpactForText(quote.priceImpact)}
  Gas Estimate: ${quote.gasEstimate ?? 'N/A'}
  Slippage:     ${slippage}%
  Chain:        ${chain.name}
  Wallet:       ${walletAddress}
`);
    }

    const confirmed = await confirm('Proceed with swap?');
    if (!confirmed) {
      if (jsonFlag) {
        console.log(JSON.stringify({ success: false, error: 'Swap cancelled by user' }));
      } else {
        console.log('❌ Swap cancelled.');
      }
      return;
    }

    await ensureApproval(client, fromToken, signer, inputAmount);

    if (!jsonFlag) {
      console.log('⏳ Sending swap transaction...');
    }

    const receipt = await client.v3.swapExactInputMulticall(
      fromToken.routeToken,
      toToken.routeToken,
      inputAmountRaw,
      signer,
      { slippageBps }
    );

    if (!receipt || receipt.status !== 1) {
      exitWithError('Swap transaction reverted.');
    }

    const txHash = receipt.transactionHash;
    const explorerUrl = getExplorerTxUrl(CONFLUX_CHAIN, txHash);

    if (jsonFlag) {
      console.log(JSON.stringify({
        success: true,
        txHash,
        explorerUrl,
        from: walletAddress,
        chain: CONFLUX_CHAIN,
        input: { token: fromToken.address, symbol: fromToken.symbol, amount: amountStr },
        output: { token: toToken.address, symbol: toToken.symbol, expectedAmount: formattedOutput },
        priceImpact: quote.priceImpact,
        gasUsed: receipt.gasUsed?.toString?.() ?? null,
        slippage,
      }, null, 2));
    } else {
      console.log(`
✅ Swap successful!
  Sold:     ${amountStr} ${fromToken.symbol}
  Got:      ~${formattedOutput} ${toToken.symbol}
  Tx Hash:  ${txHash}
  Explorer: ${explorerUrl}

💡 Check your balance: node src/balance.js conflux${toToken.address !== ZERO_ADDRESS ? ' ' + toToken.address : ''}
`);
    }
  } catch (error) {
    exitWithError(`Unexpected error: ${safeErrorMessage(error)}`);
  }
}

main().then(() => printUpdateNag()).catch((error) => {
  exitWithError(`Unexpected error: ${safeErrorMessage(error)}`);
});
