// Typed client for the Polymarket public APIs the deposit/withdraw flows read from:
//   - the Data API v2 (`data-api.polymarket.com/v2`) — a wallet's current positions.
//   - the Gamma API   (`gamma-api.polymarket.com`) — market metadata (questionIds for batchDeposit).
//
// READ-ONLY; no auth. The on-chain wallet resolution lives in wallet.ts, the Robin Integration API
// client in robin-api.ts.
//
// Data API v1 (unversioned routes like `/positions`) is retired on 2026-10-24; everything here
// targets v2. Migration guide: https://docs.polymarket.com/migrate/data-api-v1-to-v2

import type { Address } from "viem";
import type { PolymarketPosition } from "./types.js";

export const POLYMARKET_GAMMA = "https://gamma-api.polymarket.com";
export const POLYMARKET_DATA = "https://data-api.polymarket.com/v2";

// Data API v2 envelope: every route wraps its payload in `data`; list routes page with an opaque
// cursor. Follow `pagination.next_cursor` until it is `null` (`limit` only applies to the first
// page — the cursor carries the page size). A miss is `data: []`, never an error.
export type DataApiPage<T> = {
  data: T[];
  pagination: { next_cursor: string | null };
};

// The subset of a `/v2/positions` row we consume. One row per (condition_id, outcome) the wallet
// holds; fields are snake_case in v2. Amounts are human-readable numbers (6 decimals on-chain).
export type DataApiPositionRow = {
  condition_id: `0x${string}`;
  outcome: string; // outcome LABEL ("Yes", "No", a player name, ...) — discriminate on outcome_index
  outcome_index: number; // 0 = YES slot, 1 = NO slot
  current_size: number; // shares currently held
  title: string;
  token_id: string; // ERC-1155 position id of the held outcome (uint256 as decimal string)
  opposite_token_id: string; // ERC-1155 position id of the market's other outcome
};

// One row of `/v2/tokens`. `module` says which contract family issued a token: `v1_ctf` is a
// Conditional Tokens market (stakeable on Robin); every other value is a Polymarket Protocol V2
// module, whose positions the vault cannot take. Position rows carry no such marker themselves.
export type DataApiTokenRow = {
  token_id: string;
  module: "v1_ctf" | "binary" | "neg_risk" | "combo";
};

// Resolves which ledger issued each token (max 50 ids per call). Tokens the lookup does not know
// are absent from the map.
export async function fetchTokenProtocolVersions(
  tokenIds: string[],
): Promise<Map<string, "v1" | "v2">> {
  const versions = new Map<string, "v1" | "v2">();
  const unique = [...new Set(tokenIds)];
  for (let i = 0; i < unique.length; i += 50) {
    const q = new URLSearchParams({
      token_id: unique.slice(i, i + 50).join(","),
    });
    const res = await fetch(`${POLYMARKET_DATA}/tokens?${q.toString()}`);
    if (!res.ok)
      throw new Error(`Polymarket token lookup failed: ${res.status}`);
    const page = (await res.json()) as { data: DataApiTokenRow[] | null };
    for (const t of page.data ?? [])
      versions.set(t.token_id, t.module === "v1_ctf" ? "v1" : "v2");
  }
  return versions;
}

// Fetches the user's open Polymarket positions, merged so each market appears at most once.
// Per-side raw records get folded into a single { yesSize, noSize, yesPositionId, noPositionId }
// row. The unheld side's positionId comes from `opposite_token_id` on the held side's record —
// Polymarket includes it specifically so callers don't have to derive it on-chain.
//
// `filter_type=TOKENS&filter_amount=0.1` is the v2 spelling of v1's `sizeThreshold=0.1` (drop dust).
// Pages are walked to the end, so wallets with >100 positions are no longer truncated.
//
// Every row is returned — including Polymarket Protocol V2 positions — with `protocolVersion` set
// from the `/v2/tokens` lookup, so a UI can list them as "not supported" without ever depositing them.
export async function fetchUserPositions(
  proxyAddress: Address,
): Promise<PolymarketPosition[]> {
  const byCid = new Map<`0x${string}`, PolymarketPosition>();
  const heldTokenByCid = new Map<`0x${string}`, string>();
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams({
      user: proxyAddress,
      filter_type: "TOKENS",
      filter_amount: "0.1",
    });
    if (cursor) q.set("cursor", cursor);
    else q.set("limit", "100");
    const res = await fetch(`${POLYMARKET_DATA}/positions?${q.toString()}`);
    if (!res.ok)
      throw new Error(`Polymarket positions fetch failed: ${res.status}`);
    const page = (await res.json()) as DataApiPage<DataApiPositionRow>;
    for (const p of page.data) {
      const existing = byCid.get(p.condition_id);
      const row: PolymarketPosition = existing ?? {
        conditionId: p.condition_id,
        title: p.title,
        yesSize: 0,
        noSize: 0,
        yesPositionId: 0n,
        noPositionId: 0n,
        protocolVersion: null,
      };
      heldTokenByCid.set(p.condition_id, p.token_id);
      // YES is outcome slot 0 on-chain. Use the index, not the label — `outcome` is free text.
      if (p.outcome_index === 0) {
        row.yesSize = p.current_size;
        row.yesPositionId = BigInt(p.token_id);
        // Fill the NO side's id from `opposite_token_id` only if it wasn't already set by a NO row.
        if (row.noPositionId === 0n)
          row.noPositionId = BigInt(p.opposite_token_id);
      } else {
        row.noSize = p.current_size;
        row.noPositionId = BigInt(p.token_id);
        if (row.yesPositionId === 0n)
          row.yesPositionId = BigInt(p.opposite_token_id);
      }
      byCid.set(p.condition_id, row);
    }
    cursor = page.pagination.next_cursor;
  } while (cursor);

  const versions = await fetchTokenProtocolVersions([
    ...heldTokenByCid.values(),
  ]);
  for (const [cid, tokenId] of heldTokenByCid)
    byCid.get(cid)!.protocolVersion = versions.get(tokenId) ?? null;
  return Array.from(byCid.values());
}

type GammaMarketIds = { conditionId: `0x${string}`; questionID: `0x${string}` };

// `/markets/keyset` only returns open markets unless `closed=true` is passed, and there is no way
// to ask for both in one query — so every lookup fires both and merges them.
async function fetchGammaMarkets(
  conditionIds: `0x${string}`[],
  closed?: boolean,
): Promise<GammaMarketIds[]> {
  const qs = conditionIds
    .map((id) => `condition_ids=${encodeURIComponent(id)}`)
    .join("&");
  const closedParam = closed === undefined ? "" : `&closed=${closed}`;
  const res = await fetch(
    `${POLYMARKET_GAMMA}/markets/keyset?${qs}&limit=100${closedParam}`,
  );
  if (!res.ok)
    throw new Error(`Polymarket questionIds fetch failed: ${res.status}`);
  return ((await res.json()) as { markets: GammaMarketIds[] }).markets;
}

// Polymarket questionIds for `batchDeposit`, returned aligned 1:1 with `conditionIds` (used for
// auto-init). Throws if Polymarket doesn't return a questionId for any requested market.
export async function fetchQuestionIds(
  conditionIds: `0x${string}`[],
): Promise<`0x${string}`[]> {
  if (conditionIds.length === 0) return [];
  const [open, closed] = await Promise.all([
    fetchGammaMarkets(conditionIds),
    fetchGammaMarkets(conditionIds, true),
  ]);
  const byCid = new Map(
    [...open, ...closed].map((m) => [m.conditionId, m.questionID]),
  );
  return conditionIds.map((cid) => {
    const q = byCid.get(cid);
    if (!q) throw new Error(`No questionId for ${cid}`);
    return q;
  });
}
