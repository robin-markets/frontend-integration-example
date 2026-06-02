// Push-deposit flow — an alternative to the `approve -> batchDeposit -> revoke` batch in deposit.ts.
//
// The user pushes CT tokens directly to the vault via
// `CTF.safeBatchTransferFrom(safe, vault, ids, values, data)`. The vault's `onERC1155BatchReceived`
// hook decodes `data` as the deposit payload and runs the full deposit pipeline atomically.
//
// Why bother:
//   - 1 vault-side call instead of 3 (no approve/revoke pair).
//   - No standing approval on `ConditionalTokens` → the vault can never pull tokens unannounced.
//   - It's the only path the new Polymarket "Deposit Wallets" can use — their relayer blocks
//     `approve` calls to the CTF.

import {
  encodeAbiParameters,
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
  fetchQuestionIds,
  fetchTwap,
  fetchUserPositions,
  pickManyFromList,
  promptAmount6dec,
  publicClient,
  sortBatchByConditionId,
} from "./shared.js";
import { twapOracleAbi, conditionalTokensAbi } from "./abis.js";
import { PushDepositRow } from "./types.js";

async function main() {
  const eoa = account.address as Address;
  const proxy = await computeProxyAddress(eoa);
  console.log(`EOA:   ${eoa}`);
  console.log(`Proxy: ${proxy}`);
  await assertProxyDeployed(proxy);

  // 1. Pick positions.
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
    'Pick markets to push-deposit (e.g. "1,3,5" or "all"): ',
  );

  // 2. For each picked market, prompt for YES and NO amounts to push-deposit (default = max).
  //    `yesPositionId` / `noPositionId` come straight from Polymarket (`asset` + `oppositeAsset`)
  //    — the vault rebuilds its own `(ids, values)` from its cached positionIds and reverts
  //    `PushDepositMismatch` if your ids don't match.
  console.log();
  const rows: PushDepositRow[] = [];
  for (const p of picked) {
    let yes = 0n;
    let no = 0n;
    if (p.yesSize > 0) {
      const max = parseUnits(p.yesSize.toString(), UNDERLYING_DECIMALS);
      yes = await promptAmount6dec(
        max,
        `Amount of YES on "${p.title}" to push-deposit (max ${p.yesSize}, blank = all, "skip" to skip): `,
      );
    }
    if (p.noSize > 0) {
      const max = parseUnits(p.noSize.toString(), UNDERLYING_DECIMALS);
      no = await promptAmount6dec(
        max,
        `Amount of NO on "${p.title}" to push-deposit (max ${p.noSize}, blank = all, "skip" to skip): `,
      );
    }
    if (yes === 0n && no === 0n) continue;
    rows.push({
      conditionId: p.conditionId,
      yesAmount: yes,
      noAmount: no,
      yesPositionId: p.yesPositionId,
      noPositionId: p.noPositionId,
    });
  }
  if (rows.length === 0) throw new Error("Nothing to push-deposit.");

  console.log(`\nPush-depositing ${rows.length} market(s):`);
  for (const r of rows) {
    const parts: string[] = [];
    if (r.yesAmount > 0n)
      parts.push(`${formatUnits(r.yesAmount, UNDERLYING_DECIMALS)} YES`);
    if (r.noAmount > 0n)
      parts.push(`${formatUnits(r.noAmount, UNDERLYING_DECIMALS)} NO`);
    console.log(`  - ${parts.join(" + ")}  (${r.conditionId})`);
  }
  console.log();

  // 3. Sort strictly ascending by conditionId — REQUIRED, see shared.ts.
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

  // 4. Fetch questionIds (aligned with conditionIds) — encoded into `data` for the hook to decode.
  const questionIds = await fetchQuestionIds(conditionIds);

  // 5. Build the dense, sorted (ids, values) arrays the way the vault will rebuild them
  //    internally. Order: for each market in ascending conditionId, YES (if yesAmount > 0) then
  //    NO (if noAmount > 0). Zero sides are skipped.
  const ids: bigint[] = [];
  const values: bigint[] = [];
  for (const r of sortedRows) {
    if (r.yesAmount > 0n) {
      if (r.yesPositionId === 0n)
        throw new Error(
          `Missing YES positionId for ${r.conditionId} — fetch it from Polymarket or derive via CTF.getPositionId.`,
        );
      ids.push(r.yesPositionId);
      values.push(r.yesAmount);
    }
    if (r.noAmount > 0n) {
      if (r.noPositionId === 0n)
        throw new Error(`Missing NO positionId for ${r.conditionId}.`);
      ids.push(r.noPositionId);
      values.push(r.noAmount);
    }
  }
  if (BigInt(ids.length) !== nonZeroLength)
    throw new Error("ids[] length must equal nonZeroLength");

  // 6. ABI-encode the deposit payload that the push-deposit hook will decode.
  //    Signature (from `PolymarketMixin._executePushDepositFromHook`):
  //      (bytes32[] conditionIds, bytes32[] questionIds, uint256[] yesAmounts,
  //       uint256[] noAmounts, uint256 nonZeroLength, uint256 referralCode)
  const depositData = encodeAbiParameters(
    [
      { type: "bytes32[]" },
      { type: "bytes32[]" },
      { type: "uint256[]" },
      { type: "uint256[]" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      conditionIds,
      questionIds,
      yesAmounts,
      noAmounts,
      nonZeroLength,
      referralCode,
    ],
  );

  // 7. TWAP, same as the pull-deposit flow.
  const twap = await fetchTwap(conditionIds);

  // 8. Encode the Safe batch + ONE safeBatchTransferFrom call.
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
      functionName: "safeBatchTransferFrom",
      args: [proxy, ADDR.STAKING_VAULT, ids, values, depositData],
    }),
  });

  // 9. Execute via Safe.
  const safe = await Safe.init({
    provider: process.env.POLYGON_RPC_URL || "https://polygon.drpc.org",
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
