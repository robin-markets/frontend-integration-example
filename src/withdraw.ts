// Minimal end-to-end withdraw example.
//
// Fetches the user's currently-deposited positions from Robin's API, asks the user which ones to
// withdraw (any number), then withdraws their shares in a single Safe batch.

import { encodeFunctionData, formatUnits, type Address } from "viem";
import {
  ADDR,
  UNDERLYING_DECIMALS,
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
import { twapOracleAbi, stakingVaultAbi } from "./abis.js";
import { getPositions, fmtPct, fetchTwap } from "./robin-api.js";
import { WithdrawRow } from "./types.js";

async function main() {
  const eoa = account.address as Address;
  const wallet = await resolveWallet();
  console.log(`EOA:    ${eoa}`);
  console.log(`Wallet: ${wallet.address} (${wallet.kind})`);

  // 1. Fetch deposited positions from the Robin Integration API — this also gives each position's
  //    live APY and accrued (not-yet-claimed) yield, which we surface in the picker below.
  const robinPositions = await getPositions(wallet.address, { category: "active" });
  if (robinPositions.length === 0)
    throw new Error("No deposited positions to withdraw.");
  const deposited = robinPositions.map((p) => ({
    conditionId: p.conditionId,
    question: p.question,
    yesShares: BigInt(p.shares.yes),
    noShares: BigInt(p.shares.no),
    value: BigInt(p.value),
    apy: p.positionApy,
    earned: BigInt(p.yield.total),
  }));

  // 2. Multi-select picker.
  const fmt = (v: bigint) => formatUnits(v, UNDERLYING_DECIMALS);
  const picked = await pickManyFromList(
    deposited,
    (p) =>
      `${fmt(p.value).padStart(8)} USD  +$${fmt(p.earned)} earned  ${fmtPct(p.apy)} APY  ` +
      `${fmt(p.yesShares)} YES + ${fmt(p.noShares)} NO  ${p.question}`,
    'Pick positions to withdraw (e.g. "1,3,5" or "all"): ',
  );

  // 3. For each picked market, prompt for YES and NO share amounts to withdraw (default = max).
  //    Either side can be zero — only the row as a whole must be non-empty.
  console.log();

  const withAmounts: WithdrawRow[] = [];
  for (const p of picked) {
    let yes = 0n;
    let no = 0n;
    if (p.yesShares > 0n) {
      yes = await promptAmount6dec(
        p.yesShares,
        `Amount of YES on "${p.question}" to withdraw (max ${fmt(p.yesShares)}, blank = all, "skip" to skip): `,
      );
    }
    if (p.noShares > 0n) {
      no = await promptAmount6dec(
        p.noShares,
        `Amount of NO on "${p.question}" to withdraw (max ${fmt(p.noShares)}, blank = all, "skip" to skip): `,
      );
    }
    if (yes === 0n && no === 0n) continue;
    withAmounts.push({
      conditionId: p.conditionId,
      yesShares: yes,
      noShares: no,
      question: p.question,
    });
  }
  if (withAmounts.length === 0) throw new Error("Nothing to withdraw.");

  console.log(`\nWithdrawing ${withAmounts.length} position(s):`);
  for (const p of withAmounts) {
    console.log(
      `  - ${fmt(p.yesShares)} YES + ${fmt(p.noShares)} NO  ${p.question}`,
    );
  }
  console.log();

  // 4. Sort strictly ascending by conditionId. REQUIRED — see shared.ts.
  //    Each conditionId appears at most once here (one per picked market), so no duplicates.
  const sortedRows = sortBatchByConditionId(withAmounts);
  const conditionIds = sortedRows.map((r) => r.conditionId);
  const yesArr = sortedRows.map((r) => r.yesShares);
  const noArr = sortedRows.map((r) => r.noShares);
  const nonZeroLength = BigInt(
    sortedRows.reduce(
      (n, r) => n + (r.yesShares > 0n ? 1 : 0) + (r.noShares > 0n ? 1 : 0),
      0,
    ),
  );
  const referralCode = 0n;
  const yieldRecipient = wallet.address;
  // Set to `true` to receive yield as PolyUSD (wrapped via Polymarket's CollateralOnramp), or
  // `false` to keep USDC.e.
  const wrapYieldToPolyUsd = false;

  // 4. TWAP.
  const twap = await fetchTwap(conditionIds);

  // 5. Build batch.
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
    to: ADDR.STAKING_VAULT,
    value: "0",
    data: encodeFunctionData({
      abi: stakingVaultAbi,
      functionName: "batchWithdraw",
      args: [
        conditionIds,
        yesArr,
        noArr,
        yieldRecipient,
        nonZeroLength,
        referralCode,
        wrapYieldToPolyUsd,
      ],
    }),
  });

  // 6. Execute AS the resolved wallet — Safe.execTransaction (safe) or the Polymarket relayer
  //    (deposit-wallet). batchWithdraw is identical for both; only the transport differs.
  const hash = await executeViaWallet(wallet, txs);
  console.log(`Submitted: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`Done. status=${receipt.status} block=${receipt.blockNumber}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
