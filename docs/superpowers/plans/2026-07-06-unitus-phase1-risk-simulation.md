# Unitus Phase 1 Risk Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish safe `withdraw` and `borrow` previews/execution gating for Unitus Phase 1.

**Architecture:** Keep preview logic in `src/lib/unitus/read.js`. Use `LendingData.getAccountTotalValue`, `getAccountSupplyData`, `getAccountBorrowData`, market risk parameters, and market cash to compute conservative after-operation adequacy ratios.

**Tech Stack:** Node.js, viem, native Node test runner.

---

### Task 1: Add Failing Preview Tests

**Files:**
- Modify: `tests/unitus.test.js`

- [x] Add tests showing safe `withdraw` and `borrow` previews produce `adequacyRatioAfter` and `willSucceed: true`.
- [x] Add tests showing previews block when requested amount exceeds safe max or pool cash.
- [x] Run `npm test` and confirm the new tests fail because current code returns `adequacyRatioAfter: null` and blocks all `withdraw` / `borrow`.

### Task 2: Implement After-Ratio Preview Logic

**Files:**
- Modify: `src/lib/unitus/read.js`

- [x] Add helpers for scaled value math and ratio formatting.
- [x] Read `supplyValue`, `collateralValue`, `borrowValue`, and `adequacyRatio` once for preview.
- [x] Compute `withdraw` after ratio by reducing collateral value with `amount * collateralFactor`.
- [x] Compute `borrow` after ratio by increasing borrow value with `amount * borrowFactor`.
- [x] Preserve blocking behavior when required data is missing or unsafe.
- [x] Run `npm test` and confirm all tests pass.

### Task 3: Verify CLI Gate Remains Strict

**Files:**
- Inspect: `src/unitus.js`

- [x] Confirm writes still refuse execution when preview has warnings or `willSucceed: false`.
- [x] Run `npm test`.
- [x] If network is available, run `node src/unitus.js markets conflux --json` and one `preview borrow` / `preview withdraw` read-only command.
