# Robin Markets — Staking Vault Integration Guide

This document describes everything a third-party frontend needs to know in order to deposit and withdraw Polymarket conditional tokens (CT) into the Robin Staking Vault.

Network: **Polygon (chainId 137)**. All token amounts and prices use **6 decimals**.

---

## 1. The big picture

A Polymarket user holds ERC-1155 conditional tokens inside their **Polymarket Gnosis Safe proxy wallet**. They never sign transactions from the proxy directly — they sign with their EOA, and the Safe executes the call via `execTransaction` using a pre-validated signature owned by the EOA.

Polymarket proxy wallets (MagicLink users; signed up via e-mail) are not currently supported because they need to export their private key in order to use Robin.

The new Polymarket DepositWallets (used for every fresh Polymarket account) will be supported soon via a special Push-Deposit flow.

A single Robin deposit/withdraw is therefore a **Safe batch** (multi-send) that contains 2–4
transactions:

**Deposit**

1. `RobinTwapOracle.submitTwap(...)` — refreshes TWAP before deposit
2. `ConditionalTokens.setApprovalForAll(STAKING_VAULT, true)` — let the vault pull CT
3. `RobinStakingVault.batchDeposit(...)` — pair YES/NO, merge to USDC, supply to Yearn, mint shares
4. `ConditionalTokens.setApprovalForAll(STAKING_VAULT, false)` — revoke

**Withdraw**

1. `RobinTwapOracle.submitTwap(...)`
2. `RobinStakingVault.batchWithdraw(...)` — burns shares, splits USDC back to YES+NO if needed, returns to user

All four/two calls run atomically inside a single `Safe.execTransaction` via MultiSend.

> **Sorting requirement (important).** In every `batchDeposit` / `batchWithdraw` call the
> `conditionIds` array must be **sorted strictly ascending with no duplicates**. The vault
> uses this invariant to detect duplicate-market attacks in O(n) and reverts with
> `UnsortedConditionIds` otherwise. All other batch arrays must use the same permutation.
> See section 8 and the `sortBatchByConditionId` helper in `[shared.ts](./shared.ts)`.

---

## 2. Contract addresses (Polygon mainnet)

| Name                 | Address                                                       |
| -------------------- | ------------------------------------------------------------- |
| `SAFE_PROXY_FACTORY` | `0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b`                  |
| `STAKING_VAULT`      | `0xcb7444981296D08dA7161B75378e3773DbF5D806` (proxy)          |
| `TWAP_ORACLE`        | `0xf08a02deeB4C7A09fAc8e8C6f8508D724612796f` (proxy)          |
| `ROBIN_LENS`         | `0x6131F4111B848Ca7aE2df06fDaF1EC9BCfb18032`                  |
| `CONDITIONAL_TOKENS` | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` (Polymarket CTF) |
| `USDCE`              | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`                  |
| `YEARN_USDCE_VAULT`  | `0x335Bc8366545FaA446e0c1f639617aC40061f2EF`                  |

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

**Mode A — oracle already submitted on-chain itself (you don't need to do anything)**

```jsonc
{ "txHash": "0x...", "initialized": 0, "skipped": false }
```

If `txHash` is present, the markets are already updated. Skip the `submitTwap` call in your batch.

**Mode B — signed payload, you must submit it**

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

> **Coming soon — TEE-attested TWAP oracle.** The TWAP signer currently runs as a regular server-side process. We're migrating it to run inside an [Oasis ROFL](https://docs.oasis.io/build/rofl/) TEE (Trusted Execution Environment), at which point the signing key lives only inside the enclave and the signed payload comes with a remote-attestation proof binding it to a specific ROFL app id. The HTTP request/response shape will stay the same, so no integration changes are required — but you'll be able to verify that the signature you got was produced by code whose source has been published and attested. We'll publish the ROFL app id and a verification  
> snippet here once the migration ships.

---

## 7. Building the Safe batch

The proxy is a Gnosis Safe (L2). The EOA is the only owner with threshold 1, so signatures can be "pre-validated" — no signing required, just include the owner address padded to 32 bytes + `0x01`.

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
    uint256[] yesAmounts,    // CT tokens, 6 decimals (aligned with conditionIds)
    uint256[] noAmounts,     // CT tokens, 6 decimals (aligned with conditionIds)
    uint256 nonZeroLength,   // count of non-zero amounts across both arrays (used for internal array sizing)
    uint256 referralCode     // 0 if none
)
```

Rules:

- **Sorted batch (REQUIRED).** `conditionIds` must be sorted strictly ascending (by `bytes32`
  numeric value). Duplicates revert with `UnsortedConditionIds`. The other arrays must use the
  same permutation. This is how the vault detects duplicate-market attacks in O(n) — sort
  off-chain and you're safe. See `sortBatchByConditionId` in `[shared.ts](./shared.ts)`.
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
    address yieldRecipient,  // who receives the USDC yield — usually the proxy itself
    uint256 nonZeroLength,
    uint256 referralCode     // 0 if none
)
```

Same sorting rule as `batchDeposit`. Each `conditionId` appears at most once in the batch.

You need to know **how many shares the user owns per market and side**. Use the lens contract:

```ts
const portfolio = await publicClient.readContract({
  address: ROBIN_LENS,
  abi: robinLensAbi,
  functionName: "batchGetUserPortfolio",
  args: [proxyAddress, conditionIds, twapPricesYes],
});
// Returns [yesShares[], noShares[], yesAssets[], noAssets[], yesYield[], noYield[]]
```

For the `twapPricesYes` argument you can pass the constant `IGNORE_TWAP_PRICE = 1_000_001n`(PRICE_SCALE + 1) if you don't care about the yield breakdown — the shares/assets fields are still correct.

---

## 10. Upcoming contract upgrade

Some changes are coming to the vault. The example code already has them prepared as
commented-out blocks so you can flip them on when the upgrade ships:

`**batchDeposit` — gains `bytes32[] questionIds` between `conditionIds` and `yesAmounts`. Used only for auto-initialising new markets; for already-initialised markets the value is ignored but the array must still be aligned and the same length as `conditionIds`. Source the value from Polymarket Gamma's `questionID` field (helper: `fetchQuestionIds` in
`[shared.ts](./shared.ts)`).

```solidity
function batchDeposit(
    bytes32[] conditionIds,
    bytes32[] questionIds,   // NEW — aligned with conditionIds
    uint256[] yesAmounts,
    uint256[] noAmounts,
    uint256 nonZeroLength,
    uint256 referralCode
)
```

`**batchWithdraw**` — gains a trailing `bool wrapYieldToPolyUsd`. When `true`, USDC.e yield is wrapped to PolyUSD via Polymarket's `CollateralOnramp` before being transferred to `yieldRecipient`.

```solidity
function batchWithdraw(
    bytes32[] conditionIds,
    uint256[] yesShares,
    uint256[] noShares,
    address yieldRecipient,
    uint256 nonZeroLength,
    uint256 referralCode,
    bool wrapYieldToPolyUsd  // NEW
)
```

**Push-deposit flow (new, recommended after the upgrade)**. The vault then uses `onERC1155BatchReceived` for deposits, so the user can push CT tokens to the vault in a single CTF transfer and the vault runs the full deposit pipeline atomically inside the hook. This replaces the 3-call `approve / batchDeposit / revoke` dance with a single `safeBatchTransferFrom` and removes the need for any standing approval on `ConditionalTokens`. This new flow will enable deposits from the new Plymarket "Deposit Wallets". A code example and better explanation will follow after the upgrade.

---

## 11. Commands

```bash
npm install
npm run deposit
npm run withdraw
```
