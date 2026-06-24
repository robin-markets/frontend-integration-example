// View your Robin Staking Vault portfolio — read-only, NO transaction is sent.
//
// Lists every active position with its current value, live APY, and accrued (not-yet-claimed) yield
// broken down into base / guarantee / matching / points — then a portfolio summary. All from a
// single Robin Integration API call (/api/v1/positions). See robin-api.ts + the README.

import { formatUnits } from "viem";
import { UNDERLYING_DECIMALS } from "./shared.js";
import { account, resolveWallet } from "./wallet.js";
import { getPositions, fmtPct } from "./robin-api.js";

const n6 = (v: string | bigint) =>
  Number(formatUnits(BigInt(v), UNDERLYING_DECIMALS)).toFixed(2);

async function main() {
  const wallet = await resolveWallet();
  console.log(`EOA:    ${account.address}`);
  console.log(`Wallet: ${wallet.address} (${wallet.kind})\n`);

  const positions = await getPositions(wallet.address, { category: "active" });
  if (positions.length === 0) {
    console.log("No active Robin positions for this wallet.");
    return;
  }

  let totalValue = 0n;
  let totalYield = 0n;
  let weightedApyNumerator = 0;
  for (const p of positions) {
    const value = BigInt(p.value);
    totalValue += value;
    totalYield += BigInt(p.yield.total);
    weightedApyNumerator += p.positionApy * Number(value);

    console.log(p.question);
    console.log(`  ${p.conditionId}`);
    console.log(
      `  value $${n6(p.value)} · APY ${fmtPct(p.positionApy)} · shares ${n6(p.shares.yes)} YES + ${n6(p.shares.no)} NO`,
    );
    console.log(
      `  earned $${n6(p.yield.total)}  ` +
        `(base $${n6(p.yield.base)} + guarantee $${n6(p.yield.guarantee)} + matching $${n6(p.yield.matching)} + points $${n6(p.yield.points)})\n`,
    );
  }

  const blendedApy =
    totalValue > 0n ? weightedApyNumerator / Number(totalValue) : 0;
  console.log("=".repeat(72));
  console.log(
    `Total value $${n6(totalValue)} · accrued yield $${n6(totalYield)} · ` +
      `blended APY ${fmtPct(blendedApy)} across ${positions.length} market(s)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
