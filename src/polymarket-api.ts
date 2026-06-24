// Typed client for the Polymarket public APIs the deposit/withdraw flows read from:
//   - the Data API  (`data-api.polymarket.com`) — a wallet's current positions.
//   - the Gamma API (`gamma-api.polymarket.com`) — market metadata (questionIds for batchDeposit).
//
// READ-ONLY; no auth. The on-chain wallet resolution lives in wallet.ts, the Robin Integration API
// client in robin-api.ts.

import type { Address } from "viem";
import type { PolymarketPosition } from "./types.js";

export const POLYMARKET_GAMMA = "https://gamma-api.polymarket.com";
export const POLYMARKET_DATA = "https://data-api.polymarket.com";

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
