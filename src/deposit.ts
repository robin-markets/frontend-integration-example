// Minimal end-to-end deposit example — the PULL path (`approve` → `batchDeposit` → revoke).
//
// This path is **Safe-proxy only**: the new Polymarket DepositWallet relayer blocks `approve`, so
// DepositWallet users must use the push flow instead (see deposit-push.ts). withdraw.ts and the push
// deposit both work for either wallet kind.
//
// Lists the wallet's Polymarket positions, asks the user which ones to deposit (any number, possibly
// covering multiple markets and both sides of the same market), then deposits them in a single
// Safe batch.

import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import {
  ADDR,
  UNDERLYING_DECIMALS,
  confirm,
  pickManyFromList,
  promptAmount6dec,
  sortBatchByConditionId,
} from "./shared.js";
import {
  account,
  publicClient,
  resolveWallet,
  executeViaWallet,
  type Call,
} from "./wallet.js";
import {
  twapOracleAbi,
  conditionalTokensAbi,
  stakingVaultAbi,
} from "./abis.js";
import { fetchQuestionIds, fetchUserPositions } from "./polymarket-api.js";
import {
  ensureMarkets,
  quoteStakeBatch,
  checkCapacity,
  fetchTwap,
  fmtPct,
} from "./robin-api.js";
import { DepositRow, type MarketApy, type Quote } from "./types.js";

async function main() {
  const eoa = account.address as Address;
  const wallet = await resolveWallet();
  console.log(`EOA:    ${eoa}`);
  console.log(`Wallet: ${wallet.address} (${wallet.kind})`);
  if (wallet.kind !== "safe") {
    throw new Error(
      "Pull deposit is Safe-only — DepositWallets must use the push flow (npm run deposit:push), since their relayer blocks `approve`.",
    );
  }

  // 1. Fetch the user's Polymarket positions, then load each market's live APY headline up front so
  //    the picker can show the current min–max APY range while the user chooses. `ensureMarkets`
  //    indexes any markets Robin doesn't know yet.
  const positions = await fetchUserPositions(wallet.address);
  if (positions.length === 0)
    throw new Error("No Polymarket positions found in proxy wallet.");

  const allConditionIds = positions.map((p) => p.conditionId);
  let marketById = new Map<`0x${string}`, MarketApy>();
  try {
    console.log("\nLoading market APYs…");
    const { markets } = await ensureMarkets(allConditionIds);
    marketById = new Map(markets.map((m) => [m.conditionId, m]));
  } catch (e) {
    console.log(`(APY data unavailable — ${(e as Error).message})`);
  }

  const picked = await pickManyFromList(
    positions,
    (p) => {
      const parts: string[] = [];
      if (p.yesSize > 0) parts.push(`${p.yesSize.toFixed(4)} YES`);
      if (p.noSize > 0) parts.push(`${p.noSize.toFixed(4)} NO`);
      const m = marketById.get(p.conditionId);
      const range = !m
        ? "not on Robin"
        : m.resolved
          ? "resolved"
          : `APY ${fmtPct(m.apy.min)}–${fmtPct(m.apy.max)}`;
      return `${range.padEnd(20)}  ${parts.join(" + ").padEnd(24)}  ${p.title}`;
    },
    'Pick markets to deposit (e.g. "1,3,5" or "all"): ',
  );

  // 2. For each picked market, prompt for YES and NO amounts to deposit (default = max).
  //    Either side can be zero — only the row as a whole must be non-empty.
  console.log();
  const rows: DepositRow[] = [];
  for (const p of picked) {
    let yes = 0n;
    let no = 0n;
    if (p.yesSize > 0) {
      const max = parseUnits(p.yesSize.toString(), UNDERLYING_DECIMALS);
      yes = await promptAmount6dec(
        max,
        `Amount of YES on "${p.title}" to deposit (max ${p.yesSize}, blank = all, "skip" to skip): `,
      );
    }
    if (p.noSize > 0) {
      const max = parseUnits(p.noSize.toString(), UNDERLYING_DECIMALS);
      no = await promptAmount6dec(
        max,
        `Amount of NO on "${p.title}" to deposit (max ${p.noSize}, blank = all, "skip" to skip): `,
      );
    }
    if (yes === 0n && no === 0n) continue;
    rows.push({ conditionId: p.conditionId, yesAmount: yes, noAmount: no });
  }
  if (rows.length === 0) throw new Error("Nothing to deposit.");

  // 3. Review & confirm. Fetch a PERSONALIZED quote for the exact amounts entered (these markets
  //    were already indexed above) and show, per market, the stake value, projected APY, and the
  //    resulting earnings per month. NOTHING is staked until the user confirms this overview.
  const titleById = new Map(picked.map((p) => [p.conditionId, p.title]));
  let quoteById = new Map<`0x${string}`, Quote>();
  try {
    const { quotes } = await quoteStakeBatch({
      wallet: wallet.address,
      deposits: rows.map((r) => ({
        conditionId: r.conditionId,
        yesAmount: r.yesAmount,
        noAmount: r.noAmount,
      })),
    });
    quoteById = new Map(quotes.map((q) => [q.conditionId, q]));
  } catch (e) {
    console.log(`\n(Live quotes unavailable — ${(e as Error).message})`);
  }

  console.log(
    `\n${"=".repeat(72)}\nReview deposit — ${rows.length} market(s)\n`,
  );
  let totalStake = 0;
  let totalMonthly = 0;
  for (const r of rows) {
    const parts: string[] = [];
    if (r.yesAmount > 0n)
      parts.push(`${formatUnits(r.yesAmount, UNDERLYING_DECIMALS)} YES`);
    if (r.noAmount > 0n)
      parts.push(`${formatUnits(r.noAmount, UNDERLYING_DECIMALS)} NO`);
    console.log(titleById.get(r.conditionId) ?? r.conditionId);
    console.log(`  deposit ${parts.join(" + ")}`);

    const q = quoteById.get(r.conditionId);
    if (q) {
      const stake = Number(
        formatUnits(BigInt(q.stakeUsd), UNDERLYING_DECIMALS),
      );
      const monthly = (stake * q.projectedApy.total) / 100 / 12;
      totalStake += stake;
      totalMonthly += monthly;
      console.log(
        `  stake $${stake.toFixed(2)} · ${fmtPct(q.projectedApy.total)} APY ` +
          `(base ${fmtPct(q.projectedApy.base)} + matching ${fmtPct(q.projectedApy.matching)} + points ${fmtPct(q.projectedApy.points)})`,
      );
      console.log(`  → earns ~$${monthly.toFixed(2)} / month`);
    } else {
      console.log("  quote unavailable (market not on Robin yet)");
    }
    console.log();
  }
  console.log(
    `${"-".repeat(72)}\n` +
      `Total stake $${totalStake.toFixed(2)} · projected earnings ` +
      `~$${totalMonthly.toFixed(2)} / month (~$${(totalMonthly * 12).toFixed(2)} / year)\n`,
  );

  // Capacity pre-flight — the vault has a finite, two-tier deposit capacity (global, not per-market).
  // An over-capacity deposit reverts on-chain, so check the WHOLE batch before staking.
  try {
    const cap = await checkCapacity(rows);
    const remaining = cap.remainingUsdc
      ? `~$${Number(formatUnits(BigInt(cap.remainingUsdc), UNDERLYING_DECIMALS)).toFixed(2)} remaining`
      : "uncapped";
    if (!cap.fits) {
      console.log(
        `Vault capacity: this deposit would EXCEED capacity (${remaining}) — it would revert on-chain. Aborting.\n`,
      );
      return;
    }
    console.log(`Vault capacity: fits ✓ (${remaining})\n`);
  } catch (e) {
    console.log(`(Capacity check unavailable — ${(e as Error).message})\n`);
  }

  if (!(await confirm("Confirm and stake these positions? [y/N]: "))) {
    console.log("Aborted — nothing was staked.");
    return;
  }
  console.log();

  // 4. Sort strictly ascending by conditionId. REQUIRED — see shared.ts.
  //    Each conditionId appears at most once here (one per picked market), so no duplicates.
  const sortedRows = sortBatchByConditionId(rows);
  const conditionIds = sortedRows.map((r) => r.conditionId);
  const yesAmounts = sortedRows.map((r) => r.yesAmount);
  const noAmounts = sortedRows.map((r) => r.noAmount);
  const nonZeroLength = BigInt(
    sortedRows.reduce(
      (n, r) => n + (r.yesAmount > 0n ? 1 : 0) + (r.noAmount > 0n ? 1 : 0),
      0,
    ),
  );
  const referralCode = 0n;

  // batchDeposit requires `bytes32[] questionIds` aligned with `conditionIds` (used only when a
  // market needs auto-initialising; ignored for already-initialised markets, but the array must
  // still be aligned and the same length). Sourced from Polymarket Gamma's `questionID` field.
  const questionIds = await fetchQuestionIds(conditionIds);

  // 5. Fetch TWAP. May return null if not needed.
  const twap = await fetchTwap(conditionIds);

  // 6. Encode the Safe batch.
  const txs: Call[] = [];

  if (twap) {
    txs.push({
      to: ADDR.TWAP_ORACLE,
      value: "0",
      data: encodeFunctionData({
        abi: twapOracleAbi,
        functionName: "submitTwap",
        args: [twap],
      }),
    });
  }

  txs.push({
    to: ADDR.CONDITIONAL_TOKENS,
    value: "0",
    data: encodeFunctionData({
      abi: conditionalTokensAbi,
      functionName: "setApprovalForAll",
      args: [ADDR.STAKING_VAULT, true],
    }),
  });

  txs.push({
    to: ADDR.STAKING_VAULT,
    value: "0",
    data: encodeFunctionData({
      abi: stakingVaultAbi,
      functionName: "batchDeposit",
      args: [
        conditionIds,
        questionIds,
        yesAmounts,
        noAmounts,
        nonZeroLength,
        referralCode,
      ],
    }),
  });

  txs.push({
    to: ADDR.CONDITIONAL_TOKENS,
    value: "0",
    data: encodeFunctionData({
      abi: conditionalTokensAbi,
      functionName: "setApprovalForAll",
      args: [ADDR.STAKING_VAULT, false],
    }),
  });

  // 7. Execute via the Safe (pull deposit is Safe-only).
  const hash = await executeViaWallet(wallet, txs);
  console.log(`Submitted: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Done. status=${receipt.status} block=${receipt.blockNumber}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
