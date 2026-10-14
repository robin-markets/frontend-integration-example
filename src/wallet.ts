// Wallet detection. A Polymarket user controls one of two on-chain accounts that hold their CT
// tokens / Robin vault shares: the newer **DepositWallet** (every fresh Polymarket account) or the
// legacy **Gnosis Safe proxy**. Detect which is deployed for the connected EOA and act AS that
// address for every deposit/withdraw.
//
//   - safe          → submit via Safe.execTransaction (see deposit.ts / withdraw.ts).
//   - deposit-wallet → submit as a gasless batch through the Polymarket relayer, and you MUST use
//                      the push-deposit flow (deposit-push.ts) — the relayer blocks `approve`.

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
import {
  createSecureClient,
  WalletType,
  type SecureClient,
  type Signer,
} from "@polymarket/client";
import { prepareGaslessTransaction } from "@polymarket/client/actions";
import { builderApiKey } from "@polymarket/client/node";
import { privateKey } from "@polymarket/client/viem";
import { ADDR } from "./shared.js";
import { safeProxyFactoryAbi } from "./abis.js";

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

// ============ Polymarket SDK client ============
//
// The signer is the EOA. Creating a `SecureClient` authenticates against the CLOB once (one
// signature, no gas). Polymarket Builder credentials let the relayer sponsor DepositWallet batches:
// https://polymarket.com/settings?tab=relayer-api-keys. Detection works without them.
const signer: Signer = privateKey(PK);
const builderCreds = {
  key: process.env.POLY_BUILDER_API_KEY ?? "",
  secret: process.env.POLY_BUILDER_SECRET ?? "",
  passphrase: process.env.POLY_BUILDER_PASSPHRASE ?? "",
};
const hasCreds =
  !!builderCreds.key && !!builderCreds.secret && !!builderCreds.passphrase;

/**
 * The EOA's deployed DepositWallet, or null if it has none.
 *
 * Without a `wallet` option the SDK resolves the signer's DepositWallet (UUPS address first, then
 * beacon) and deploys one if neither exists. This client therefore carries no API key: deployment
 * fails before anything is submitted, and that failure means "no DepositWallet". A client with the
 * Builder API key is only created once the wallet is known (see `depositWalletClient`).
 */
async function findDeployedDepositWallet(): Promise<Address | null> {
  try {
    const client = await createSecureClient({ signer });
    return client.account.walletType === WalletType.DEPOSIT_WALLET
      ? (client.account.wallet as Address)
      : null;
  } catch (e) {
    const err = e as Error;
    if (
      err.name === "InvariantError" &&
      err.message.includes("Deposit Wallet deployment requires")
    )
      return null;
    throw e;
  }
}

// Execution client, bound to the resolved DepositWallet, with the Builder API key for gasless
// submission. Created once, on first use.
let executionClient: Promise<SecureClient> | undefined;
function depositWalletClient(wallet: Address): Promise<SecureClient> {
  executionClient ??= createSecureClient({
    signer,
    wallet,
    apiKey: builderApiKey(builderCreds),
  });
  return executionClient;
}

export type WalletKind = "deposit-wallet" | "safe";
export type ResolvedWallet = { kind: WalletKind; address: Address };

/**
 * Resolve the connected EOA's Polymarket account, DepositWallet first, Safe proxy second.
 * Throws if neither is deployed — the user must transact on Polymarket once to deploy their wallet.
 */
export async function resolveWallet(): Promise<ResolvedWallet> {
  const depositWallet = await findDeployedDepositWallet();
  if (depositWallet) return { kind: "deposit-wallet", address: depositWallet };

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
 *   - deposit-wallet → Polymarket relayer gasless batch via `@polymarket/client`.
 */
export async function executeViaWallet(
  wallet: ResolvedWallet,
  calls: Call[],
  metadata = "Robin Markets",
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

  if (!hasCreds)
    throw new Error(
      "POLY_BUILDER_API_KEY / POLY_BUILDER_SECRET / POLY_BUILDER_PASSPHRASE are required to submit a DepositWallet batch through the Polymarket relayer.",
    );
  const client = await depositWalletClient(wallet.address);

  // `prepareGaslessTransaction` builds the DepositWallet batch and returns a workflow that asks the
  // signer for its address and the EIP-712 batch signature, submits the batch to the relayer and
  // hands back a transaction handle. The whole batch is one atomic relayer transaction.
  const workflow = await prepareGaslessTransaction(client, {
    calls: calls.map((c) => ({
      to: c.to,
      data: c.data,
      value: BigInt(c.value),
    })),
    metadata,
  });
  let step = await workflow.next();
  while (!step.done) {
    try {
      const request = step.value;
      switch (request.kind) {
        case "requestAddress":
          step = await workflow.next(await signer.getAddress());
          break;
        case "signGaslessTypedData":
          step = await workflow.next(
            await signer.signTypedData(request.payload),
          );
          break;
        case "signGaslessMessage":
          step = await workflow.next(await signer.signMessage(request.payload));
          break;
        default:
          throw new Error(
            `Unsupported relayer workflow request: ${(request as { kind: string }).kind}`,
          );
      }
    } catch (e) {
      step = await workflow.throw(e);
    }
  }
  const outcome = await step.value.wait();
  return outcome.transactionHash as `0x${string}`;
}
