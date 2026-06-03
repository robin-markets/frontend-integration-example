// Wallet detection. A Polymarket user controls one of two on-chain accounts that hold their CT
// tokens / Robin vault shares: the newer **DepositWallet** (every fresh Polymarket account) or the
// legacy **Gnosis Safe proxy**. Detect which is deployed for the connected EOA and act AS that
// address for every deposit/withdraw.
//
//   - safe          → submit via Safe.execTransaction (see deposit.ts / withdraw.ts).
//   - deposit-wallet → submit via the Polymarket relayer's executeDepositWalletBatch, and you MUST
//                      use the push-deposit flow (deposit-push.ts) — the relayer blocks `approve`.

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import Safe from "@safe-global/protocol-kit";
import { RelayClient } from "@polymarket/builder-relayer-client";
import { ADDR } from "./shared.js";
import { safeProxyFactoryAbi } from "./abis.js";
import {
  BuilderApiKeyCreds,
  BuilderConfig,
} from "@polymarket/builder-signing-sdk";

const BATCH_DEADLINE_SECONDS = 1800;
const RELAYER_URL = "https://relayer-v2.polymarket.com";

// ============ viem clients ============

const PK = process.env.EOA_PRIVATE_KEY;
if (!PK) throw new Error("EOA_PRIVATE_KEY missing in .env");
export const account = privateKeyToAccount(PK as `0x${string}`);

export const publicClient = createPublicClient({
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL || "https://polygon.drpc.org"),
});

export const walletClient = createWalletClient({
  account,
  chain: polygon,
  transport: http(process.env.POLYGON_RPC_URL || "https://polygon.drpc.org"),
});

export async function computeProxyAddress(eoa: Address): Promise<Address> {
  return (await publicClient.readContract({
    address: ADDR.SAFE_PROXY_FACTORY,
    abi: safeProxyFactoryAbi,
    functionName: "computeProxyAddress",
    args: [eoa],
  })) as Address;
}

// One client for DepositWallet derivation, deployment checks, and batch execution. The viem
// walletClient is the EOA signer;
// Polymarket Builder credentials can be created here: https://polymarket.com/de/settings?tab=relayer-api-keys
const builderCreds: BuilderApiKeyCreds = {
  key: process.env.POLY_BUILDER_API_KEY!,
  secret: process.env.POLY_BUILDER_SECRET!,
  passphrase: process.env.POLY_BUILDER_PASSPHRASE!,
};
const hasCreds =
  !!builderCreds.key && !!builderCreds.passphrase && !!builderCreds.secret;
const builderConfig = hasCreds
  ? new BuilderConfig({
      localBuilderCreds: builderCreds,
    })
  : undefined;
export const relayClient = new RelayClient(
  RELAYER_URL,
  polygon.id,
  walletClient,
  builderConfig as any,
);

export type WalletKind = "deposit-wallet" | "safe";
export type ResolvedWallet = { kind: WalletKind; address: Address };

/**
 * Resolve the connected EOA's Polymarket account, DepositWallet first, Safe proxy second.
 * Throws if neither is deployed — the user must transact on Polymarket once to deploy their wallet.
 */
export async function resolveWallet(): Promise<ResolvedWallet> {
  const depositWallet =
    (await relayClient.deriveDepositWalletAddress()) as Address;
  if (await relayClient.getDeployed(depositWallet, "WALLET")) {
    return { kind: "deposit-wallet", address: depositWallet };
  }

  const safe = await computeProxyAddress(account.address as Address);
  const code = await publicClient.getCode({ address: safe });
  if (code && code !== "0x") return { kind: "safe", address: safe };

  throw new Error(
    `No Polymarket wallet deployed for ${account.address}. Transact on Polymarket once to deploy it.`,
  );
}

export type Call = { to: Address; value: string; data: `0x${string}` };

/**
 * Submit a batch of calls AS the resolved wallet, picking the right transport, and return the tx
 * hash. Both deposit (push) and withdraw work through this for either wallet kind:
 *   - safe          → Safe.execTransaction (MultiSend) via protocol-kit.
 *   - deposit-wallet → Polymarket relayer `executeDepositWalletBatch`.
 */
export async function executeViaWallet(
  wallet: ResolvedWallet,
  calls: Call[],
): Promise<`0x${string}`> {
  if (wallet.kind === "safe") {
    const safe = await Safe.init({
      provider: process.env.POLYGON_RPC_URL || "https://polygon.drpc.org",
      signer: process.env.EOA_PRIVATE_KEY,
      safeAddress: wallet.address,
    });
    const tx = await safe.createTransaction({ transactions: calls });
    const exec = await safe.executeTransaction(tx, { gasLimit: 5_000_000n });
    return exec.hash as `0x${string}`;
  }

  // deposit-wallet: the relayer takes `{ target, value, data }` and signs against a deadline.
  const deadline = Math.floor(
    Date.now() / 1000 + BATCH_DEADLINE_SECONDS,
  ).toString();
  const res = await relayClient.executeDepositWalletBatch(
    calls.map((c) => ({ target: c.to, value: c.value, data: c.data })),
    wallet.address,
    deadline,
  );
  const result = await res.wait();
  if (!result) throw new Error("Relayer transaction failed.");
  return result.transactionHash as `0x${string}`;
}
