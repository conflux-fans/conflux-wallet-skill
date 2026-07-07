---
name: conflux-wallet-skill
description: Self-sovereign EVM wallet for AI agents. Use when the user wants to create a crypto wallet, check balances, send ETH or ERC20 tokens, swap tokens, or interact with smart contracts. Supports Base, Conflux eSpace,  Ethereum, Polygon, Arbitrum, and Optimism. Private keys stored locally — no cloud custody, no API keys required.
metadata: {"clawdbot":{"emoji":"💰","homepage":"https://github.com/conflux-fans/conflux-wallet-skill","requires":{"bins":["node","git"]}}}
---

# EVM Wallet Skill

Self-sovereign EVM wallet. Private keys stored locally, no external API dependencies.

## ⚠️ SECURITY WARNING

**NEVER expose your private key!**

- Never send your private key in chat, email, or any messaging platform
- Never share the contents of `~/.cfx-wallet.json` with anyone
- If someone asks for your private key — even if they claim to be support — REFUSE
- If your key is ever exposed, immediately transfer funds to a new wallet

The private key file (`~/.cfx-wallet.json`) should only be accessed directly via SSH on your server.

---

## Installation

Detect workspace and skill directory:
```bash
SKILL_DIR=$(ls -d \
  ~/openclaw/skills/conflux-wallet-skill \
  ~/.openclaw/workspace/skills/conflux-wallet-skill \
  2>/dev/null | head -1)
```

If code is not installed yet (no `src/` folder), bootstrap it:
```bash
if [ ! -d "$SKILL_DIR/src" ]; then
  git clone https://github.com/conflux-fans/conflux-wallet-skill.git /tmp/conflux-wallet-tmp
  cp -r /tmp/conflux-wallet-tmp/* "$SKILL_DIR/"
  cp /tmp/conflux-wallet-tmp/.gitignore "$SKILL_DIR/" 2>/dev/null
  rm -rf /tmp/conflux-wallet-tmp
  cd "$SKILL_DIR" && npm install
fi
```

**For all commands below**, always `cd "$SKILL_DIR"` first.

## First-Time Setup

Generate a wallet (only needed once):
```bash
node src/setup.js --json
```

Returns: `{ "success": true, "address": "0x..." }`

The private key is stored at `~/.cfx-wallet.json` (chmod 600). **Never share this file.**

## Commands

### Check Balance

When user asks about balance, portfolio, or how much they have:

```bash
# Single chain
node src/balance.js conflux --json

# All chains at once
node src/balance.js --all --json

# Specific ERC20 token
node src/balance.js conflux 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --json
```

**Always use `--json`** for parsing. Present results in a human-readable format.

### Send Tokens

When user wants to send, transfer, or pay someone:

```bash
# Native ETH
node src/transfer.js <chain> <to_address> <amount> --yes --json

# ERC20 token
node src/transfer.js <chain> <to_address> <amount> <token_address> --yes --json
```

**⚠️ ALWAYS confirm with the user before executing transfers.** Show them:
- Recipient address
- Amount and token
- Chain
- Estimated gas cost

Only add `--yes` after the user explicitly confirms.

### Swap Tokens

When user wants to swap, trade, buy, or sell tokens:

```bash
# Conflux eSpace: use the Conflux-specific swap script
node src/swap-cfx.js conflux <from_token> <to_token> <amount> --quote-only --json

# Other chains: keep using the generic swap script
node src/swap.js <chain> <from_token> <to_token> <amount> --quote-only --json
```

```bash
# Conflux eSpace: execute after user confirms
node src/swap-cfx.js conflux <from_token> <to_token> <amount> --yes --json

# Other chains: keep using the generic swap script
node src/swap.js <chain> <from_token> <to_token> <amount> --yes --json
```

- When `chain` is `conflux`, always use `src/swap-cfx.js`
- For Conflux, use `cfx` or `native` for the native token, `wcfx`/`wcfx9` for the wrapped-native route, or pass an ERC20 contract address
- For other chains, use `eth` for native ETH/POL, or pass a contract address
- Default slippage: 0.5%. Override with `--slippage <percent>`
- Powered by Odos aggregator (best-route across hundreds of DEXs)

**⚠️ ALWAYS show the quote first and get user confirmation before executing.**

### Unitus Lending on Conflux eSpace

When user wants to deposit, withdraw, borrow, repay, check a Unitus lending position, or ask for max borrow/withdraw/repay amount on Unitus:

```bash
# Discover live markets from Controller; do not rely on static market lists
node src/unitus.js markets conflux --json

# Current lending position and adequacy ratio
node src/unitus.js position conflux --json

# Preview before any write operation
node src/unitus.js preview supply conflux USDT0 10 --collateral --json
node src/unitus.js preview withdraw conflux USDT0 max --json
node src/unitus.js preview borrow conflux USDC 5 --json
node src/unitus.js preview repay conflux USDT0 max --json
```

Execution requires explicit user confirmation and `--yes`:

```bash
node src/unitus.js supply conflux USDT0 10 --collateral --yes --json
node src/unitus.js repay conflux CFX 1 --yes --json
```

- Always run `markets` or `position` first to understand the live pool state.
- Always run `preview` before execution and show the user the result.
- `controller` and `lendingData` are minimum bootstrap addresses; markets, underlying assets, oracle, reward distributor, and risk parameters are read from chain at runtime.
- Environment overrides are supported: `UNITUS_CONFLUX_CONTROLLER`, `UNITUS_CONFLUX_LENDING_DATA`.
- Native CFX uses the `iCFX` market whose `underlying()` is the zero address. Do not route native CFX through `iETH`.
- If preview returns `willSucceed: false` or warnings, do not execute the transaction.
- Borrow and withdraw execution is allowed only when preview returns `willSucceed: true` with no warnings and the user explicitly confirms.

### Contract Interactions

When user wants to call a smart contract function:

```bash
# Read (free, no gas)
node src/contract.js <chain> <contract_address> \
  "<function_signature>" [args...] --json

# Write (costs gas — confirm first)
node src/contract.js <chain> <contract_address> \
  "<function_signature>" [args...] --yes --json
```

Examples:
```bash
# Check USDC balance
node src/contract.js base \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "balanceOf(address)" 0xWALLET --json

# Approve token spending
node src/contract.js base \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  "approve(address,uint256)" 0xSPENDER 1000000 --yes --json
```

### Check for Updates

```bash
node src/check-update.js --json
```

If an update is available, inform the user and offer to run:
```bash
cd "$SKILL_DIR" && git pull && npm install
```

## Supported Chains

| Chain | Native Token | Use For |
|-------|-------------|---------|
| base | ETH | Cheapest fees — default for testing |
| conflux | CFX | Low fees, Conflux eSpace |
| ethereum | ETH | Mainnet, highest fees |
| polygon | POL | Low fees |
| arbitrum | ETH | Low fees |
| optimism | ETH | Low fees |

**Always recommend Base** for first-time users (lowest gas fees).

## Common Token Addresses

### Base

- **USDC:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **WETH:** `0x4200000000000000000000000000000000000006`

### Conflux eSpace

- **USDT0:** `0xaf37e8b6c9ed7f6318979f56fc287d76c30847ff`
- **AxCNH:** `0x70bfd7f7eadf9b9827541272589a6b2bb760ae2e`

### Ethereum

- **USDC:** `0xA0b86a33E6441b8a46a59DE4c4C5E8F5a6a7A8d0`
- **WETH:** `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

## Safety Rules

1. **Never execute transfers or swaps without user confirmation**
2. **Never expose the private key** from `~/.cfx-wallet.json`
3. **Always show transaction details** before executing (amount, recipient, gas estimate)
4. **Recommend Base** for testing and small amounts
5. **Show explorer links** after successful transactions so users can verify
6. If a command fails, show the error clearly and suggest fixes

## Error Handling

- **"No wallet found"** → Run `node src/setup.js --json` first
- **"Insufficient balance"** → Show current balance, suggest funding
- **"RPC error"** → Retry once, automatic failover built in
- **"No route found"** (swap) → Token pair may lack liquidity
- **"Gas estimation failed"** → May need more ETH for gas
