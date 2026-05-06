---
name: sablier-withdraw-vesting
disable-model-invocation: false
user-invocable: true
argument-hint: <chain_name> <wallet_address> <token_symbol>
description: This skill should be used when the user asks to "withdraw vested tokens", "withdraw from Sablier vesting", "withdraw all my Sablier streams", "claim everything", "claim all unlocked tokens", "drain my vesting streams", "claim from Sablier", or wants an agent to withdraw unlocked tokens from one or more Sablier Lockup vesting streams on Ethereum or any EVM-compatible chain on their behalf. Supports batching across multiple streams on a single chain.
---

# Sablier Vesting Stream Withdrawal

## Overview

Withdraw unlocked tokens from one or more Sablier Lockup vesting streams on the user's behalf. The skill discovers the user's streams through the Sablier indexer, lets the user pick any subset (default: all eligible), and executes one `withdrawMultiple` transaction per Lockup contract on the selected chain.

This skill supports the full range of Lockup releases (v1.0 → v4.0). The `withdrawMultiple` signature changes once at v1.2.0 — the runbook dispatches on `version` to call the right ABI:

- `v1.0`, `v1.1` — `withdrawMultiple(uint256[] streamIds, address to, uint128[] amounts)` (non-payable, single shared `to`).
- `v1.2`+ — `withdrawMultiple(uint256[] streamIds, uint128[] amounts)` (each stream withdraws to its own recipient).
- `v2.0`+ — same signature as v1.2 but `payable`; per-stream failures emit `InvalidWithdrawalInWithdrawMultiple` instead of reverting the whole batch.
- `v3.0`+ — `payable`; the protocol comptroller may set a non-zero minimum fee (`calculateMinFeeWei`). The batch passes a single `msg.value` because internally `withdrawMultiple` `delegatecall`s into `withdraw`, preserving `msg.value` across iterations — so the required `msg.value` is `max(calculateMinFeeWei across the batch)`, not the sum.

This skill **charges no markup**. The only fee paid is the on-chain protocol fee (`calculateMinFeeWei`) on v3.0+ Lockups, set by the comptroller. It may be `0`. Earlier versions are non-payable and incur no fee at all.

This skill is a coordinator for vesting withdrawal and execution routing.

## Arguments

| Argument         | Description                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_name`     | EVM chain where the streams live (e.g. "Ethereum", "Base", "Polygon"). One chain per invocation.                                                                       |
| `wallet_address` | The user's wallet. Must be the streams' recipient — the skill never surfaces sender-only streams, since withdrawing on those pushes tokens to the recipient, not to the caller. |
| `token_symbol`   | Token symbol to narrow the search (e.g. "USDC", "SABL"). If omitted, every token the wallet has an active stream in is shown.                                          |

## Workflow

### 1. Confirm product fit

1. Verify the user wants to withdraw from existing Sablier vesting streams.
2. If the user wants to **create** a vesting stream instead, route to `sablier-create-vesting`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-create-vesting
   ```

### 2. Check requested features

Stop and call out unsupported requests before selecting an execution path.

- **Cross-chain batching is not supported.** This skill batches across all eligible streams on a single chain per invocation. If the user has streams on multiple chains, run the skill again per chain.
- **Custom per-stream amounts are not supported in batch mode.** Each selected stream is withdrawn at its full currently-unlocked balance (`withdrawableAmountOf`). If the user wants a partial withdrawal of a single stream, they should select only that one stream and ask for a partial amount — but the batch flow itself always drains the full unlocked amount for every selected stream.
- **Access-control rules vary by Lockup version** — the runbook enforces them per Lockup contract group:
  - **v1.0 / v1.1** — only the stream's `sender`, `recipient`, or an approved operator can call `withdrawMultiple`. The single shared `to` parameter must equal `recipient` if the caller is `sender`. Because this skill only surfaces streams where the wallet is the `recipient`, this case is auto-satisfied.
  - **v1.2 onward** — anyone can call `withdrawMultiple`; tokens always flow to each stream's own `recipient`.
- **Withdrawing native tokens (ETH, POL, etc.) is not supported.** Sablier streams only hold ERC-20 tokens. If the user mentions "ETH from my stream", they most likely mean WETH — confirm the token symbol before proceeding.

### 3. Clarify the required inputs

Use the `AskUserQuestion` tool to fill any missing inputs. Ask only for what is missing — never re-ask for values the user already provided.

- **Wallet address.** A `0x`-prefixed EVM address — case is not enforced; the runbook lowercases it before querying the indexer. This is the address that will sign the withdraw transactions. Ask for this first — both chain and token can be inferred from the indexer once the wallet is known.
- **Chain name.** Optional. If the user does not know which chain, **do not** send them to an external UI — query the Sablier Streams indexer for every non-depleted stream where the wallet is the recipient across all chains, collect the distinct `chainId` values, map them to chain names via the [Supported Chains](references/cli.md#supported-chains) table, and offer them as `AskUserQuestion` options. If exactly one chain has streams, auto-select it and tell the user. See [references/cli.md § Chain discovery](references/cli.md#chain-discovery).
- **Token symbol.** Optional. If the user does not know which token, query the indexer for every non-depleted stream on the resolved chain where the wallet is the recipient, and offer the distinct token symbols as `AskUserQuestion` options (see [references/cli.md § Stream discovery](references/cli.md#stream-discovery)).

Do not guess or silently apply defaults for these parameters. Only proceed once all inputs are confirmed.

### 4. Validate chain support

1. Check whether the resolved chain is listed in the [Supported Chains](references/cli.md#supported-chains) table in the execution runbook.
2. If a chain surfaced by the indexer is not in the table, check [Sablier Lockup deployments](https://docs.sablier.com/guides/lockup/deployments) and ask the user for an RPC URL. If still unresolved, stop execution of this skill.

### 5. Route to execution

Hand off to [references/cli.md](references/cli.md) for stream discovery, multi-select, per-contract grouping, preview, confirmation, and per-group broadcast. The discovery step pipes the indexer response through [scripts/filter-withdrawable.sh](scripts/filter-withdrawable.sh), which batches `withdrawableAmountOf` across every candidate into a single Multicall3 call — this collapses `N` RPC round trips into one and avoids presenting the user streams with nothing currently unlocked.

## Resources

- [Sablier Documentation](https://docs.sablier.com/llms.txt)
- [EVM Lockup Deployments](https://docs.sablier.com/guides/lockup/deployments.md)
- [Sablier Indexer API](https://docs.sablier.com/api/streams/indexers.md)
- [Sablier GraphQL Schema](https://docs.sablier.com/api/streams/graphql/schema.md)
- [Sablier Indexers Repo](https://github.com/sablier-labs/indexers)
- [Sablier EVM Monorepo](https://github.com/sablier-labs/lockup)

## Support

If you encounter any issues or unexpected errors with this skill, please file an issue at
[sablier-labs/sablier-skills](https://github.com/sablier-labs/sablier-skills/issues).
