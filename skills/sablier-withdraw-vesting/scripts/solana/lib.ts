import { readFileSync } from "node:fs";
import "dotenv/config";
import {
  AccountRole,
  address,
  type Address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type KeyPairSigner,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
} from "@solana/kit";
import { BorshAccountsCoder, BorshInstructionCoder } from "@coral-xyz/anchor";
import { sablierLockupLinear } from "sablier/solana/releases/lockup/v0.1/idl";

const idl = sablierLockupLinear.SablierLockupLinearIDL;

export const SABLIER_LOCKUP_PROGRAM = address(
  "4EauRKrNErKfsR4XetEZJNmvACGHbHnHV4R5dvJuqupC",
);
export const CHAINLINK_PROGRAM = address(
  "HEvSKofvBgfaexv23kMabbYqxasxU3mQ4ibBMEmJWHny",
);
export const CHAINLINK_SOL_USD_FEED = address(
  "99B2bTijsU6f1GCT73HmdR7HCFFjGMBcPZY6jZ96ynrR",
);
export const TOKEN_PROGRAM = address(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
export const TOKEN_2022_PROGRAM = address(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
export const ASSOCIATED_TOKEN_PROGRAM = address(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const METAPLEX_METADATA_PROGRAM = address(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export const SOLSCAN_TX_URL = (signature: string) =>
  `https://solscan.io/tx/${signature}`;

export type Connections = {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  heliusApiKey: string;
};

export function loadConnections(): Connections {
  const key = process.env.HELIUS_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "HELIUS_API_KEY is not set. Copy .env.example to .env and fill it in.",
    );
  }
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${key}`;
  const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${key}`;
  return {
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
    heliusApiKey: key,
  };
}

export async function loadSigner(): Promise<KeyPairSigner> {
  const secret = process.env.SOLANA_SIGNER_SECRET?.trim();
  const path = process.env.SOLANA_SIGNER_KEYPAIR_PATH?.trim();

  if (secret) {
    const bytes = getBase58Encoder().encode(secret);
    if (bytes.length !== 64) {
      throw new Error(
        `SOLANA_SIGNER_SECRET decoded to ${bytes.length} bytes; expected 64 (full secret key).`,
      );
    }
    return createKeyPairSignerFromBytes(bytes as Uint8Array);
  }

  if (path) {
    const raw = readFileSync(path, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error(
        `Keypair at ${path} is not a 64-element JSON array of bytes.`,
      );
    }
    return createKeyPairSignerFromBytes(new Uint8Array(arr));
  }

  throw new Error(
    "No signer configured. Set SOLANA_SIGNER_SECRET (base58 secret key) or SOLANA_SIGNER_KEYPAIR_PATH (path to a Solana keypair JSON file) in .env.",
  );
}

const STREAM_DATA_SEED = new TextEncoder().encode("stream_data");
const TREASURY_SEED = new TextEncoder().encode("treasury");

export async function deriveStreamDataPda(nftMint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SABLIER_LOCKUP_PROGRAM,
    seeds: [STREAM_DATA_SEED, getAddressEncoder().encode(nftMint)],
  });
  return pda;
}

export async function deriveTreasuryPda(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SABLIER_LOCKUP_PROGRAM,
    seeds: [TREASURY_SEED],
  });
  return pda;
}

export async function deriveAssociatedTokenAddress(
  owner: Address,
  tokenProgram: Address,
  mint: Address,
): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)],
  });
  return pda;
}

export async function deriveMetaplexMetadataPda(mint: Address): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: METAPLEX_METADATA_PROGRAM,
    seeds: [
      new TextEncoder().encode("metadata"),
      enc.encode(METAPLEX_METADATA_PROGRAM),
      enc.encode(mint),
    ],
  });
  return pda;
}

export const accountsCoder = new BorshAccountsCoder(idl as never);
export const instructionCoder = new BorshInstructionCoder(idl as never);

export type StreamData = {
  amounts: {
    startUnlock: bigint;
    cliffUnlock: bigint;
    deposited: bigint;
    refunded: bigint;
    withdrawn: bigint;
  };
  depositedTokenMint: Address;
  bump: number;
  salt: bigint;
  isCancelable: boolean;
  isDepleted: boolean;
  timestamps: {
    cliff: bigint;
    end: bigint;
    start: bigint;
  };
  sender: Address;
  wasCanceled: boolean;
};

type Bnish = { toString(radix?: number): string };
type Pubkeyish = { toBase58(): string } | string;

function bnToBigInt(v: Bnish | bigint | number): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  return BigInt(v.toString());
}

function pubkeyToAddress(v: Pubkeyish): Address {
  return address(typeof v === "string" ? v : v.toBase58());
}

export function decodeStreamData(data: Buffer): StreamData | null {
  try {
    const decoded = accountsCoder.decode("StreamData", data) as {
      amounts: {
        start_unlock: Bnish;
        cliff_unlock: Bnish;
        deposited: Bnish;
        refunded: Bnish;
        withdrawn: Bnish;
      };
      deposited_token_mint: Pubkeyish;
      bump: number;
      salt: Bnish;
      is_cancelable: boolean;
      is_depleted: boolean;
      timestamps: { cliff: Bnish; end: Bnish; start: Bnish };
      sender: Pubkeyish;
      was_canceled: boolean;
    };
    return {
      amounts: {
        startUnlock: bnToBigInt(decoded.amounts.start_unlock),
        cliffUnlock: bnToBigInt(decoded.amounts.cliff_unlock),
        deposited: bnToBigInt(decoded.amounts.deposited),
        refunded: bnToBigInt(decoded.amounts.refunded),
        withdrawn: bnToBigInt(decoded.amounts.withdrawn),
      },
      depositedTokenMint: pubkeyToAddress(decoded.deposited_token_mint),
      bump: decoded.bump,
      salt: bnToBigInt(decoded.salt),
      isCancelable: decoded.is_cancelable,
      isDepleted: decoded.is_depleted,
      timestamps: {
        cliff: bnToBigInt(decoded.timestamps.cliff),
        end: bnToBigInt(decoded.timestamps.end),
        start: bnToBigInt(decoded.timestamps.start),
      },
      sender: pubkeyToAddress(decoded.sender),
      wasCanceled: decoded.was_canceled,
    };
  } catch {
    return null;
  }
}

export function computeWithdrawable(stream: StreamData, nowSeconds: bigint): bigint {
  if (stream.isDepleted) return 0n;
  const { amounts, timestamps } = stream;
  const deposited = amounts.deposited - amounts.refunded;

  let streamed: bigint;
  if (nowSeconds < timestamps.start) {
    streamed = 0n;
  } else if (stream.wasCanceled) {
    streamed = deposited;
  } else if (nowSeconds >= timestamps.end) {
    streamed = deposited;
  } else if (nowSeconds < timestamps.cliff) {
    streamed = amounts.startUnlock;
  } else {
    const elapsed = nowSeconds - timestamps.cliff;
    const span = timestamps.end - timestamps.cliff;
    const remainder = deposited - amounts.cliffUnlock;
    streamed = amounts.cliffUnlock + (remainder * elapsed) / span;
  }

  if (streamed <= amounts.withdrawn) return 0n;
  return streamed - amounts.withdrawn;
}

export function streamStatus(stream: StreamData, nowSeconds: bigint): string {
  if (stream.isDepleted) return "Depleted";
  if (stream.wasCanceled) return "Canceled";
  if (nowSeconds < stream.timestamps.start) return "Pending";
  if (nowSeconds >= stream.timestamps.end) return "Settled";
  return "Streaming";
}

export type MintInfo = {
  decimals: number;
  tokenProgram: Address;
};

export function decodeMintAccount(
  data: Buffer,
  tokenProgram: Address,
): MintInfo | null {
  if (data.length < 82) return null;
  return { decimals: data.readUInt8(44), tokenProgram };
}

export function formatTokenAmount(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  if (frac === 0n) return `${negative ? "-" : ""}${whole.toString()}`;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}.${fracStr}`;
}

export function formatUnixDate(seconds: bigint): string {
  if (seconds === 0n) return "—";
  return new Date(Number(seconds) * 1000)
    .toISOString()
    .slice(0, 10);
}

export function shortenAddress(a: Address | string): string {
  const s = typeof a === "string" ? a : (a as string);
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Queries the program's compile-time `WITHDRAWAL_FEE_USD` constant by simulating
 * the `withdrawal_fee_in_lamports` view instruction. Returns the fee the program
 * will charge for a withdraw at the current SOL/USD rate.
 *
 * If the constant is 0 (current mainnet state — fee is waived), this returns 0n.
 * One RPC call (simulateTransaction with `replaceRecentBlockhash`); no signature needed.
 */
export async function fetchWithdrawalFeeLamports(
  rpc: Rpc<SolanaRpcApi>,
  payer: Address,
): Promise<bigint> {
  const treasury = await deriveTreasuryPda();
  const ixData = instructionCoder.encode("withdrawal_fee_in_lamports", {});
  const viewIx = {
    programAddress: SABLIER_LOCKUP_PROGRAM,
    accounts: [
      { address: treasury, role: AccountRole.READONLY },
      { address: CHAINLINK_PROGRAM, role: AccountRole.READONLY },
      { address: CHAINLINK_SOL_USD_FEED, role: AccountRole.READONLY },
    ],
    data: new Uint8Array(ixData),
  };

  const placeholderBlockhash = {
    blockhash: blockhash("11111111111111111111111111111111"),
    lastValidBlockHeight: 0n,
  };

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(placeholderBlockhash, m),
    (m) => appendTransactionMessageInstruction(viewIx, m),
  );
  const compiled = compileTransaction(message);
  const wire = getBase64EncodedWireTransaction(compiled);

  const sim = await rpc
    .simulateTransaction(wire, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
    })
    .send();

  if (sim.value.err) {
    throw new Error(
      `withdrawal_fee_in_lamports simulation failed: ${JSON.stringify(sim.value.err)}`,
    );
  }
  const ret = sim.value.returnData;
  if (!ret) {
    // Older Anchor versions emit Program return via logs instead of returnData.
    return parseReturnFromLogs(sim.value.logs ?? []);
  }
  const tuple = ret.data as unknown as [string, string];
  const buf = Buffer.from(tuple[0], "base64");
  if (buf.length < 8) {
    throw new Error("Return data shorter than u64; cannot read fee.");
  }
  return buf.readBigUInt64LE(0);
}

function parseReturnFromLogs(logs: readonly string[]): bigint {
  const programIdStr = SABLIER_LOCKUP_PROGRAM as string;
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (!line) continue;
    const prefix = `Program return: ${programIdStr} `;
    if (line.startsWith(prefix)) {
      const buf = Buffer.from(line.slice(prefix.length), "base64");
      if (buf.length < 8) {
        throw new Error("Return-data log entry shorter than u64.");
      }
      return buf.readBigUInt64LE(0);
    }
  }
  throw new Error("No Program return data found in simulation logs.");
}
