// View Robin staking APY for your Polymarket positions — read-only, NO transaction is sent.
//
// For each market you pick, this prints two things via the Robin Integration API (/api/v1):
//   1. The market's address-agnostic APY headline — per-side base + matching bonus, what *any*
//      staker could earn right now.
//   2. A PERSONALIZED quote for staking your held amount — the projected total APY for THIS wallet,
//      including its Robin Points boost and the matching bonus on the amount you'd actually stake,
//      plus what that works out to in earnings per month.
//
// However many markets you pick, this makes just TWO calls — the BATCH endpoints `GET /v1/markets`
// (headlines) and `GET /v1/quote` (personalized) — instead of two calls per market. See robin-api.ts.

import { formatUnits, parseUnits } from "viem";
import { UNDERLYING_DECIMALS, pickManyFromList } from "./shared.js";
import { account, resolveWallet } from "./wallet.js";
import { fetchUserPositions } from "./polymarket-api.js";
import { ensureMarkets, quoteStakeBatch, fmtPct } from "./robin-api.js";
import type { QuoteDeposit } from "./types.js";

const usd = (v: string | bigint) =>
  `$${Number(formatUnits(BigInt(v), UNDERLYING_DECIMALS)).toFixed(2)}`;
const toAmount = (size: number) =>
  size > 0 ? parseUnits(size.toString(), UNDERLYING_DECIMALS) : 0n;
// Earnings per month implied by an annual APY (percent) on a stake amount (6-dec USD string).
const perMonthUsd = (stakeUsd: string, apyPercent: number) =>
  `$${((Number(formatUnits(BigInt(stakeUsd), UNDERLYING_DECIMALS)) * apyPercent) / 100 / 12).toFixed(2)}`;

async function main() {
  const wallet = await resolveWallet();
  console.log(`EOA:    ${account.address}`);
  console.log(`Wallet: ${wallet.address} (${wallet.kind})\n`);

  const positions = await fetchUserPositions(wallet.address);
  if (positions.length === 0)
    throw new Error("No Polymarket positions found in wallet.");

  const picked = await pickManyFromList(
    positions,
    (p) => {
      const parts: string[] = [];
      if (p.yesSize > 0) parts.push(`${p.yesSize.toFixed(2)} YES`);
      if (p.noSize > 0) parts.push(`${p.noSize.toFixed(2)} NO`);
      return `${parts.join(" + ")}  ${p.title}`;
    },
    'Pick markets to quote (e.g. "1,3" or "all"): ',
  );

  const conditionIds = picked.map((p) => p.conditionId);

  // 1) Index any picked markets Robin doesn't know yet AND read their headlines in ONE call:
  //    POST /markets indexes (the one mutating call) then returns the same data as GET /markets.
  const { markets } = await ensureMarkets(conditionIds);
  const marketById = new Map(markets.map((m) => [m.conditionId, m]));

  // 2) One batch call for the personalized quotes — only for markets live on Robin (skip
  //    not-found). Each quote is independent: its points coverage assumes only that market is staked.
  const deposits: QuoteDeposit[] = [];
  for (const p of picked) {
    const m = marketById.get(p.conditionId);
    if (m)
      deposits.push({
        conditionId: p.conditionId,
        yesAmount: toAmount(p.yesSize),
        noAmount: toAmount(p.noSize),
      });
  }
  const { quotes } = await quoteStakeBatch({
    wallet: wallet.address,
    deposits,
  });
  const quoteById = new Map(quotes.map((q) => [q.conditionId, q]));

  for (const p of picked) {
    console.log(`\n${"=".repeat(72)}\n${p.title}\n${p.conditionId}`);

    const market = marketById.get(p.conditionId);
    if (!market) {
      console.log("  Not available on Robin yet.");
      continue;
    }
    const minority = market.pool.minoritySide;
    const tag = (side: "yes" | "no") =>
      minority === side ? "  ← matching-bonus side" : "";
    console.log(
      `  TVL ${usd(market.tvl)} · native ${market.apy.nativeApy?.toFixed(2) ?? "n/a"}% · base ${fmtPct(market.apy.base)}`,
    );
    console.log(`  YES APY ${fmtPct(market.apy.yes)}${tag("yes")}`);
    console.log(`  NO  APY ${fmtPct(market.apy.no)}${tag("no")}`);
    console.log(
      `  (+ up to ${fmtPct(market.apy.maxPointsBoost)} from Robin Points, personalized below)`,
    );

    // Personalized quote — if YOU staked your held amount right now.
    const quote = quoteById.get(p.conditionId);
    if (!quote) continue;
    const a = quote.projectedApy;
    console.log(
      `  ── Your quote (stake ${usd(quote.stakeUsd)}) → ${fmtPct(a.total)} APY  ≈ ${perMonthUsd(quote.stakeUsd, a.total)}/month`,
    );
    console.log(
      `       base ${fmtPct(a.base)}  +  matching ${fmtPct(a.matching)}  +  points ${fmtPct(a.points)}`,
    );
    console.log(
      `       points balance ${quote.points.balance} · boost lasts ~${quote.points.boostDays}d at current stake`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
