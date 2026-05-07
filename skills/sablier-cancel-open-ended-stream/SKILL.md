---
name: sablier-cancel-open-ended-stream
disable-model-invocation: false
user-invocable: true
argument-hint: <chain_name> <wallet_address> <token_symbol>
description: This skill should be used when the user asks to "cancel a Flow stream", "void a Sablier Flow stream", "stop streaming to X", "refund my Flow deposit", "kill a Sablier Flow payment", "claw back unstreamed funds", "stop a Sablier open-ended stream", or wants an agent to cancel one or more Sablier Flow open-ended payment streams (void + refund where applicable) on Ethereum or any EVM-compatible chain on their behalf.
---

# Sablier Flow Stream Cancellation

## Overview

Cancel one or more Sablier Flow open-ended payment streams on the user's behalf. The skill discovers the user's streams through the Sablier indexer where the wallet is **sender or recipient**, drops already-voided streams, and executes one `batch(bytes[])` transaction per selected stream that splices the appropriate sub-calls atomically:

- **Sender (or sender + recipient) with `refundable > 0`** → `[refundMax(streamId, sender), void(streamId)]`. The sender recovers the unstreamed deposit and the stream is permanently stopped in the same transaction.
- **Sender (or sender + recipient) with `refundable == 0`** → `[void(streamId)]`. Inform the user nothing is left to refund — the stream will be voided but no funds will be returned.
- **Recipient-only** → `[void(streamId)]`. Inform the user that as the recipient, they can void the stream but only the sender can refund unstreamed funds.

The skill always uses `batch(bytes[])` as the entrypoint so refund + void run atomically per stream. When the batch contains a single sub-call (`void` only), the runbook MAY call `void(uint256)` directly instead of wrapping in `batch` — this is a small gas optimization, flagged in the runbook.

This skill **charges no markup**. Both `void(uint256)` and `refund(streamId,…)` are free at the protocol level — `MSG_VALUE = 0` always.

This skill is a coordinator for Flow cancellation and execution routing.

## Arguments

| Argument         | Description                                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_name`     | EVM chain where the streams live (e.g. "Ethereum", "Base", "Polygon"). One chain per invocation.                                                                                    |
| `wallet_address` | The user's wallet. May be the stream's sender (refund + void), the recipient (void only), or both. The skill surfaces every non-voided stream where `wallet ∈ {sender, recipient}`. |
| `token_symbol`   | Token symbol to narrow the search (e.g. "USDC", "SABL"). If omitted, every token the wallet has an active stream in is shown.                                                       |

## Workflow

### 1. Confirm product fit

1. Verify the user wants to cancel existing Sablier Flow open-ended streams.

2. If the user wants to **create** a Flow stream instead, route to `sablier-create-open-ended-stream`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-create-open-ended-stream
   ```

3. If the user wants to **withdraw** available tokens from a Flow stream (recipient action), route to `sablier-withdraw-open-ended-stream`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-withdraw-open-ended-stream
   ```

4. If the user wants to cancel a **vesting** stream instead of a Flow stream, route to `sablier-cancel-vesting`. If that skill is unavailable, recommend installing it with:

   ```bash
   npx skills add sablier-labs/sablier-skills --skill sablier-cancel-vesting
   ```

### 2. Check requested features

Stop and call out unsupported requests before selecting an execution path.

- **Cross-chain batching is not supported.** This skill cancels streams on a single chain per invocation. If the user has streams on multiple chains, run the skill again per chain.
- **One stream per transaction.** Each selected stream gets its own atomic `batch(bytes[])` transaction combining the required sub-calls (refund + void, or just void). Selecting N streams produces N transactions and N wallet approvals — one per stream. This keeps each cancellation isolated: a revert on one stream never affects the others.
- **Access control:**
  - `void(streamId)` — callable by the sender, the recipient, or an ERC-721-approved third party.
  - `refund(streamId, amount)` and `refundMax(streamId)` — sender-only.
  - The runbook detects each stream's `caller_role` (`sender` / `recipient` / `both`) and adjusts the batch sub-calls accordingly.
- **Already-voided streams cannot be re-voided.** A `Flow.Status.VOIDED` stream reverts on `_runtimeStatusOf`/`_void`. Discovery uses the indexer's `voided: false` filter; the runbook re-checks `statusOf(streamId)` per stream right before broadcast (mirrors the withdraw-flow precheck).
- **Refund availability.** If `refundableAmountOf(streamId) == 0`, only `void` runs — tell the user *"Nothing is left to refund. The stream will be voided (stopped) but no funds will be returned."* This applies to both sender callers (no unstreamed balance) and recipient callers (refund is sender-only).
- **Withdrawing native tokens (ETH, POL, etc.) is not supported.** Sablier Flow streams only hold ERC-20 tokens. If the user mentions "ETH from my stream", they most likely mean WETH — confirm the token symbol before proceeding.
- **Tokens with more than 18 decimals are not supported by Flow.** This is a contract-level invariant; no eligible stream can exceed it.

### 3. Clarify the required inputs

Use the `AskUserQuestion` tool to fill any missing inputs. Ask only for what is missing — never re-ask for values the user already provided.

- **Wallet address.** A `0x`-prefixed EVM address — case is not enforced; the runbook lowercases it before querying the indexer. This is the address that will sign each cancel transaction. Ask for this first — both chain and token can be inferred from the indexer once the wallet is known.
- **Chain name.** Optional. If the user does not know which chain, **do not** send them to an external UI — query the Sablier Streams indexer for every non-voided Flow stream where the wallet is the sender or the recipient across all chains, collect the distinct `chainId` values, map them to chain names via the [Supported Chains](references/cli.md#supported-chains) table, and offer them as `AskUserQuestion` options. If exactly one chain has streams, auto-select it and tell the user. See [references/cli.md § Chain discovery](references/cli.md#chain-discovery).
- **Token symbol.** Optional. If the user does not know which token, query the indexer for every non-voided Flow stream on the resolved chain where the wallet is the sender or the recipient, and offer the distinct token symbols as `AskUserQuestion` options (see [references/cli.md § Stream discovery](references/cli.md#stream-discovery)).

There is **no `to` parameter** — refunds always go to the sender, that is hard-wired in the contract.

Do not guess or silently apply defaults for these parameters. Only proceed once all inputs are confirmed.

### 4. Validate chain support

1. Check whether the resolved chain is listed in the [Supported Chains](references/cli.md#supported-chains) table in the execution runbook.
2. If a chain surfaced by the indexer is not in the table, check [Sablier Flow deployments](https://docs.sablier.com/guides/flow/deployments) and ask the user for an RPC URL. If still unresolved, stop execution of this skill.

### 5. Route to execution

Hand off to [references/cli.md](references/cli.md) for stream discovery, multi-select, preview, confirmation, and per-stream broadcast. The discovery step pipes the indexer response through [scripts/filter-cancelable.sh](scripts/filter-cancelable.sh), which Multicall3-batches `statusOf(streamId)` and `refundableAmountOf(streamId)` across every candidate into a single round trip — this drops voided streams and stamps `.refundable` (base-unit string) and `.status` onto every survivor.

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
