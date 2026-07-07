import { parseUnits } from 'viem';
import { CONTROLLER_ABI, ERC20_ABI, ITOKEN_ABI } from './abis.js';

function parseActionAmount(amount, decimals) {
  if (typeof amount === 'bigint') return amount;
  return parseUnits(String(amount), decimals);
}

function erc20Approval(market, amount) {
  return {
    description: `Approve ${market.symbol} for Unitus iToken`,
    address: market.underlying,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [market.iToken, amount],
    value: 0n,
  };
}

function enterMarket(controller, market) {
  return {
    description: `Enter ${market.symbol} market as collateral`,
    address: controller,
    abi: CONTROLLER_ABI,
    functionName: 'enterMarkets',
    args: [[market.iToken]],
    value: 0n,
  };
}

function shouldRefreshEligibility(market) {
  return market.refreshEligibility === true;
}

export function buildUnitusTransactions({ action, market, amount, collateral = false, user, controller }) {
  const parsedAmount = parseActionAmount(amount, market.decimals);
  const refreshEligibility = shouldRefreshEligibility(market);
  const txs = [];

  if (action === 'supply') {
    if (market.native) {
      txs.push({
        description: `Supply native ${market.symbol} to Unitus`,
        address: market.iToken,
        abi: ITOKEN_ABI,
        functionName: 'mint',
        args: [user],
        value: parsedAmount,
      });
      if (collateral && controller) txs.push(enterMarket(controller, market));
      return txs;
    }

    txs.push(erc20Approval(market, parsedAmount));
    txs.push({
      description: collateral ? `Supply ${market.symbol} and enter market` : `Supply ${market.symbol} to Unitus`,
      address: market.iToken,
      abi: ITOKEN_ABI,
      functionName: collateral ? 'mintForSelfAndEnterMarket' : 'mint',
      args: collateral
        ? refreshEligibility ? [parsedAmount, true] : [parsedAmount]
        : refreshEligibility ? [user, parsedAmount, true] : [user, parsedAmount],
      value: 0n,
    });
    return txs;
  }

  if (action === 'withdraw') {
    return [{
      description: `Withdraw ${market.symbol} from Unitus`,
      address: market.iToken,
      abi: ITOKEN_ABI,
      functionName: 'redeemUnderlying',
      args: refreshEligibility ? [user, parsedAmount, true] : [user, parsedAmount],
      value: 0n,
    }];
  }

  if (action === 'borrow') {
    return [{
      description: `Borrow ${market.symbol} from Unitus`,
      address: market.iToken,
      abi: ITOKEN_ABI,
      functionName: 'borrow',
      args: refreshEligibility ? [parsedAmount, true] : [parsedAmount],
      value: 0n,
    }];
  }

  if (action === 'repay') {
    if (market.native) {
      return [{
        description: `Repay native ${market.symbol} borrow on Unitus`,
        address: market.iToken,
        abi: ITOKEN_ABI,
        functionName: 'repayBorrow',
        args: refreshEligibility ? [false] : [],
        value: parsedAmount,
      }];
    }

    txs.push(erc20Approval(market, parsedAmount));
    txs.push({
      description: `Repay ${market.symbol} borrow on Unitus`,
      address: market.iToken,
      abi: ITOKEN_ABI,
      functionName: 'repayBorrow',
      args: refreshEligibility ? [parsedAmount, false] : [parsedAmount],
      value: 0n,
    });
    return txs;
  }

  throw new Error(`Unsupported Unitus action: ${action}`);
}

export async function executeUnitusTransactions(walletClient, txs, gasOptions = {}) {
  const hashes = [];
  for (const tx of txs) {
    const hash = await walletClient.writeContract({
      address: tx.address,
      abi: tx.abi,
      functionName: tx.functionName,
      args: tx.args,
      value: tx.value,
      ...gasOptions,
    });
    hashes.push({ description: tx.description, txHash: hash });
  }
  return hashes;
}
