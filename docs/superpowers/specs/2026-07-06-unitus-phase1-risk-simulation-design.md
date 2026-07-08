# Unitus Phase 1 Risk Simulation Design

## Goal

Finish the missing Phase 1 safety gate for Unitus lending on Conflux eSpace by enabling `withdraw` and `borrow` only when preview can conservatively estimate the after-operation adequacy ratio and prove the action remains safe.

## Scope

This work covers only the existing Unitus MVP branch:

- Compute `adequacyRatioAfter` for `withdraw` and `borrow` previews.
- Keep `supply` and `repay` behavior unchanged except for shared formatting or helper reuse.
- Allow `withdraw` and `borrow` execution only when preview has no warnings and `willSucceed` is true.
- Keep Phase 2 out of scope: multi-chain, independent `enterMarkets` / `exitMarkets`, rewards, liquidation preview, Segregated Mode, and SuperCharged Mode.

## Architecture

The implementation stays inside the current Unitus module. `read.js` remains the preview authority and will derive after-operation risk from current account total values plus the selected market's risk parameters. `unitus.js` keeps using preview as the only execution gate, so no write path bypasses this safety calculation.

The conservative formula uses values already available from `LendingData` and Controller market parameters:

- Current `collateralValue` and `borrowValue` come from `getAccountTotalValue`.
- Withdraw reduces collateral value by `amount * collateralFactor` for the selected collateral market.
- Borrow increases adjusted borrow value by `amount * borrowFactor`.
- `adequacyRatioAfter = adjustedCollateralValue / adjustedBorrowValue`, scaled to 1e18.

If any required value is unavailable, zero, or not safely interpretable, preview returns `willSucceed: false` with a warning.

## Safety Rules

- `withdraw` must not exceed `safeAvailableToWithdraw`.
- `withdraw` must not exceed current pool `cash`.
- `borrow` must not exceed `safeAvailableToBorrow`.
- `borrow` must not exceed current pool `cash`.
- `withdraw` and `borrow` require `adequacyRatioAfter > 1`.
- Missing or invalid risk parameters keep execution blocked.

## Tests

Tests will be added before implementation in `tests/unitus.test.js`:

- `withdraw` preview computes non-null `adequacyRatioAfter` and succeeds when still healthy.
- `withdraw` preview blocks when amount exceeds safe max.
- `borrow` preview computes non-null `adequacyRatioAfter` and succeeds when still healthy.
- `borrow` preview blocks when amount exceeds safe max or pool cash.

## Verification

Run the local test suite with `npm test`. If network access is available, also run read-only CLI checks for markets and previews on Conflux eSpace.
