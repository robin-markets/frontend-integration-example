// Typed client for the Robin Markets public Integration API (`/api/v1`).
//
// These are READ-ONLY endpoints that return everything Robin computes on top of the Polymarket data
// you already have: the live staking APY for a market, a PERSONALIZED projected APY for a stake the
// user is about to make (base yield + matching bonus + their Robin Points boost), and the state of a
// wallet's existing positions (shares, value, accrued-yield breakdown, live APY).
//
// Conventions:
//   - Token / USD amounts are 6-decimal integer STRINGS ("1500000" = 1.5). Parse with BigInt().
//   - APY values are plain numbers in PERCENT (6 = 6.00% APY).
//   - `wallet` is the user's resolved Robin staking wallet (DepositWallet or Safe — see wallet.ts),
//     NOT the EOA.
//   - Public + CORS-open; no auth. Errors come back as { error: { code, message } }.
//
// See README section "Robin Integration API (/api/v1)" for the full reference.

import type { Address } from "viem";
import type {
  MarketApy,
  Quote,
  StakeQuote,
  QuoteDeposit,
  Capacity,
  RobinPosition,
  SinglePosition,
  RobinContracts,
  TwapMarket,
  TwapPayload,
} from "./types.js";

// Base URL for Robin's API. The v1 Integration API (markets, quotes, positions, TWAP) lives at
// `${ROBIN_API}/v1`. Override with ROBIN_API_BASE to point at a staging/local deployment.
export const ROBIN_API =
  process.env.ROBIN_API_BASE ?? "https://app.robin.markets/api";
const V1 = `${ROBIN_API}/v1`;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(
      `Robin API ${res.status} for ${url}${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

/** Pretty-print an APY number (percent). */
export const fmtPct = (n: number): string => `${n.toFixed(2)}%`;

// The batch endpoints (`/markets`, `/quote`) accept at most 25 unique conditionIds per call.
// getMarkets / ensureMarkets / quoteStakeBatch chunk transparently — like `getPositions` paginating
// — so callers can pass any number of ids.
const MAX_BATCH = 25;
const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ============ Market APY (address-agnostic headline) ============

export async function getMarketApy(
  conditionId: `0x${string}`,
): Promise<MarketApy> {
  return getJson<MarketApy>(`${V1}/markets/${conditionId}`);
}

/**
 * Batch market headlines. De-duplicates and chunks into calls of 25 (the API max) and merges the
 * results, so you can pass any number of ids. Unknown ids come back in `notFound`.
 */
export async function getMarkets(
  conditionIds: `0x${string}`[],
): Promise<{ markets: MarketApy[]; notFound: `0x${string}`[] }> {
  const markets: MarketApy[] = [];
  const notFound: `0x${string}`[] = [];
  for (const ids of chunk([...new Set(conditionIds)], MAX_BATCH)) {
    const q = new URLSearchParams({ conditionIds: ids.join(",") });
    const page = await getJson<{
      markets: MarketApy[];
      notFound: `0x${string}`[];
    }>(`${V1}/markets?${q.toString()}`);
    markets.push(...page.markets);
    notFound.push(...page.notFound);
  }
  return { markets, notFound };
}

/**
 * Index markets on Robin — the ONLY mutating call (everything else is read-only). Fetches any
 * conditionIds Robin doesn't know yet from Polymarket and upserts them, then returns the SAME shape
 * as `getMarkets` (`{ markets, notFound }`) so the result is directly usable — no follow-up read.
 * Call this for markets that might not be on Robin yet. De-dupes and chunks into calls of 25 (the
 * API max) and merges.
 */
export async function ensureMarkets(
  conditionIds: `0x${string}`[],
): Promise<{ markets: MarketApy[]; notFound: `0x${string}`[] }> {
  const markets: MarketApy[] = [];
  const notFound: `0x${string}`[] = [];
  for (const ids of chunk([...new Set(conditionIds)], MAX_BATCH)) {
    const page = await getJson<{
      markets: MarketApy[];
      notFound: `0x${string}`[];
    }>(`${V1}/markets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conditionIds: ids }),
    });
    markets.push(...page.markets);
    notFound.push(...page.notFound);
  }
  return { markets, notFound };
}

// ============ Personalized quote for a potential deposit ============

/**
 * Projected APY for staking `yesAmount` + `noAmount` (6-dec micro-units) of one market, for `wallet`.
 * Mirrors the deposit contract (both sides at once). Omit the amounts for a headline projection.
 */
export async function quoteStake(params: {
  wallet: Address;
  conditionId: `0x${string}`;
  yesAmount?: bigint;
  noAmount?: bigint;
}): Promise<StakeQuote> {
  const q = new URLSearchParams({ wallet: params.wallet });
  if (params.yesAmount && params.yesAmount > 0n)
    q.set("yesAmount", params.yesAmount.toString());
  if (params.noAmount && params.noAmount > 0n)
    q.set("noAmount", params.noAmount.toString());
  return getJson<StakeQuote>(
    `${V1}/markets/${params.conditionId}/quote?${q.toString()}`,
  );
}

/**
 * Batch personalized quotes — chunks into calls of 25 (the API max) and merges, so `deposits` can be
 * any length. They map to the parallel conditionIds/yesAmounts/noAmounts query arrays (amounts
 * default to 0). Each `quotes` entry is an INDEPENDENT quote (its points coverage assumes only that
 * market is the new stake), so chunking doesn't change any per-market result; unknown ids come back
 * in `notFound`.
 */
export async function quoteStakeBatch(params: {
  wallet: Address;
  deposits: QuoteDeposit[];
}): Promise<{ wallet: Address; quotes: Quote[]; notFound: `0x${string}`[] }> {
  const quotes: Quote[] = [];
  const notFound: `0x${string}`[] = [];
  for (const deposits of chunk(params.deposits, MAX_BATCH)) {
    const q = new URLSearchParams({
      wallet: params.wallet,
      conditionIds: deposits.map((d) => d.conditionId).join(","),
      yesAmounts: deposits.map((d) => (d.yesAmount ?? 0n).toString()).join(","),
      noAmounts: deposits.map((d) => (d.noAmount ?? 0n).toString()).join(","),
    });
    const page = await getJson<{
      wallet: Address;
      quotes: Quote[];
      notFound: `0x${string}`[];
    }>(`${V1}/quote?${q.toString()}`);
    quotes.push(...page.quotes);
    notFound.push(...page.notFound);
  }
  return { wallet: params.wallet, quotes, notFound };
}

// ============ Deposit capacity (GET /api/v1/capacity) ============
//
// The vault has a finite, TWO-TIER deposit capacity (tier 1: a forward-looking guard on worst-case
// pairing vs vault caps; tier 2: live ERC-4626 headroom). It's GLOBAL (vault-wide), not per-market —
// an over-capacity deposit reverts on-chain, so pre-flight the WHOLE batch in ONE call (don't chunk:
// two halves that each fit can exceed capacity together). Mirrors RobinLens.checkBatchDepositCapacity.
export async function checkCapacity(deposits: QuoteDeposit[]): Promise<Capacity> {
  if (deposits.length > MAX_BATCH)
    throw new Error(
      `Capacity check supports at most ${MAX_BATCH} markets per batch (got ${deposits.length}).`,
    );
  const q = new URLSearchParams({
    conditionIds: deposits.map((d) => d.conditionId).join(","),
    yesAmounts: deposits.map((d) => (d.yesAmount ?? 0n).toString()).join(","),
    noAmounts: deposits.map((d) => (d.noAmount ?? 0n).toString()).join(","),
  });
  return getJson<Capacity>(`${V1}/capacity?${q.toString()}`);
}

// ============ A wallet's positions ============

/** A wallet's position in a single market. `hasPosition === false` (zeroed) if it holds none. */
export async function getPosition(
  wallet: Address,
  conditionId: `0x${string}`,
): Promise<SinglePosition> {
  return getJson<SinglePosition>(
    `${V1}/markets/${conditionId}/position?wallet=${wallet}`,
  );
}

/** All of a wallet's Robin positions (handles pagination). */
export async function getPositions(
  wallet: Address,
  opts: { category?: "all" | "active" | "resolved" } = {},
): Promise<RobinPosition[]> {
  const category = opts.category ?? "active";
  const out: RobinPosition[] = [];
  let page = 1;
  for (;;) {
    const q = new URLSearchParams({
      wallet,
      category,
      page: String(page),
      pageSize: "100",
    });
    const data = await getJson<{ positions: RobinPosition[]; total: number }>(
      `${V1}/positions?${q.toString()}`,
    );
    out.push(...data.positions);
    if (out.length >= data.total || data.positions.length === 0) break;
    page += 1;
  }
  return out;
}

// ============ Contract addresses ============

/** The addresses you need to build stake/unstake transactions (matches the README's address table). */
export async function getContracts(): Promise<RobinContracts> {
  return getJson<RobinContracts>(`${V1}/contracts`);
}

// ============ TWAP (POST /api/v1/twap) ============
//
// The vault prices a position from a TWAP of the market's YES price. This Robin-hosted endpoint
// returns either { txHash } (the oracle already submitted on-chain — nothing to do, → null) or a
// signed { markets, signature } payload to pass to `TwapOracle.submitTwap` in your batch. Returns
// null when nothing is required and nothing has finalized.
export async function fetchTwap(
  conditionIds: `0x${string}`[],
): Promise<TwapPayload | null> {
  const data = await getJson<
    | { txHash: string }
    | {
        signature: `0x${string}`;
        markets: Array<{
          required: boolean;
          conditionId: `0x${string}`;
          startTimestamp: string;
          endTimestamp: string;
          twapPriceYes: string;
          marketEndedAt: string;
          marketEndYesPrice: string;
        }>;
      }
  >(`${V1}/twap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conditionIds }),
  });

  // Mode A: oracle already submitted on-chain — nothing for us to do.
  if ("txHash" in data) return null;

  const markets: TwapMarket[] = data.markets.map((m) => ({
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
