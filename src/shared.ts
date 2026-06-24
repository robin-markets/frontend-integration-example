// Shared addresses, constants, and CLI helpers (batch sorting, amount/confirmation prompts) used
// across the flows. Polymarket fetches live in polymarket-api.ts, the Robin Integration API client
// (incl. TWAP) in robin-api.ts, and the viem clients + wallet resolution in wallet.ts.

import "dotenv/config";
import * as readline from "node:readline/promises";
import { formatUnits, parseUnits, type Address } from "viem";

// ============ Addresses (Polygon mainnet) ============

export const ADDR = {
  SAFE_PROXY_FACTORY: "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b" as Address, //Polymarket's Safe factory
  STAKING_VAULT: "0xcb7444981296D08dA7161B75378e3773DbF5D806" as Address,
  TWAP_ORACLE: "0xf08a02deeB4C7A09fAc8e8C6f8508D724612796f" as Address,
  ROBIN_LENS: "0xDbB59819C5a4d28374a162e375Ce4595c8650dDC" as Address,
  CONDITIONAL_TOKENS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045" as Address,
};

// All token amounts and prices in the Robin vault are 6-decimal fixed-point.
export const UNDERLYING_DECIMALS = 6;
export const PRICE_SCALE = 10n ** BigInt(UNDERLYING_DECIMALS);

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

// Yes/no confirmation gate. Returns true only on "y"/"yes"; blank or "n"/"no" → false (so the
// default of just hitting Enter is the safe "don't do it"). Re-asks on anything else.
export async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    for (;;) {
      const ans = (await rl.question(prompt)).trim().toLowerCase();
      if (ans === "y" || ans === "yes") return true;
      if (ans === "" || ans === "n" || ans === "no") return false;
      console.log('Please answer "y" or "n".');
    }
  } finally {
    rl.close();
  }
}
