# Robin Markets - Staking Vault Integration Guide

This document describes everything a third-party frontend needs to know in order to deposit and withdraw Polymarket conditional tokens (CT) into the Robin Staking Vault.

Network: **Polygon (chainId 137)**. All token amounts and prices use **6 decimals**.

> **Disclaimer.** This guide and the accompanying code in `[src/](./src)` are provided **as is**, without warranty of any kind, express or implied, including but not limited to fitness for a particular purpose, accuracy, or non-infringement. Robin Markets makes no guarantee that the code is correct, complete, secure, or up to date, and accepts no liability for any loss of funds, opportunity, or data arising from its use. The examples are intentionally minimal - they are a starting point for your own integration, not a production-ready library. Before shipping anything that touches user funds: audit the code, test against a fork, and verify contract addresses and API endpoints against the current deployment.

---

## 1. The big picture

A Polymarket user holds ERC-1155 conditional tokens inside their **Polymarket Gnosis Safe proxy wallet**. They never sign transactions from the proxy directly - they sign with their EOA, and the Safe executes the call via `execTransaction` using a pre-validated signature owned by the EOA.

Polymarket proxy wallets (MagicLink users; signed up via e-mail) are not currently supported because they need to export their private key in order to use Robin.

The new Polymarket DepositWallets (used for every fresh Polymarket account) integrate via the push-deposit flow (section 10) instead of the approve/`batchDeposit` path below. All calls for DepositWallets go through the Polymarket relayer. Please refer to the Polymarket documentation for guidance on how to integrate deposit wallets from their side.

A single Robin deposit/withdraw is therefore a **Safe batch** (multi-send) that contains 2–4
transactions:

**Deposit**

1. `RobinTwapOracle.submitTwap(...)` - refreshes TWAP before deposit
2. `ConditionalTokens.setApprovalForAll(STAKING_VAULT, true)` - let the vault pull CT
3. `RobinStakingVault.batchDeposit(...)` - pair YES/NO, merge to USDC, supply to yield strategy, mint shares
4. `ConditionalTokens.setApprovalForAll(STAKING_VAULT, false)` - revoke

**Withdraw**

1. `RobinTwapOracle.submitTwap(...)`
2. `RobinStakingVault.batchWithdraw(...)` - burns shares, splits USDC back to YES+NO if needed, returns to user

All four/two calls run atomically inside a single `Safe.execTransaction` via MultiSend.

> **Sorting requirement (important).** In every `batchDeposit` / `batchWithdraw` call the
> `conditionIds` array must be **sorted strictly ascending with no duplicates**. The vault
> uses this invariant to detect duplicate-market attacks in O(n) and reverts with
> `UnsortedConditionIds` otherwise. All other batch arrays must use the same permutation.
> See section 8 and the `sortBatchByConditionId` helper in `[shared.ts](./src/shared.ts)`.

---

## 2. Contract addresses (Polygon mainnet)

| Name                 | Address                                                       |
| -------------------- | ------------------------------------------------------------- |
| `SAFE_PROXY_FACTORY` | `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b`                  |
| `STAKING_VAULT`      | `0xcb7444981296D08dA7161B75378e3773DbF5D806` (proxy)          |
| `TWAP_ORACLE`        | `0xf08a02deeB4C7A09fAc8e8C6f8508D724612796f` (proxy)          |
| `ROBIN_LENS`         | `0xDbB59819C5a4d28374a162e375Ce4595c8650dDC`                  |
| `CONDITIONAL_TOKENS` | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (Polymarket CTF) |
| `USDCE`              | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`                  |

---

## 3. Discovering the user's Safe proxy address

The EOA the user connects with is **not** where their CT tokens live. The CTs live in the
Polymarket Gnosis Safe proxy. Compute its address from the EOA:

```ts
const proxyAddress = await publicClient.readContract({
  address: SAFE_PROXY_FACTORY,
  abi: safeProxyFactoryAbi,
  functionName: "computeProxyAddress",
  args: [eoaAddress],
});
```

Check whether the proxy is already deployed:

```ts
const code = await publicClient.getCode({ address: proxyAddress });
const deployed = !!code && code !== "0x";
```

If `deployed === false` you'll need the user to deploy it first (e.g. by performing any
transaction on Polymarket). Robin does **not** deploy this proxy for users.

---

## 4. Listing the user's Polymarket positions

Use Polymarket's public data API. The `user` parameter is the **Safe proxy address**, not the EOA.

```
GET https://data-api.polymarket.com/positions?user={proxyAddress}&sizeThreshold=0.1
```

Each item returned looks roughly like:

```jsonc
{
    "conditionId": "0x...32-byte hex...",
    "asset": "12345...",          // ERC-1155 position id (the YES or NO id depending on `outcome`)
    "outcome": "Yes",             // "Yes" | "No"
    "size": 42.5,                 // human-readable token amount (6 decimals on-chain)
    "title": "Will X happen by Y?",
    "endDate": "2026-12-31T...",
    ...
}
```

Group positions by `conditionId`. For each `conditionId` you'll typically have a YES item and a
NO item (the user might only hold one side).

The on-chain amounts you need for `batchDeposit` are **6-decimal bigints**.

---

## 5. Fetching market metadata (price, end date, etc.)

For display you only really need the current YES price.

```
GET https://gamma-api.polymarket.com/markets/keyset?condition_ids=0x...&condition_ids=0x...&limit=100
```

Each market returned has `outcomePrices` like `"[\"0.42\",\"0.58\"]"`. Index 0 is YES, index 1 is NO.
Convert into a `bigint` using the same 6-decimal scale.

> **CORS / calling from the browser.** The Gamma API is a third-party Polymarket service and does
> not guarantee CORS headers for your origin (the same applies to the questionId lookup in section 8,
> which also hits Gamma, and to the data API in section 4). If a direct browser request is blocked,
> proxy these calls through your own backend. This example runs server-side, so it isn't affected.

---

## 6. Refreshing the TWAP oracle (uses Robin's API)

Before the vault accepts a deposit or withdrawal for a market, that market's TWAP must be fresh.
The Robin frontend exposes an authenticated proxy that the TWAP oracle service sits behind:

```
POST https://app.robin.markets/api/twap/twap
Content-Type: application/json

{ "conditionIds": ["0x...", "0x..."] }
```

The response has one of two shapes:

**Mode A - oracle already submitted on-chain itself (you don't need to do anything)**

```jsonc
{ "txHash": "0x...", "initialized": 0, "skipped": false }
```

If `txHash` is present, the markets are already updated. Skip the `submitTwap` call in your batch.

**Mode B - signed payload, you must submit it**

```jsonc
{
  "markets": [
    {
      "required": true,
      "conditionId": "0x...",
      "startTimestamp": "1700000000",
      "endTimestamp": "1700000300",
      "twapPriceYes": "420000",
      "marketEndedAt": "0",
      "marketEndYesPrice": "0",
    },
  ],
  "signature": "0x...",
  "failed": [],
}
```

You then prepend a `RobinTwapOracle.submitTwap({ markets, signature })` call to your Safe batch.
The struct is `BatchTwapData { TwapData[] markets; bytes signature; }`.

**Short-circuit**: if every returned market has `required === false && marketEndedAt === "0"`, you can skip the `submitTwap` call entirely (it would be a no-op).

> **Coming soon - TEE-attested TWAP oracle.** The TWAP signer currently runs as a regular server-side process. We're migrating it to run inside an [Oasis ROFL](https://docs.oasis.io/build/rofl/) TEE (Trusted Execution Environment), at which point the signing key lives only inside the enclave and the signed payload comes with a remote-attestation proof binding it to a specific ROFL app id. The HTTP request/response shape will stay the same, so no integration changes are required - but you'll be able to verify that the signature you got was produced by code whose source has been published and attested. We'll publish the ROFL app id and a verification  
> snippet here once the migration ships.

---

## 7. Building the Safe batch

The proxy is a Gnosis Safe (L2). The EOA is the only owner with threshold 1, so signatures can be "pre-validated" - no signing required, just include the owner address padded to 32 bytes + `0x01`.

The code uses `**@safe-global/protocol-kit` which abstracts this away.

```ts
import Safe from "@safe-global/protocol-kit";

const safe = await Safe.init({ provider, signer, safeAddress: proxyAddress });
const tx = await safe.createTransaction({
  transactions: [
    { to: TWAP_ORACLE, value: "0", data: submitTwapCalldata },
    { to: CONDITIONAL_TOKENS, value: "0", data: approveAllCalldata },
    { to: STAKING_VAULT, value: "0", data: batchDepositCalldata },
    { to: CONDITIONAL_TOKENS, value: "0", data: revokeAllCalldata },
  ],
});
const result = await safe.executeTransaction(tx, { gasLimit: 5_000_000n });
await publicClient.waitForTransactionReceipt({ hash: result.hash });
```

Under the hood `protocol-kit` deploys/uses the MultiSend contract and wraps everything in a single `execTransaction(...)` call against the proxy.

---

## 8. `batchDeposit` arguments

```solidity
function batchDeposit(
    bytes32[] conditionIds,  // MUST be sorted strictly ascending, no duplicates
    bytes32[] questionIds,   // Polymarket questionId per market (aligned with conditionIds)
    uint256[] yesAmounts,    // CT tokens, 6 decimals (aligned with conditionIds)
    uint256[] noAmounts,     // CT tokens, 6 decimals (aligned with conditionIds)
    uint256 nonZeroLength,   // count of non-zero amounts across both arrays (used for internal array sizing)
    uint256 referralCode     // 0 if none
)
```

Rules:

- **Sorted batch (REQUIRED).** `conditionIds` must be sorted strictly ascending (by `bytes32`
  numeric value). Duplicates revert with `UnsortedConditionIds`. The other arrays must use the
  same permutation. This is how the vault detects duplicate-market attacks in O(n) - sort
  off-chain and you're safe. See `sortBatchByConditionId` in `[shared.ts](./src/shared.ts)`.
- **`questionIds`** must be aligned with `conditionIds`. It's only used to auto-initialise a market
  on its first ever deposit (the vault verifies `conditionId == keccak256(oracle, questionId, 2)`);
  for already-initialised markets the value is ignored, but the array must still be present, aligned,
  and the same length. Source it from Polymarket Gamma's `questionID` field - see `fetchQuestionIds`
  in `[shared.ts](./src/shared.ts)`.
- If your selection covers both YES and NO of the same `conditionId`, **merge them into one row**
  (one `yesAmounts[i]`, one `noAmounts[i]`) before sorting. Two rows with the same conditionId
  will revert.
- For every `i`, at least one of `yesAmounts[i] / noAmounts[i]` must be non-zero.
- `nonZeroLength` must equal the actual count, otherwise the vault reverts.
- The vault transfers tokens from the Safe (msg.sender), which is why you must approve the vault
  on `ConditionalTokens` first.

---

## 9. `batchWithdraw` arguments

```solidity
function batchWithdraw(
    bytes32[] conditionIds,  // MUST be sorted strictly ascending, no duplicates
    uint256[] yesShares,     // ERC-1155 shares to burn, 6 decimals (aligned)
    uint256[] noShares,      // (aligned)
    address yieldRecipient,  // who receives the USDC yield - usually the proxy itself
    uint256 nonZeroLength,
    uint256 referralCode,    // 0 if none
    bool wrapYieldToPolyUsd  // true = wrap USDC.e yield to PolyUSD via Polymarket's CollateralOnramp
)
```

Same sorting rule as `batchDeposit`. Each `conditionId` appears at most once in the batch.

Set `wrapYieldToPolyUsd` to `false` to receive yield as USDC.e (the default), or `true` to have it
wrapped to PolyUSD before transfer to `yieldRecipient`.

You need to know **how many shares the user owns per market and side**. The example reads this from
Robin's API (`fetchDepositedPositions` in `[shared.ts](./src/shared.ts)`):

```
GET https://app.robin.markets/api/positions?address={proxyAddress}&category=active&page=1
```

It returns the user's currently-deposited positions, paginated, each with `yesShares` / `noShares`
(6-decimal strings - the ERC-1155 share balances you burn) and a `positionTvl` (6-decimal USD).
Walk `page=1,2,…` until you've collected `total` rows.

**Alternative - read on-chain via the lens.** If you'd rather not depend on Robin's API, the
`RobinLens` contract returns the same share balances plus their current value in a single call:

```ts
const [yesShares, noShares, yesAssets, noAssets] =
  await publicClient.readContract({
    address: ROBIN_LENS,
    abi: robinLensAbi,
    functionName: "batchGetUserSharesAndAssets",
    args: [proxyAddress, conditionIds],
  });
```

`yesShares` / `noShares` are the share balances to pass to `batchWithdraw`; `yesAssets` / `noAssets`
are the current **loss-adjusted outcome-token amount** those shares are worth.

---

## 10. Push-deposit flow (alternative deposit path)

Instead of the `approve → batchDeposit → revoke` batch shown above, you can deposit in a single CTF
transfer: the user pushes the CT tokens straight to the vault and the vault's
`onERC1155BatchReceived` hook decodes the payload and runs the full deposit pipeline atomically.
See `[deposit-push.ts](./src/deposit-push.ts)` for a runnable version.

```
safe.execTransaction(
    multisend([
        RobinTwapOracle.submitTwap(twapPayload),
        ConditionalTokens.safeBatchTransferFrom(
            safe, vault, ids, values, depositData,
        ),
    ])
)
```

This collapses the 3-call dance into a single transfer and needs no standing approval on
`ConditionalTokens`. It's the only mechanism that lets the new Polymarket "Deposit Wallets" stake:
all calls for those wallets go through the Polymarket relayer, which blocks `approve` calls to the
CTF. The vault's hook runs the full pipeline (pair YES/NO, merge to USDC, mint shares, supply to
yield strategy) inside the same call; if anything reverts, the whole CTF transfer is rolled back, so tokens
never get stuck.

**Building `depositData`**

It is the ABI encoding of the same arguments `batchDeposit` would take:

```solidity
abi.encode(
    bytes32[] conditionIds,    // sorted strictly ascending
    bytes32[] questionIds,     // aligned with conditionIds, from Polymarket Gamma
    uint256[] yesAmounts,      // aligned, 6-decimal
    uint256[] noAmounts,       // aligned, 6-decimal
    uint256 nonZeroLength,
    uint256 referralCode
)
```

**Building `ids` and `values`**

The vault re-derives these locally from `(conditionIds, yes/noAmounts, cached positionIds)` and
compares `keccak256(abi.encode(ids, values))` against what you transferred. Build them the same
way it does, or you'll hit `PushDepositMismatch`:

- Iterate `sortedRows` in ascending conditionId order.
- For each row: if `yesAmount > 0`, push the market's YES positionId then yesAmount. Then if
  `noAmount > 0`, push the NO positionId then noAmount.
- Skip zero sides entirely (they must NOT appear in `ids`/`values`).

The YES/NO position ids are the on-chain ERC-1155 token ids. Polymarket's `/positions` data API
returns this directly as the `asset` field (uint256 as decimal string).

**Wire encoding helper (viem)**

```ts
import { encodeAbiParameters } from "viem";

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
```

Then call:

```ts
ConditionalTokens.safeBatchTransferFrom(safe, vault, ids, values, depositData);
```

**Failure modes specific to push-deposit**

- `PushDepositMismatch` — your `(ids, values)` doesn't equal what the declared payload implies.
  Most common causes: wrong YES/NO ordering, included a zero-amount side, mixed up
  YES/NO positionIds for a neg-risk market.
- `UnsolicitedTransfer` — the inbound transfer isn't from the CTF (i.e. you're trying to push
  some other ERC-1155 to the vault), or your `data` didn't decode as the deposit payload.
- Any other deposit revert (`UnsortedConditionIds`, `ZeroAmount`, `LengthMismatch`, …) — same as
  the pull-deposit path; the CTF transfer is rolled back.

---

## 11. Commands

```bash
npm install
npm run deposit
npm run deposit:push
npm run withdraw
```
