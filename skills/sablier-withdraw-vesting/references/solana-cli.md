# Solana CLI Withdraw Execution

## Overview

This runbook withdraws unlocked tokens from a Sablier Lockup Linear (v0.1) stream on
**Solana mainnet-beta** on the user's behalf. It is the Solana counterpart to
[evm-cli.md](evm-cli.md) and is reached from [SKILL.md § 2](../SKILL.md) when
`chain_name = solana`.

**Scope constraints — do not deviate from these:**

- **Mainnet-beta only.** No devnet or testnet path exists. State this upfront when greeting the user. If they ask for devnet, refuse and tell them to use [solana.sablier.com](https://solana.sablier.com) directly.
- **One stream per invocation.** Solana's `withdraw` / `withdraw_max` instructions are single-stream; bundling multiple into one transaction quickly overruns Solana's 1232-byte transaction limit. If the user has multiple streams to drain, run this skill again per stream. No "withdraw all" affordance.
- **Signer must be the stream's current recipient (NFT owner).** The Anchor program rejects withdrawals where the signer does not hold the stream NFT. The script verifies this before building the transaction.
- **No defaults for sensitive paths.** All credentials come from `scripts/solana/.env` (template at `scripts/solana/.env.example`). Missing env → abort with a clear error.
- **No address case-folding.** Solana base58 pubkeys are case-sensitive; pass them through verbatim.

The skill charges no markup. The on-chain protocol fee is the program's
compile-time `WITHDRAWAL_FEE_USD` constant, converted to lamports at the live
Chainlink SOL/USD rate inside the program's handler. **It is currently set to 0
on mainnet — the fee is waived.** The script reads the live value via the
program's `withdrawal_fee_in_lamports` view instruction before previewing, so
future redeploys with a non-zero fee are picked up automatically.

## Execution Sequence

1. Run [CLI Prerequisites Check](#cli-prerequisites-check) and confirm `scripts/solana/.env` is populated.
2. Collect the **owner wallet** (base58 pubkey) and optionally the **deposited-token mint** (preferred over a symbol — see [Token argument](#token-argument)).
3. Run [Stream Discovery](#stream-discovery) — `list-streams.ts` emits a JSON list of withdrawable streams. Typical RPC budget: **4 calls with `--token <mint>`, 5 without** (2 token-account scans + 1 batched stream-PDA fetch + 1 batched deposited-mint fetch + 1 batched metadata fetch when symbol resolution is needed).
4. Render the [Preview & Pick One](#preview--pick-one) table and require the user to select a single stream by index.
5. Build, simulate, and broadcast the [Withdrawal](#withdrawal) transaction. Verify the [Receipt](#receipt).
6. On any error, surface the error and stop. Do not retry silently.

## Mandatory Guardrails

### CLI Prerequisites Check

Run from `skills/sablier-withdraw-vesting/scripts/solana/`:

```bash
# Verify Bun is on PATH (≥ v1.1). If absent, see https://bun.sh/.
bun --version

# Install dependencies.
bun install

# Confirm env is loaded. Both lines below must print non-empty values.
test -n "$HELIUS_API_KEY"             # set in .env
test -n "$SOLANA_SIGNER_SECRET" \
  || test -n "$SOLANA_SIGNER_KEYPAIR_PATH"
```

If `.env` is missing, copy the template and abort until the user fills it in:

```bash
cp .env.example .env
```

Required values:

- `HELIUS_API_KEY` — Helius RPC API key. Free tier is sufficient for this runbook.
- `SOLANA_SIGNER_SECRET` — base58-encoded 64-byte secret key. Most wallets (Phantom, Solflare, `solana-keygen`) can export this.
- **OR** `SOLANA_SIGNER_KEYPAIR_PATH` — absolute path to a Solana keypair JSON file (e.g. `/Users/you/wallets/dev.json`).

Do not write the secret into chat. Do not echo it into the terminal history. The script reads it via `dotenv` directly from `.env`.

### Signing Method (Mandatory)

This runbook signs with the locally loaded keypair (env-driven). There is no
browser-wallet handoff in v1. If the user explicitly needs a hardware-wallet or
browser-wallet signing flow, stop and direct them to
[solana.sablier.com](https://solana.sablier.com) to withdraw via Phantom/Solflare.

### Confirmation Rule (Mandatory)

Before calling `withdraw.ts` without `--dry-run`, render the
[Preview & Pick One](#preview--pick-one) table, restate the stream details and the
fee, and require an explicit `yes` from the user. Do not infer consent from
silence or from a prior approval of a different stream.

### Cluster Lock (Mandatory)

The script targets `https://mainnet.helius-rpc.com/`. There is no `--cluster`
flag, no devnet path, and no synthetic chain-ID handling. If the user mentions
devnet, stop and explain that this skill is mainnet-only.

## Intake & Planning Inputs

Collect the following via `AskUserQuestion` if not already provided. Ask only
for what is missing.

| Input              | Format                                     | Required | Default        |
| ------------------ | ------------------------------------------ | -------- | -------------- |
| `owner_wallet`     | Base58 pubkey, 32–44 chars, case-sensitive | Yes      | None           |
| `deposited_mint`   | Base58 mint address (preferred)            | No       | Skip filter    |
| `token_symbol`     | Uppercase symbol (e.g. `USDC`) — fallback  | No       | Skip filter    |
| `withdraw_amount`  | Decimal amount or `max`                    | No       | `max`          |
| `payout_recipient` | Base58 pubkey                              | No       | `owner_wallet` |

### Token argument

`list-streams.ts` accepts either:

- `--token <mint_address>` — **preferred**. Skips Token Metadata lookup entirely, saving one RPC call.
- `--token <symbol>` — fallback. Triggers metadata resolution for every unique mint among the user's candidate streams.

If the user knows their token's mint address (e.g. `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` for USDC), capture it directly. Otherwise treat the value as a symbol.

## Stream Discovery

```bash
cd skills/sablier-withdraw-vesting/scripts/solana

# Preferred: token specified as mint address (4 RPC calls)
bun run list-streams.ts \
  --owner <OWNER_WALLET> \
  --token <DEPOSITED_MINT> \
  --format json > /tmp/sablier-streams.json

# Fallback: no token filter, or symbol filter (5 RPC calls)
bun run list-streams.ts \
  --owner <OWNER_WALLET> \
  --format json > /tmp/sablier-streams.json
```

The JSON shape is:

```json
{
  "rpcCalls": 4,
  "streams": [
    {
      "nftMint": "<base58>",
      "streamDataPda": "<base58>",
      "depositedTokenMint": "<base58>",
      "depositedTokenSymbol": "USDC" | null,
      "decimals": 6,
      "withdrawableRaw": "1234567",
      "withdrawableHuman": "1.234567",
      "endTime": "2027-03-15",
      "status": "Streaming" | "Settled" | "Canceled" | "Pending",
      "sender": "<base58>",
      "isCancelable": true,
      "wasCanceled": false
    }
  ]
}
```

### What the script does internally

1. `getTokenAccountsByOwner(owner, programId=TOKEN_PROGRAM)` — 1 RPC.
2. `getTokenAccountsByOwner(owner, programId=TOKEN_2022_PROGRAM)` — 1 RPC (in parallel with #1).
3. Filter `tokenAmount == 1` locally to isolate NFT candidates.
4. Locally derive `stream_data` PDA `["stream_data", nft_mint]` under program `4EauRKrNErKfsR4XetEZJNmvACGHbHnHV4R5dvJuqupC` for each candidate.
5. `getMultipleAccounts(pdas)` — 1 RPC (chunked at 100). Non-existent PDAs are dropped; surviving ones are Sablier streams.
6. Anchor-decode `StreamData`. Compute `withdrawable` locally from `amounts.deposited`, `amounts.withdrawn`, `timestamps`, and `now`.
7. If `--token <mint>` was supplied, filter to streams matching that `depositedTokenMint` locally.
8. `getMultipleAccounts(unique_deposited_mints)` — 1 RPC (chunked). Decode mint accounts to recover decimals and the deposited-token program (SPL vs Token-2022).
9. If `--token <mint>` was **not** supplied, batch-resolve Token Metadata for the surviving unique mints — 1 RPC (Metaplex Metadata PDAs). Symbol falls back to a truncated mint when metadata is missing.

### Edge cases

- **Empty result.** Tell the user no withdrawable streams were found and stop. Do not try a wider search.
- **`rpcCalls > 6`.** Tells you the user has unusual token-account fan-out. Flag it; no action needed.
- **Helius 429.** Free tier rate limit. Wait 10s and retry; if persistent, advise the user to upgrade or set `HELIUS_API_KEY` to a paid key.

## Preview & Pick One

Render the streams as a markdown table for the user. Always sort by `endTime` ascending so streams closest to settlement appear first.

```
| #  | Token | Withdrawable | End date    | Status     | Stream NFT       |
| -- | ----- | ------------ | ----------- | ---------- | ---------------- |
|  1 | USDC  | 1,234.567890 | 2027-03-15  | Streaming  | 7xkA…91zP        |
|  2 | SABL  |   500.000000 | 2028-01-01  | Streaming  | 4Bm8…veQR        |
```

Ask the user to **pick exactly one row by index** via `AskUserQuestion`. Do not
offer "all of the above". Do not auto-select even when only one stream qualifies
— still require explicit confirmation.

After the user picks, ask whether to:

- withdraw the **full withdrawable amount** (default, uses `withdraw_max`), or
- withdraw a **specific amount** (uses `withdraw(amount)`).

Optionally ask whether to redirect the payout to a different wallet via
`--recipient`. State plainly: "the redirect is only allowed because you are the
stream's current recipient." If the user has been told elsewhere they can
withdraw on someone else's behalf, correct that — the program rejects it.

## Withdrawal

### Dry run first

Always simulate before broadcasting:

```bash
bun run withdraw.ts \
  --stream <NFT_MINT_FROM_TABLE> \
  --dry-run
```

A successful dry run prints a `Tx signature ... was NOT broadcast` line. If the
simulation surfaces an Anchor error, halt and decode the code — common ones:

| Anchor error                    | Likely cause                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `StreamDepleted`                | The stream was already drained between discovery and broadcast.                                           |
| `StreamNonexistent`             | NFT mint isn't a Sablier stream. Re-check `--stream`.                                                     |
| `WithdrawAmountZero`            | `--amount 0` or stream not yet started. Wait or omit `--amount`.                                          |
| `WithdrawAmountTooHigh`         | `--amount` exceeds withdrawable. Drop `--amount` or lower it.                                             |
| `WithdrawalAddressNotRecipient` | The signer is not the NFT holder. Confirm the env-loaded keypair matches the wallet in the preview table. |

### Broadcast

```bash
bun run withdraw.ts \
  --stream <NFT_MINT_FROM_TABLE>

# Or with a specific amount:
bun run withdraw.ts \
  --stream <NFT_MINT_FROM_TABLE> \
  --amount 100.5

# Or redirecting to another wallet (signer must be the NFT holder):
bun run withdraw.ts \
  --stream <NFT_MINT_FROM_TABLE> \
  --recipient <DESTINATION_PUBKEY>
```

The script:

1. Re-fetches stream data + NFT mint in 1 `getMultipleAccounts` call.
2. Calls the program's `withdrawal_fee_in_lamports` view via `simulateTransaction` (1 RPC) so the preview reflects the live `WITHDRAWAL_FEE_USD`. Today this returns `0`.
3. Reads deposited-mint + signer's NFT ATA in 1 more `getMultipleAccounts` call.
4. Pre-checks `withdrawal_recipient_ata` with `getAccountInfo` (1 call). If missing, prepends a `createAssociatedTokenAccountIdempotent` instruction.
5. Encodes the `withdraw` or `withdraw_max` instruction via Anchor's IDL coder. Composes the 16 accounts (signer, stream_recipient, withdrawal_recipient, withdrawal_recipient_ata, treasury, deposited_token_mint, recipient_stream_nft_ata, stream_data, stream_data_ata, stream_nft_mint, associated_token_program, chainlink_program, chainlink_sol_usd_feed, deposited_token_program, nft_token_program, system_program).
6. Prepends a `setComputeUnitPrice(40_000)` micro-lamports priority instruction.
7. Fetches latest blockhash, signs with the loaded keypair, sends, and waits for `confirmed` commitment.

The Sablier program transfers the fee from `signer` to `treasury` via a System Program CPI inside its handler — **do not** add a separate `SystemProgram.transfer` instruction. While `WITHDRAWAL_FEE_USD` is `0`, the CPI transfers zero lamports.

## Receipt

`withdraw.ts` prints the confirmed signature with a Solscan link:

```
Confirmed: https://solscan.io/tx/<signature>
```

Treat the run as complete when:

1. The script exits with code 0.
2. The Solscan page shows `Status: Success` and the `WithdrawFromLockupStream` event in the program logs.

If the script fails after `signTransactionMessageWithSigners` but before `Confirmed`, the transaction may still have landed — check Solscan with the printed signature before retrying. Retrying a confirmed transaction is a no-op (Solana de-duplicates), but the Anchor program will reject a redundant withdraw with `WithdrawAmountZero`.

## App Link

After a successful withdrawal, give the user the stream's page on the Sablier app:

```
https://solana.sablier.com/vesting/stream/<alias>
```

The alias is encoded into the stream's NFT metadata. If you cannot decode it,
just use the Solscan transaction link.

## Network Info

| Property              | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| Cluster               | `mainnet-beta`                                            |
| RPC                   | `https://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY` |
| WebSocket             | `wss://mainnet.helius-rpc.com/?api-key=$HELIUS_API_KEY`   |
| Sablier Lockup Linear | `4EauRKrNErKfsR4XetEZJNmvACGHbHnHV4R5dvJuqupC`            |
| Chainlink program     | `HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny`            |
| Chainlink SOL/USD     | `99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR`            |
| Stream data PDA seeds | `["stream_data", stream_nft_mint]`                        |
| Treasury PDA seeds    | `["treasury"]`                                            |

Devnet is intentionally absent — the runbook does not support it.

## Worked Example

A user holds a single USDC vesting stream and wants to withdraw everything that has unlocked so far.

```bash
cd skills/sablier-withdraw-vesting/scripts/solana
bun install

# Fill .env first (HELIUS_API_KEY + SOLANA_SIGNER_SECRET).

# 1) Discover streams (4 RPC calls — token specified as mint)
bun run list-streams.ts \
  --owner 7xkAZmrdj3Pkmu1nJiQg6dKBQpHs9o5gp8ChZH4G91zP \
  --token EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --format json

# 2) Pick the only result — its nftMint is BeQ8...vM7t.

# 3) Dry-run simulation (5 RPC calls)
bun run withdraw.ts --stream BeQ8...vM7t --dry-run

# 4) Confirm with the user, then broadcast (1 more RPC + WebSocket confirmation)
bun run withdraw.ts --stream BeQ8...vM7t
# → Confirmed: https://solscan.io/tx/<signature>
```

Total RPC calls for this happy path: **4 (discovery) + 6 (withdraw, including the
fee-view simulate) = 10**. All within Helius free tier.

## Errors & Troubleshooting

| Symptom                                                          | Diagnosis                                                                                              | Fix                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `HELIUS_API_KEY is not set`                                      | `.env` missing or empty key                                                                            | `cp .env.example .env` and fill it in                   |
| `No signer configured`                                           | Neither `SOLANA_SIGNER_SECRET` nor `SOLANA_SIGNER_KEYPAIR_PATH` set                                    | Set one in `.env`                                       |
| `SOLANA_SIGNER_SECRET decoded to N bytes; expected 64`           | The base58 value isn't a 64-byte secret key (probably a 32-byte seed or public key)                    | Export the full 64-byte secret key from your wallet     |
| `No StreamData found at ...`                                     | The `--stream` mint isn't a Sablier-issued stream NFT                                                  | Re-run `list-streams.ts` and pick a row from its output |
| `Signer ... does not own the stream NFT`                         | The env-loaded keypair is not the stream's current recipient                                           | Use the keypair that owns the NFT, or stop              |
| `--recipient is only allowed when the signer is the stream's...` | Same root cause: signer must be the original recipient                                                 | Drop `--recipient` and withdraw to the signer's own ATA |
| Helius `429`                                                     | Free-tier rate limit                                                                                   | Wait 10s; if persistent, use a paid `HELIUS_API_KEY`    |
| `Simulation failed: ... AnchorError ...`                         | Program rejected the tx. The error code reveals the cause (see [Withdrawal § Dry run](#dry-run-first)) | Adjust args per the table; do not loop-retry            |
