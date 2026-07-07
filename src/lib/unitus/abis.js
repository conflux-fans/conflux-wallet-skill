import { parseAbi } from 'viem';

export const CONTROLLER_ABI = parseAbi([
  'function getAlliTokens() view returns (address[])',
  'function getEnteredMarkets(address account) view returns (address[])',
  'function getBorrowedAssets(address account) view returns (address[])',
  'function hasEnteredMarket(address account, address iToken) view returns (bool)',
  'function markets(address iToken) view returns (uint256 collateralFactor, uint256 borrowFactor, uint256 borrowCapacity, uint256 supplyCapacity, bool mintPaused, bool redeemPaused, bool borrowPaused)',
  'function calcAccountEquity(address account) view returns (uint256 equity, uint256 shortfall, uint256 collaterals, uint256 borrows)',
  'function priceOracle() view returns (address)',
  'function rewardDistributor() view returns (address)',
  'function enterMarkets(address[] iTokens) returns (bool[])',
]);

export const ITOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function underlying() view returns (address)',
  'function getCash() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function balanceOfUnderlying(address account) returns (uint256)',
  'function borrowBalanceCurrent(address account) returns (uint256)',
  'function borrowBalanceStored(address account) view returns (uint256)',
  'function totalBorrowsCurrent() returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
  'function supplyRatePerBlock() view returns (uint256)',
  'function borrowRatePerBlock() view returns (uint256)',
  'function interestRateModel() view returns (address)',
  'function mint(address recipient, uint256 mintAmount)',
  'function mint(address recipient, uint256 mintAmount, bool refreshEligibility)',
  'function mint(address recipient) payable',
  'function mintForSelfAndEnterMarket(uint256 mintAmount)',
  'function mintForSelfAndEnterMarket(uint256 mintAmount, bool refreshEligibility)',
  'function redeemUnderlying(address from, uint256 redeemUnderlying)',
  'function redeemUnderlying(address from, uint256 redeemUnderlying, bool refreshEligibility)',
  'function borrow(uint256 borrowAmount)',
  'function borrow(uint256 borrowAmount, bool refreshEligibility)',
  'function repayBorrow(uint256 repayAmount)',
  'function repayBorrow(uint256 repayAmount, bool refreshEligibility)',
  'function repayBorrow() payable',
  'function repayBorrow(bool refreshEligibility) payable',
]);

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const ORACLE_ABI = parseAbi([
  'function getUnderlyingPrice(address iToken) view returns (uint256)',
  'function getUnderlyingPriceAndStatus(address iToken) view returns (uint256, bool)',
]);

export const LENDING_DATA_ABI = parseAbi([
  'function controller() view returns (address)',
  'function getAccountTotalValue(address account) returns (uint256 supplyValue, uint256 collateralValue, uint256 borrowValue, uint256 adequacyRatio)',
  'function getAccountTokens(address account) returns (address[] supplyTokens, uint256[] supplyAmounts, uint8[] supplyDecimals, address[] borrowTokens, uint256[] borrowAmounts, uint8[] borrowDecimals)',
  'function getAccountSupplyData(address asset, address account, uint256 safeMaxFactor) returns (uint256 suppliedBalance, uint256 accountBalance, uint256 maxMintAmount, uint256 availableToWithdraw, uint256 safeAvailableToWithdraw, uint256 iTokenBalance, uint8 decimals)',
  'function getAccountBorrowData(address asset, address account, uint256 safeMaxFactor) returns (uint256 borrowedBalance, uint256 canBorrows, uint256 safeAvailableToBorrow, uint256 accountBalance, uint256 maxRepay, uint8 decimals)',
]);
