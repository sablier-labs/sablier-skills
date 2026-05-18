---
name: sablier-withdraw-vesting
disable-model-invocation: false
user-invocable: true
argument-hint: <chain_name | "solana"> <wallet_address> <token_symbol_or_mint>
description: This skill should be used when the user asks to "withdraw vested tokens", "withdraw from Sablier vesting", "withdraw all my Sablier streams", "claim everything", "claim all unlocked tokens", "drain my vesting streams", "claim from Sablier", or wants an agent to withdraw unlocked tokens from one or more Sablier Lockup vesting streams on their behalf. Supports EVM chains (batched withdrawal across multiple streams on a single chain via `withdrawMultiple`) and Solana mainnet-beta (single-stream withdrawals from Lockup Linear v0.1).
---

# Sablier Vesting Stream Withdrawal

## Overview

Withdraw unlocked tokens from Sablier Lockup vesting streams on the user's behalf.

Supported protocols:

- **EVM chains** — full range of Lockup releases (v1.0 → v4.0). Batched withdrawal across all eligible streams on a single chain per invocation via `withdrawMultiple`.
- **Solana mainnet-beta** — Sablier Lockup Linear v0.1. One stream withdrawn per invocation; re-run the skill for additional streams.

This skill **charges no markup**. The only fees paid are on-chain protocol fees, set by the Lockup comptroller on EVM v3.0+ (may be zero on earlier versions) or the Sablier program on Solana (approx. 1 USD in SOL, but might have been reset to 0 USD onchain, computed via Chainlink).

This skill is a coordinator for vesting withdrawal and execution routing.

## Arguments

| Argument         | Description                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chain_name`     | Where the streams live. Either `solana` (Solana mainnet-beta) or an EVM chain name (e.g. "Ethereum", "Base", "Polygon"). One chain per invocation.                       |
| `wallet_address` | The recipient wallet. EVM: 0x-prefixed address. Solana: base58 pubkey. The skill never surfaces sender-only streams — withdrawing those pushes tokens to the recipient.  |
| `token`          | Optional narrowing. EVM accepts a token symbol (e.g. "USDC"). Solana accepts the deposited-token **mint address** (preferred — saves RPC calls) or a symbol as fallback. |

## Workflow

### 1. Confirm product fit

1. Verify the user wants to withdraw from existing Sablier vesting streams.

2. If the user wants to **create** a vesting stream instead, route to `sablier-create-vesting`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-create-vesting
   ```

### 2. Route by chain

| Chain argument                              | Runbook                                              |
| ------------------------------------------- | ---------------------------------------------------- |
| `solana`                                    | [references/solana-cli.md](references/solana-cli.md) |
| Any EVM chain name, or `chain_name` omitted | [references/evm-cli.md](references/evm-cli.md)       |

Stop reading this file after picking a row. The selected runbook owns prerequisites, input collection, discovery, fees, preview, broadcast, and receipt. Do not interleave instructions across runbooks — each is self-contained.

## Resources

- [Sablier Documentation](https://docs.sablier.com/llms.txt)
- [EVM Lockup Deployments](https://docs.sablier.com/guides/lockup/deployments.md)
- [Sablier Indexer API](https://docs.sablier.com/api/streams/indexers.md)
- [Sablier EVM Monorepo](https://github.com/sablier-labs/lockup)
- [Sablier Solana app](https://solana.sablier.com)

## Support

If you encounter any issues or unexpected errors with this skill, please file an issue at
[sablier-labs/sablier-skills](https://github.com/sablier-labs/sablier-skills/issues).
