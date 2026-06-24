import type { Address } from "viem";

export type TwapMarket = {
  required: boolean;
  conditionId: `0x${string}`;
  startTimestamp: bigint;
  endTimestamp: bigint;
  twapPriceYes: bigint;
  marketEndedAt: bigint;
  marketEndYesPrice: bigint;
};

export type TwapPayload = { markets: TwapMarket[]; signature: `0x${string}` };

// One row per market. `fetchUserPositions` merges Polymarket's per-side records (one per
// (conditionId, outcome)) into a single per-market row. `yesSize` / `noSize` are 0 if the user
// doesn't hold that side. `yesPositionId` / `noPositionId` are the on-chain ERC-1155 token ids
// and are always populated regardless of which side(s) the user holds — Polymarket's response
// includes both `asset` and `oppositeAsset`, so we can fill the unheld side too.
export type PolymarketPosition = {
  conditionId: `0x${string}`;
  title: string;
  yesSize: number; // human-readable; 0 if not held
  noSize: number;
  yesPositionId: bigint;
  noPositionId: bigint;
};
export type DepositRow = {
  conditionId: `0x${string}`;
  yesAmount: bigint;
  noAmount: bigint;
};

export type PushDepositRow = {
  conditionId: `0x${string}`;
  yesAmount: bigint;
  noAmount: bigint;
  yesPositionId: bigint;
  noPositionId: bigint;
};

export type WithdrawRow = {
  conditionId: `0x${string}`;
  yesShares: bigint;
  noShares: bigint;
  question: string;
};

// ============ Robin Integration API types ============
//
// The shapes returned by the read-only `/api/v1` endpoints — see robin-api.ts for the client.
// Conventions: token / USD amounts are 6-decimal integer STRINGS ("1500000" = 1.5; parse with
// BigInt()); APY values are plain numbers in PERCENT (6 = 6.00%).

type Side = "yes" | "no";
type Outcome = Side | "both";

// Address-agnostic market headline — the live staking APY any staker could earn right now.
export type MarketApy = {
  conditionId: `0x${string}`;
  question: string;
  slug: string;
  image: string | null;
  endDate: number | null;
  outcomes: string[];
  resolved: boolean;
  winningOutcome: Outcome | null;
  tvl: string;
  pool: {
    matchedFraction: number;
    unmatchedYes: string;
    unmatchedNo: string;
    minoritySide: Side | null;
  };
  apy: {
    base: number; // socialized native yield (× matched fraction), guarantee-floored — same both sides
    guaranteeFloor: number;
    matching: { yes: number; no: number };
    yes: number; // base + matching (points NOT included here)
    no: number;
    min: number; // lowest a staker could earn now (= base; majority side, no points)
    max: number; // highest a staker could earn now (base + best-side matching + full points boost)
    maxPointsBoost: number; // "up to +X%" ceiling
    nativeApy: number | null; // raw Yearn netAPY, null if temporarily unavailable
  };
  vault: `0x${string}`;
};

/** A single market's personalized quote — also the per-entry shape of the batch quote (`quotes[]`). */
export type Quote = {
  conditionId: `0x${string}`;
  amounts: { yes: string; no: string };
  stakeUsd: string;
  projectedApy: {
    total: number;
    base: number;
    matching: number;
    points: number; // this wallet's points boost over (existing stake + this deposit)
  };
  points: { balance: string; boostDays: number; portfolioStakeUsd: string };
};

/** Single-market quote response — a Quote plus the echoed wallet. */
export type StakeQuote = Quote & { wallet: Address };

export type QuoteDeposit = {
  conditionId: `0x${string}`;
  yesAmount?: bigint;
  noAmount?: bigint;
};

export type RobinYield = {
  total: string;
  base: string;
  guarantee: string;
  matching: string;
  points: string;
};

export type RobinPosition = {
  conditionId: `0x${string}`;
  question: string;
  slug: string;
  image: string | null;
  endDate: number | null;
  resolved: boolean;
  winningOutcome: Outcome | null;
  shares: { yes: string; no: string };
  value: string; // current USD value (6-dec)
  yield: RobinYield; // accrued, not-yet-claimed yield (6-dec USD), split by source
  positionApy: number; // live APY on this position (base + locked matching + points boost)
};

export type SinglePosition = Partial<RobinPosition> & {
  conditionId: `0x${string}`;
  wallet: Address;
  hasPosition: boolean;
  shares: { yes: string; no: string };
  value: string;
  yield: RobinYield;
  positionApy: number;
};

export type RobinContracts = {
  chainId: number;
  vault: `0x${string}`;
  conditionalTokens: `0x${string}`;
  usdc: `0x${string}`;
  lens: `0x${string}`;
  twapOracle: `0x${string}`;
};
