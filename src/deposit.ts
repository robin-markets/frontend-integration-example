// Minimal end-to-end deposit example.
//
// Lists the EOA's Polymarket positions, asks the user which ones to deposit (any number, possibly
// covering multiple markets and both sides of the same market), then deposits them all in a single
// Safe batch.

import {
  encodeFunctionData,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import Safe from "@safe-global/protocol-kit";
import {
  ADDR,
  UNDERLYING_DECIMALS,
  account,
  assertProxyDeployed,
  computeProxyAddress,
  fetchTwap,
  fetchUserPositions,
  pickManyFromList,
  promptAmount6dec,
  publicClient,
  // After the upcoming contract upgrade, also import `fetchQuestionIds` from "./shared.js".
  sortBatchByConditionId,
} from "./shared.js";
import {
  twapOracleAbi,
  conditionalTokensAbi,
  stakingVaultAbi,
} from "./abis.js";
import { DepositRow } from "./types.js";

async function main() {
  const eoa = account.address as Address;
  const proxy = await computeProxyAddress(eoa);
  console.log(`EOA:   ${eoa}`);
  console.log(`Proxy: ${proxy}`);
  await assertProxyDeployed(proxy);

  // 1. Fetch positions and let the user pick any number of them.
  const positions = await fetchUserPositions(proxy);
  if (positions.length === 0)
    throw new Error("No Polymarket positions found in proxy wallet.");

  const picked = await pickManyFromList(
    positions,
    (p) => {
      const parts: string[] = [];
      if (p.yesSize > 0) parts.push(`${p.yesSize.toFixed(4)} YES`);
      if (p.noSize > 0) parts.push(`${p.noSize.toFixed(4)} NO`);
      return `${parts.join(" + ")}  ${p.title}`;
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

  console.log(`\nDepositing ${rows.length} market(s):`);
  for (const r of rows) {
    const parts: string[] = [];
    if (r.yesAmount > 0n)
      parts.push(`${formatUnits(r.yesAmount, UNDERLYING_DECIMALS)} YES`);
    if (r.noAmount > 0n)
      parts.push(`${formatUnits(r.noAmount, UNDERLYING_DECIMALS)} NO`);
    console.log(`  - ${parts.join(" + ")}  (${r.conditionId})`);
  }
  console.log();

  // 3. Sort strictly ascending by conditionId. REQUIRED — see shared.ts.
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

  // ─── UPCOMING UPGRADE (feature/contracts-update-1) ─────────────────────────
  // After upgrade, batchDeposit requires `bytes32[] questionIds` aligned with `conditionIds`
  // (used only when a market needs auto-init). Fetch from Polymarket Gamma and apply the same
  // sort permutation. Uncomment when the upgrade ships:
  //
  // const qMap = await fetchQuestionIds(conditionIds);
  // const questionIds = conditionIds.map((cid) => {
  //     const q = qMap[cid];
  //     if (!q) throw new Error(`No questionId for ${cid}`);
  //     return q;
  // });
  // ───────────────────────────────────────────────────────────────────────────

  // 4. Fetch TWAP. May return null if not needed.
  const twap = await fetchTwap(conditionIds);

  // 5. Encode the Safe batch.
  const txs: { to: string; value: string; data: `0x${string}` }[] = [];

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
      // ─── UPCOMING UPGRADE ──────────────────────────────────────────────────
      // args: [conditionIds, questionIds, yesAmounts, noAmounts, nonZeroLength, referralCode],
      // ───────────────────────────────────────────────────────────────────────
      args: [conditionIds, yesAmounts, noAmounts, nonZeroLength, referralCode],
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

  // 6. Execute via Safe protocol-kit.
  const safe = await Safe.init({
    provider: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    signer: process.env.EOA_PRIVATE_KEY,
    safeAddress: proxy,
  });
  const safeTx = await safe.createTransaction({ transactions: txs });
  const exec = await safe.executeTransaction(safeTx, { gasLimit: 5_000_000n });
  console.log(`Submitted: ${exec.hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: exec.hash as `0x${string}`,
  });
  console.log(`Done. status=${receipt.status} block=${receipt.blockNumber}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
