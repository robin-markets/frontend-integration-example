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
export type DepositedPositionResponse = {
  positions: Array<{
    conditionId: `0x${string}`;
    question: string;
    yesShares: string;
    noShares: string;
    positionTvl: string;
  }>;
  total: number;
  pageSize: number;
};

export type DepositedPosition = {
  conditionId: `0x${string}`;
  question: string;
  yesShares: bigint;
  noShares: bigint;
  positionTvl: bigint; // 6-decimal USD value
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
