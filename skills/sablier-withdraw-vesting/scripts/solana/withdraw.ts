import { parseArgs } from "node:util";
import {
  address,
  type Address,
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type IInstruction,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import {
  ASSOCIATED_TOKEN_PROGRAM,
  CHAINLINK_PROGRAM,
  CHAINLINK_SOL_USD_FEED,
  SABLIER_LOCKUP_PROGRAM,
  SYSTEM_PROGRAM,
  computeWithdrawable,
  decodeMintAccount,
  decodeStreamData,
  deriveAssociatedTokenAddress,
  deriveStreamDataPda,
  deriveTreasuryPda,
  fetchWithdrawalFeeLamports,
  formatTokenAmount,
  instructionCoder,
  loadConnections,
  loadSigner,
  type StreamData,
} from "./lib.ts";

const PRIORITY_MICRO_LAMPORTS = 40_000n;

function isBase58Pubkey(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

function scaleAmount(human: string, decimals: number): bigint {
  const trimmed = human.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`--amount must be a non-negative decimal, got ${human}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `--amount has ${frac.length} decimals but token allows only ${decimals}`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt((whole ?? "0") + padded);
}

function accountMeta(addr: Address, role: AccountRole) {
  return { address: addr, role };
}

function decodeBase64Data(raw: { data: unknown }): Buffer {
  const tuple = raw.data as [string, string];
  return Buffer.from(tuple[0], "base64");
}

function ataHoldsOne(rawAccount: { data: unknown } | null): boolean {
  if (!rawAccount) return false;
  const buf = decodeBase64Data(rawAccount);
  if (buf.length < 72) return false;
  return buf.readBigUInt64LE(64) === 1n;
}

async function main() {
  const { values } = parseArgs({
    options: {
      stream: { type: "string" },
      amount: { type: "string" },
      recipient: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.stream) {
    throw new Error("--stream <nft_mint> is required.");
  }
  if (!isBase58Pubkey(values.stream)) {
    throw new Error(`--stream is not a valid base58 mint: ${values.stream}`);
  }
  const nftMint = address(values.stream);

  let recipientOverride: Address | null = null;
  if (values.recipient) {
    if (!isBase58Pubkey(values.recipient)) {
      throw new Error(`--recipient is not a valid base58 pubkey: ${values.recipient}`);
    }
    recipientOverride = address(values.recipient);
  }

  const { rpc, rpcSubscriptions } = loadConnections();
  const signer = await loadSigner();
  const streamPda = await deriveStreamDataPda(nftMint);

  const round1 = await rpc
    .getMultipleAccounts([streamPda, nftMint], { encoding: "base64" })
    .send();

  const [streamRaw, nftMintRaw] = round1.value;
  if (!streamRaw) {
    throw new Error(`No StreamData found at ${streamPda}. Is ${nftMint} a Sablier stream NFT?`);
  }
  if (!nftMintRaw) throw new Error(`Stream NFT mint ${nftMint} does not exist.`);

  const stream = decodeStreamData(decodeBase64Data(streamRaw));
  if (!stream) {
    throw new Error("Failed to decode StreamData — IDL mismatch or wrong account.");
  }
  if (stream.isDepleted) {
    throw new Error("This stream is already depleted; nothing to withdraw.");
  }

  const nftTokenProgram = address(nftMintRaw.owner);

  // Live read of the program's WITHDRAWAL_FEE_USD constant via the
  // `withdrawal_fee_in_lamports` view ix. Returns 0 today (fee waived on mainnet);
  // would return a non-zero lamport amount if the team redeploys with a fee.
  const feeLamports = await fetchWithdrawalFeeLamports(rpc, signer.address);

  const depositedMint = stream.depositedTokenMint;
  const signerNftAta = await deriveAssociatedTokenAddress(
    signer.address,
    nftTokenProgram,
    nftMint,
  );

  const round2 = await rpc
    .getMultipleAccounts([depositedMint, signerNftAta], { encoding: "base64" })
    .send();
  const [depositedMintRaw, signerNftAtaRaw] = round2.value;
  if (!depositedMintRaw) throw new Error(`Deposited token mint ${depositedMint} not found.`);

  const depositedTokenProgram = address(depositedMintRaw.owner);
  const mintInfo = decodeMintAccount(
    decodeBase64Data(depositedMintRaw),
    depositedTokenProgram,
  );
  if (!mintInfo) throw new Error("Failed to decode deposited token mint.");

  const signerOwnsNft = ataHoldsOne(signerNftAtaRaw ?? null);
  if (!signerOwnsNft) {
    throw new Error(
      `Signer ${signer.address} does not own the stream NFT (${nftMint}). Only the current NFT holder can withdraw.`,
    );
  }
  if (recipientOverride && recipientOverride !== signer.address) {
    // signer == stream_recipient here (we just verified), so redirecting the payout is allowed
  }

  const withdrawalRecipient = recipientOverride ?? signer.address;
  const withdrawalRecipientAta = await deriveAssociatedTokenAddress(
    withdrawalRecipient,
    depositedTokenProgram,
    depositedMint,
  );
  const recipientNftAta = signerNftAta;
  const streamDataAta = await deriveAssociatedTokenAddress(
    streamPda,
    depositedTokenProgram,
    depositedMint,
  );
  const treasury = await deriveTreasuryPda();

  const ataInfo = await rpc
    .getAccountInfo(withdrawalRecipientAta, { encoding: "base64" })
    .send();
  const needsAta = ataInfo.value === null;

  const amountRaw = values.amount
    ? scaleAmount(values.amount, mintInfo.decimals)
    : null;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const previewWithdrawable = computeWithdrawable(stream, now);
  const previewAmount = amountRaw ?? previewWithdrawable;

  if (previewAmount === 0n) {
    throw new Error("Withdrawable amount is zero. Nothing to do.");
  }
  if (amountRaw !== null && amountRaw > previewWithdrawable) {
    throw new Error(
      `--amount (${formatTokenAmount(amountRaw, mintInfo.decimals)}) exceeds withdrawable (${formatTokenAmount(previewWithdrawable, mintInfo.decimals)}).`,
    );
  }

  printPreview({
    nftMint,
    stream,
    decimals: mintInfo.decimals,
    previewAmount,
    signer: signer.address,
    withdrawalRecipient,
    feeLamports,
  });

  const instructions: IInstruction[] = [
    getSetComputeUnitPriceInstruction({ microLamports: PRIORITY_MICRO_LAMPORTS }),
  ];

  if (needsAta) {
    instructions.push(
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: signer,
        owner: withdrawalRecipient,
        mint: depositedMint,
        tokenProgram: depositedTokenProgram,
      }),
    );
  }

  const ixData = amountRaw !== null
    ? instructionCoder.encode("withdraw", { amount: amountRaw })
    : instructionCoder.encode("withdraw_max", {});

  instructions.push({
    programAddress: SABLIER_LOCKUP_PROGRAM,
    accounts: [
      accountMeta(signer.address, AccountRole.WRITABLE_SIGNER),
      accountMeta(signer.address, AccountRole.READONLY),
      accountMeta(withdrawalRecipient, AccountRole.READONLY),
      accountMeta(withdrawalRecipientAta, AccountRole.WRITABLE),
      accountMeta(treasury, AccountRole.WRITABLE),
      accountMeta(depositedMint, AccountRole.READONLY),
      accountMeta(recipientNftAta, AccountRole.READONLY),
      accountMeta(streamPda, AccountRole.WRITABLE),
      accountMeta(streamDataAta, AccountRole.WRITABLE),
      accountMeta(nftMint, AccountRole.READONLY),
      accountMeta(ASSOCIATED_TOKEN_PROGRAM, AccountRole.READONLY),
      accountMeta(CHAINLINK_PROGRAM, AccountRole.READONLY),
      accountMeta(CHAINLINK_SOL_USD_FEED, AccountRole.READONLY),
      accountMeta(depositedTokenProgram, AccountRole.READONLY),
      accountMeta(nftTokenProgram, AccountRole.READONLY),
      accountMeta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data: new Uint8Array(ixData),
  });

  const { value: blockhashInfo } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhashInfo, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );

  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  if (values["dry-run"]) {
    process.stdout.write(
      `Dry run complete. Tx signature ${signature} was NOT broadcast. Remove --dry-run to send.\n`,
    );
    return;
  }

  const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
  await sendAndConfirm(signed, { commitment: "confirmed" });
  process.stdout.write(`Confirmed: https://solscan.io/tx/${signature}\n`);
}

function printPreview(args: {
  nftMint: Address;
  stream: StreamData;
  decimals: number;
  previewAmount: bigint;
  signer: Address;
  withdrawalRecipient: Address;
  feeLamports: bigint;
}) {
  const { nftMint, stream, decimals, previewAmount, signer, withdrawalRecipient, feeLamports } = args;
  const feeStr = feeLamports === 0n
    ? "0 SOL (waived by the program — WITHDRAWAL_FEE_USD is set to 0)"
    : `${formatTokenAmount(feeLamports, 9)} SOL (live quote from withdrawal_fee_in_lamports)`;
  process.stdout.write(
    [
      "",
      "Withdrawal preview",
      "------------------",
      `Stream NFT:           ${nftMint}`,
      `Token mint:           ${stream.depositedTokenMint}`,
      `Withdrawable amount:  ${formatTokenAmount(previewAmount, decimals)} (${previewAmount} raw)`,
      `Signer (pays fee):    ${signer}`,
      `Tokens go to:         ${withdrawalRecipient}`,
      `Protocol fee:         ${feeStr}`,
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
