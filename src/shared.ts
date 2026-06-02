// Shared addresses, ABIs (minimal), and helper functions used by deposit.ts and withdraw.ts.

import "dotenv/config";
import * as readline from "node:readline/promises";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { safeProxyFactoryAbi } from "./abis";
import {
  TwapPayload,
  TwapMarket,
  PolymarketPosition,
  DepositedPosition,
  DepositedPositionResponse,
} from "./types";

// ============ Addresses (Polygon mainnet) ============

export const ADDR = {
  SAFE_PROXY_FACTORY: "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b" as Address,
  STAKING_VAULT: "0xcb7444981296D08dA7161B75378e3773DbF5D806" as Address,
  TWAP_ORACLE: "0xf08a02deeB4C7A09fAc8e8C6f8508D724612796f" as Address,
  ROBIN_LENS: "0xDbB59819C5a4d28374a162e375Ce4595c8650dDC" as Address,
  CONDITIONAL_TOKENS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address,
};

export const ROBIN_API = "https://app.robin.markets/api";
export const POLYMARKET_GAMMA = "https://gamma-api.polymarket.com";
export const POLYMARKET_DATA = "https://data-api.polymarket.com";

// All token amounts and prices in the Robin vault are 6-decimal fixed-point.
export const UNDERLYING_DECIMALS = 6;
export const PRICE_SCALE = 10n ** BigInt(UNDERLYING_DECIMALS);

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

// ============ Polymarket fetches ============

// Fetches the user's Polymarket positions, merged so each market appears at most once. Per-side
// raw records (one per (conditionId, outcome)) get folded into a single { yesSize, noSize,
// yesPositionId, noPositionId } row. The unheld side's positionId comes from `oppositeAsset` on
// the held side's record — Polymarket includes it specifically so callers don't have to derive
// it on-chain.
export async function fetchUserPositions(
  proxyAddress: Address,
): Promise<PolymarketPosition[]> {
  const url = `${POLYMARKET_DATA}/positions?user=${proxyAddress}&sizeThreshold=0.1&limit=100`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Polymarket positions fetch failed: ${res.status}`);
  const raw = (await res.json()) as Array<{
    conditionId: `0x${string}`;
    outcome: "Yes" | "No";
    size: number | string;
    title: string;
    asset: string;
    oppositeAsset: string;
  }>;
  const byCid = new Map<`0x${string}`, PolymarketPosition>();
  for (const p of raw) {
    const existing = byCid.get(p.conditionId);
    const row: PolymarketPosition = existing ?? {
      conditionId: p.conditionId,
      title: p.title,
      yesSize: 0,
      noSize: 0,
      yesPositionId: 0n,
      noPositionId: 0n,
    };
    if (p.outcome === "Yes") {
      row.yesSize = Number(p.size);
      row.yesPositionId = BigInt(p.asset);
      // Fill the NO side's id from `oppositeAsset` only if it wasn't already set by a NO row.
      if (row.noPositionId === 0n) row.noPositionId = BigInt(p.oppositeAsset);
    } else {
      row.noSize = Number(p.size);
      row.noPositionId = BigInt(p.asset);
      if (row.yesPositionId === 0n) row.yesPositionId = BigInt(p.oppositeAsset);
    }
    byCid.set(p.conditionId, row);
  }
  return Array.from(byCid.values());
}

// Polymarket questionIds for `batchDeposit`, returned aligned 1:1 with `conditionIds` (used for
// auto-init). Throws if Polymarket doesn't return a questionId for any requested market.
export async function fetchQuestionIds(
  conditionIds: `0x${string}`[],
): Promise<`0x${string}`[]> {
  if (conditionIds.length === 0) return [];
  const qs = conditionIds
    .map((id) => `condition_ids=${encodeURIComponent(id)}`)
    .join("&");
  const url = `${POLYMARKET_GAMMA}/markets/keyset?${qs}&limit=100`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Polymarket questionIds fetch failed: ${res.status}`);
  const data = (await res.json()) as {
    markets: Array<{ conditionId: `0x${string}`; questionID: `0x${string}` }>;
  };
  const byCid = new Map(data.markets.map((m) => [m.conditionId, m.questionID]));
  return conditionIds.map((cid) => {
    const q = byCid.get(cid);
    if (!q) throw new Error(`No questionId for ${cid}`);
    return q;
  });
}

// ============ Misc helpers ============

export async function computeProxyAddress(eoa: Address): Promise<Address> {
  return (await publicClient.readContract({
    address: ADDR.SAFE_PROXY_FACTORY,
    abi: safeProxyFactoryAbi,
    functionName: "computeProxyAddress",
    args: [eoa],
  })) as Address;
}

export async function assertProxyDeployed(proxy: Address): Promise<void> {
  const code = await publicClient.getCode({ address: proxy });
  if (!code || code === "0x") {
    throw new Error(
      `Polymarket Safe proxy ${proxy} is not deployed. The user must perform any action on Polymarket first.`,
    );
  }
}

// ============ Batch ordering ============
//
// The Robin Staking Vault REQUIRES batch arrays (`conditionIds`, `questionIds`,
// `yesAmounts`/`yesShares`, `noAmounts`/`noShares`) to be ordered by
// `conditionId` strictly ascending, with no duplicates. The contract uses this invariant to
// detect duplicate markets in O(n): if two adjacent ids are equal or out of order, it reverts
// with `UnsortedConditionIds`.
//
// Always run your batch through `sortBatchByConditionId` before encoding the call.
//
// `bytes32` comparison is byte-lexicographic, which matches `BigInt` comparison for hex strings
// of the same length — we use the latter.

export function sortBatchByConditionId<
  T extends { conditionId: `0x${string}` },
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const av = BigInt(a.conditionId);
    const bv = BigInt(b.conditionId);
    if (av < bv) return -1;
    if (av > bv) return 1;
    throw new Error(`Duplicate conditionId in batch: ${a.conditionId}`);
  });
}

// ============ Interactive picker ============

// Prompt for a 6-decimal amount, capped at `max6dec`.
//   blank / "all" / "max" → max
//   "skip" / "none"       → 0n
//   plain number          → that amount, parsed via viem `parseUnits`
export async function promptAmount6dec(
  max6dec: bigint,
  prompt: string,
): Promise<bigint> {
  const maxHuman = formatUnits(max6dec, UNDERLYING_DECIMALS);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const ans = (await rl.question(prompt)).trim().toLowerCase();
      if (ans === "" || ans === "all" || ans === "max") return max6dec;
      if (ans === "skip" || ans === "none") return 0n;
      let amount: bigint;
      try {
        amount = parseUnits(ans, UNDERLYING_DECIMALS);
      } catch {
        console.log(
          `Invalid. Enter a non-negative number, blank / "all" for max (${maxHuman}), or "skip".`,
        );
        continue;
      }
      if (amount < 0n) {
        console.log("Must be non-negative.");
        continue;
      }
      if (amount > max6dec) {
        console.log(`Too high. Max is ${maxHuman}.`);
        continue;
      }
      return amount;
    }
  } finally {
    rl.close();
  }
}

// Multi-select picker. Accepts "1,3,5" or "all".
export async function pickManyFromList<T>(
  items: T[],
  label: (item: T, i: number) => string,
  prompt = 'Pick one or more (comma-separated, or "all"): ',
): Promise<T[]> {
  if (items.length === 0) throw new Error("No items to pick from.");
  console.log();
  items.forEach((item, i) => console.log(`  [${i + 1}] ${label(item, i)}`));
  console.log();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const ans = (await rl.question(prompt)).trim();
      if (ans.toLowerCase() === "all") return items.slice();

      const parts = ans
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const indices = parts.map((p) => Number.parseInt(p, 10) - 1);
      const valid =
        indices.length > 0 &&
        indices.every((i) => Number.isInteger(i) && i >= 0 && i < items.length);
      if (!valid) {
        console.log(
          `Invalid. Enter numbers between 1 and ${items.length}, comma-separated, or "all".`,
        );
        continue;
      }
      // De-duplicate while preserving the user's order.
      const seen = new Set<number>();
      const out: T[] = [];
      for (const i of indices) {
        if (seen.has(i)) continue;
        seen.add(i);
        out.push(items[i]);
      }
      return out;
    }
  } finally {
    rl.close();
  }
}

// ============ Robin deposited positions ============
//
// Hits Robin's own API (https://app.robin.markets/api/positions) — this is the source of truth
// for what the user has deposited into the vault, including share counts and TVL. Polymarket's
// data API only knows about CT balances, not vault shares.

export async function fetchDepositedPositions(
  proxyAddress: Address,
): Promise<DepositedPosition[]> {
  const all: DepositedPosition[] = [];
  let page = 1;
  for (;;) {
    const url = `${ROBIN_API}/positions?address=${proxyAddress}&category=active&page=${page}`;
    const res = await fetch(url);
    if (!res.ok)
      throw new Error(
        `Robin positions fetch failed: ${res.status} ${await res.text()}`,
      );
    const data = (await res.json()) as DepositedPositionResponse;
    for (const p of data.positions) {
      all.push({
        conditionId: p.conditionId,
        question: p.question,
        yesShares: BigInt(p.yesShares),
        noShares: BigInt(p.noShares),
        positionTvl: BigInt(p.positionTvl ?? "0"),
      });
    }
    if (all.length >= data.total || data.positions.length === 0) break;
    page += 1;
  }
  return all;
}

// ============ TWAP fetch (uses Robin's proxy) ============

export async function fetchTwap(
  conditionIds: `0x${string}`[],
): Promise<TwapPayload | null> {
  const res = await fetch(`${ROBIN_API}/twap/twap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conditionIds }),
  });
  if (!res.ok)
    throw new Error(`TWAP fetch failed: ${res.status} ${await res.text()}`);
  const data = await res.json();

  // Mode A: oracle already submitted on-chain — nothing for us to do.
  if ("txHash" in data) return null;

  const markets: TwapMarket[] = (data.markets as any[]).map((m) => ({
    required: m.required,
    conditionId: m.conditionId,
    startTimestamp: BigInt(m.startTimestamp),
    endTimestamp: BigInt(m.endTimestamp),
    twapPriceYes: BigInt(m.twapPriceYes),
    marketEndedAt: BigInt(m.marketEndedAt),
    marketEndYesPrice: BigInt(m.marketEndYesPrice),
  }));

  // No-op short-circuit: nothing required, nothing finalized.
  if (markets.every((m) => !m.required && m.marketEndedAt === 0n)) return null;

  return { markets, signature: data.signature };
}
