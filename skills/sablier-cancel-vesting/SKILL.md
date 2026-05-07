---
name: sablier-cancel-vesting
disable-model-invocation: false
user-invocable: true
argument-hint: <chain_name> <wallet_address> <token_symbol>
description: This skill should be used when the user asks to "cancel a vesting stream", "cancel Sablier vesting", "stop vesting for X", "revoke a Sablier stream", "claw back unvested tokens", "refund unvested tokens", "kill a Sablier Lockup stream", or wants an agent to cancel one or more Sablier Lockup vesting streams as the stream sender on Ethereum or any EVM-compatible chain on their behalf.
---

# Sablier Vesting Stream Cancellation

## Overview

Cancel one or more Sablier Lockup vesting streams on the user's behalf as the stream sender. The skill discovers the user's sender-side streams through the Sablier indexer, drops non-cancelable and zero-refundable streams, and executes one `cancel(uint256)` transaction per selected stream on the resolved chain.

The function signature `cancel(uint256)` is unified across the full range of Lockup releases (v1.0 → v4.0), so the runbook does not dispatch on `version` for the call itself. The recipient still receives every token that has already vested at the moment of cancellation; only the unvested remainder returns to the sender.

This skill **charges no markup**. Cancellation is free at the protocol level — `cancel(uint256)` is non-payable on every Lockup version, so `MSG_VALUE = 0` always.

This skill is a coordinator for vesting cancellation and execution routing.

## Arguments

| Argument         | Description                                                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_name`     | EVM chain where the streams live (e.g. "Ethereum", "Base", "Polygon"). One chain per invocation.                                                      |
| `wallet_address` | The user's wallet. Must be the streams' sender — only senders can call `cancel`. The skill never surfaces streams where the wallet is not the sender. |
| `token_symbol`   | Token symbol to narrow the search (e.g. "USDC", "SABL"). If omitted, every token the wallet has an active sender-side stream in is shown.             |

## Workflow

### 1. Confirm product fit

1. Verify the user wants to cancel existing Sablier vesting streams as the sender.

2. If the user wants to **create** a vesting stream instead, route to `sablier-create-vesting`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-create-vesting
   ```

3. If the user wants to **withdraw** vested tokens (recipient action), route to `sablier-withdraw-vesting`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-withdraw-vesting
   ```

4. If the user wants to cancel a **Flow open-ended** stream instead of a vesting stream, route to `sablier-cancel-open-ended-stream`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-cancel-open-ended-stream
   ```

### 2. Check requested features

Stop and call out unsupported requests before selecting an execution path.

- **Cross-chain batching is not supported.** This skill cancels streams on a single chain per invocation. If the user has streams on multiple chains, run the skill again per chain.
- **One stream per transaction.** This skill does not use `cancelMultiple`. Selecting N streams produces N separate `cancel(uint256)` transactions and N wallet approvals — one per stream. This keeps each cancellation isolated: a revert on one stream never affects the others.
- **Sender-only access.** Only the stream's `sender` can call `cancel`. The runbook restricts the indexer query to streams where `sender == wallet`, so the wallet is always the authorized caller.
- **Non-cancelable streams cannot be canceled.** A stream created with `cancelable: false` reverts on `cancel(...)`. The runbook drops these at discovery via `isCancelable(streamId)` (Multicall3-batched). If every surfaced stream is non-cancelable, stop with the message: *"None of these vesting streams are cancelable — refunding is not possible. Cancellation was disabled at stream creation."*
- **Already-canceled or depleted streams cannot be canceled.** The indexer query filters `canceled: { _eq: false }` and `depleted: { _eq: false }`.
- **Withdrawing native tokens (ETH, POL, etc.) is not supported.** Sablier streams only hold ERC-20 tokens. If the user mentions "ETH from my stream", they most likely mean WETH — confirm the token symbol before proceeding.

### 3. Clarify the required inputs

Use the `AskUserQuestion` tool to fill any missing inputs. Ask only for what is missing — never re-ask for values the user already provided.

- **Wallet address.** A `0x`-prefixed EVM address — case is not enforced; the runbook lowercases it before querying the indexer. This is the sender that will sign each `cancel` transaction. Ask for this first — both chain and token can be inferred from the indexer once the wallet is known.
- **Chain name.** Optional. If the user does not know which chain, **do not** send them to an external UI — query the Sablier Streams indexer for every non-canceled, non-depleted stream where the wallet is the sender across all chains, collect the distinct `chainId` values, map them to chain names via the [Supported Chains](references/cli.md#supported-chains) table, and offer them as `AskUserQuestion` options. If exactly one chain has streams, auto-select it and tell the user. See [references/cli.md § Chain discovery](references/cli.md#chain-discovery).
- **Token symbol.** Optional. If the user does not know which token, query the indexer for every non-canceled, non-depleted stream on the resolved chain where the wallet is the sender, and offer the distinct token symbols as `AskUserQuestion` options (see [references/cli.md § Stream discovery](references/cli.md#stream-discovery)).

Do not guess or silently apply defaults for these parameters. Only proceed once all inputs are confirmed.

### 4. Validate chain support

1. Check whether the resolved chain is listed in the [Supported Chains](references/cli.md#supported-chains) table in the execution runbook.
2. If a chain surfaced by the indexer is not in the table, check [Sablier Lockup deployments](https://docs.sablier.com/guides/lockup/deployments) and ask the user for an RPC URL. If still unresolved, stop execution of this skill.

### 5. Route to execution

Hand off to [references/cli.md](references/cli.md) for stream discovery, multi-select, preview, confirmation, and per-stream broadcast. The discovery step pipes the indexer response through [scripts/filter-cancelable.sh](scripts/filter-cancelable.sh), which Multicall3-batches `isCancelable(streamId)` and `refundableAmountOf(streamId)` across every candidate into a single round trip — this drops non-cancelable streams, drops streams with nothing left to recover, and stamps `.refundable` (base-unit string) onto every survivor.

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
