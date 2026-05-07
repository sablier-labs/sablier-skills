---
name: sablier-withdraw-open-ended-stream
disable-model-invocation: false
user-invocable: true
argument-hint: <chain_name> <wallet_address> <token_symbol>
description: This skill should be used when the user asks to "withdraw flow stream", "withdraw from Sablier Flow", "claim flow payment", "claim from Sablier Flow", "drain my flow streams", "withdraw all my Sablier Flow streams", "withdraw from open-ended stream", "claim open-ended stream", or wants an agent to withdraw available tokens from one or more Sablier Flow open-ended payment streams on Ethereum or any EVM-compatible chain on their behalf. Supports batching across multiple streams on a single chain.
---

# Sablier Flow Stream Withdrawal

## Overview

Withdraw available tokens from one or more Sablier Flow open-ended payment streams on the user's behalf. The skill discovers the user's streams through the Sablier indexer, lets the user pick any subset (default: all eligible), and executes one `batch(bytes[])` transaction per `SablierFlow` contract on the selected chain.

Sablier Flow exposes two per-stream withdraw entrypoints (`flow/src/interfaces/ISablierFlow.sol:497-531`):

- `withdraw(uint256 streamId, address to, uint128 amount)` — explicit-amount withdrawal.
- `withdrawMax(uint256 streamId, address to) returns (uint128)` — drains the full currently-withdrawable balance.

Batching is provided by the inherited `Batch.batch(bytes[]) payable` (`SablierFlow.sol:13,39`; `@sablier/evm-utils/src/Batch.sol`). `batch` `delegatecall`s every entry against `address(this)`, so `msg.sender` and `msg.value` are reused across all sub-calls. Each sub-call can target a different stream, amount, and `to` address. **The batch is all-or-nothing**: any sub-call revert bubbles up and reverts the whole transaction. There is no per-stream skip event analogous to Lockup's `InvalidWithdrawalInWithdrawMultiple`.

This skill **charges no markup**. The only fee paid is the on-chain protocol fee (`calculateMinFeeWei`) set by the comptroller; it may be `0`. Because `batch` delegatecalls and reuses `msg.value`, the required `msg.value` is `max(calculateMinFeeWei across the batch)`, not the sum.

This skill is a coordinator for Flow withdrawal and execution routing.

## Arguments

| Argument         | Description                                                                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_name`     | EVM chain where the streams live (e.g. "Ethereum", "Base", "Polygon"). One chain per invocation.                                                                                                          |
| `wallet_address` | The user's wallet. Must be the streams' recipient (NFT owner) or an approved third party — the skill never surfaces sender-only streams, since the non-recipient path is restricted to `to == recipient`. |
| `token_symbol`   | Token symbol to narrow the search (e.g. "USDC", "SABL"). If omitted, every token the wallet has an active stream in is shown.                                                                             |

## Workflow

### 1. Confirm product fit

1. Verify the user wants to withdraw from existing Sablier Flow open-ended streams.

2. If the user wants to **create** a Flow stream instead, route to `sablier-create-open-ended-stream`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-create-open-ended-stream
   ```

3. If the user describes vesting, cliffs, tranches, or a fixed end date, route to `sablier-withdraw-vesting`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-withdraw-vesting
   ```

### 2. Check requested features

Stop and call out unsupported requests before selecting an execution path.

- **Cross-chain batching is not supported.** This skill batches across all eligible streams on a single chain per invocation. If the user has streams on multiple chains, run the skill again per chain.
- **Default is `withdrawMax` for every selected stream** — each selected stream is withdrawn at its full currently-available balance (`withdrawableAmountOf`). Partial withdrawals are an opt-in: ask the user to select a single stream and supply an amount, then the runbook routes that one stream through `withdraw(uint256,address,uint128)` instead of `withdrawMax`. The bulk path always drains the full available amount per stream.
- **Access-control rule (single, no version dispatch)** — `msg.sender` must be the stream's recipient (the NFT owner) or an ERC-721-approved third party, **or** `to == recipient`. The skill defaults to `to = OWNER` (the connected wallet) and only surfaces streams where the wallet is the recipient or has approval, so this rule is auto-satisfied. If a non-recipient caller wants to redirect tokens elsewhere, it cannot — Flow only allows a non-recipient caller when `to == recipient` (`SablierFlow.sol:1001`).
- **Voided streams cannot withdraw.** A `Flow.Status.VOIDED` stream is not eligible — the contract reverts on `_withdraw`. The runbook re-checks `statusOf(streamId) != VOIDED` for every selected stream right before broadcast because `batch` is all-or-nothing: a single voided stream taints the whole group. See [references/cli.md § Preflight Checks](references/cli.md#preflight-checks).
- **Withdrawing native tokens (ETH, POL, etc.) is not supported.** Sablier Flow streams only hold ERC-20 tokens. If the user mentions "ETH from my stream", they most likely mean WETH — confirm the token symbol before proceeding.
- **Tokens with more than 18 decimals are not supported by Flow.** This is a contract-level invariant; no eligible stream can exceed it.

### 3. Clarify the required inputs

Use the `AskUserQuestion` tool to fill any missing inputs. Ask only for what is missing — never re-ask for values the user already provided.

- **Wallet address.** A `0x`-prefixed EVM address — case is not enforced; the runbook lowercases it before querying the indexer. This is the address that will sign the withdraw transactions. Ask for this first — both chain and token can be inferred from the indexer once the wallet is known.
- **Chain name.** Optional. If the user does not know which chain, **do not** send them to an external UI — query the Sablier Streams indexer for every non-voided Flow stream where the wallet is the recipient across all chains, collect the distinct `chainId` values, map them to chain names via the [Supported Chains](references/cli.md#supported-chains) table, and offer them as `AskUserQuestion` options. If exactly one chain has streams, auto-select it and tell the user. See [references/cli.md § Chain discovery](references/cli.md#chain-discovery).
- **Token symbol.** Optional. If the user does not know which token, query the indexer for every non-voided Flow stream on the resolved chain where the wallet is the recipient, and offer the distinct token symbols as `AskUserQuestion` options (see [references/cli.md § Stream discovery](references/cli.md#stream-discovery)).
- **Withdrawal address (`to`)**. Optional. Default is the recipient itself. Flow lets the recipient (or an approved operator) redirect tokens to any address by passing a different `to`; non-recipient callers can only pass `to == recipient`. Only ask if the user explicitly mentions sending withdrawn tokens elsewhere.

Do not guess or silently apply defaults for these parameters. Only proceed once all inputs are confirmed.

### 4. Validate chain support

1. Check whether the resolved chain is listed in the [Supported Chains](references/cli.md#supported-chains) table in the execution runbook.
2. If a chain surfaced by the indexer is not in the table, check [Sablier Flow deployments](https://docs.sablier.com/guides/flow/deployments) and ask the user for an RPC URL. If still unresolved, stop execution of this skill.

### 5. Route to execution

Hand off to [references/cli.md](references/cli.md) for stream discovery, multi-select, per-contract grouping, preview, confirmation, and per-group broadcast. The discovery step pipes the indexer response through [scripts/filter-withdrawable.sh](scripts/filter-withdrawable.sh), which batches `withdrawableAmountOf` across every candidate into a single Multicall3 call — this collapses `N` RPC round trips into one and avoids presenting the user streams with nothing currently available.

## Resources

- [Sablier Documentation](https://docs.sablier.com/llms.txt)
- [EVM Flow Deployments](https://docs.sablier.com/guides/flow/deployments.md)
- [Sablier Indexer API](https://docs.sablier.com/api/streams/indexers.md)
- [Sablier GraphQL Schema](https://docs.sablier.com/api/streams/graphql/schema.md)
- [Sablier Indexers Repo](https://github.com/sablier-labs/indexers)
- [Sablier Flow Monorepo](https://github.com/sablier-labs/flow)
- [Sablier Flow CHANGELOG](https://github.com/sablier-labs/flow/blob/main/CHANGELOG.md)

## Support

If you encounter any issues or unexpected errors with this skill, please file an issue at
[sablier-labs/sablier-skills](https://github.com/sablier-labs/sablier-skills/issues).
