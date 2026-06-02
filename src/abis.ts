// Minimal ABIs for every contract the integration touches.
export const safeProxyFactoryAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "computeProxyAddress",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

export const conditionalTokensAbi = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "setApprovalForAll",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "view",
    name: "balanceOf",
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  // Used by the push-deposit flow. The vault's `onERC1155BatchReceived` decodes `data` as the
  // deposit payload and runs the pipeline atomically.
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "safeBatchTransferFrom",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "ids", type: "uint256[]" },
      { name: "values", type: "uint256[]" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const stakingVaultAbi = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "batchDeposit",
    inputs: [
      { name: "conditionIds", type: "bytes32[]" },
      { name: "questionIds", type: "bytes32[]" },
      { name: "yesAmounts", type: "uint256[]" },
      { name: "noAmounts", type: "uint256[]" },
      { name: "nonZeroLength", type: "uint256" },
      { name: "referralCode", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "batchWithdraw",
    inputs: [
      { name: "conditionIds", type: "bytes32[]" },
      { name: "yesShares", type: "uint256[]" },
      { name: "noShares", type: "uint256[]" },
      { name: "yieldRecipient", type: "address" },
      { name: "nonZeroLength", type: "uint256" },
      { name: "referralCode", type: "uint256" },
      { name: "wrapYieldToPolyUsd", type: "bool" },
    ],
    outputs: [],
  },
] as const;

export const robinLensAbi = [
  {
    type: "function",
    stateMutability: "view",
    name: "batchGetUserSharesAndAssets",
    inputs: [
      { name: "user", type: "address" },
      { name: "conditionIds", type: "bytes32[]" },
    ],
    outputs: [
      { name: "yesShares", type: "uint256[]" },
      { name: "noShares", type: "uint256[]" },
      { name: "yesAssets", type: "uint256[]" },
      { name: "noAssets", type: "uint256[]" },
    ],
  },
] as const;

export const twapOracleAbi = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "submitTwap",
    inputs: [
      {
        name: "twapData",
        type: "tuple",
        components: [
          {
            name: "markets",
            type: "tuple[]",
            components: [
              { name: "required", type: "bool" },
              { name: "conditionId", type: "bytes32" },
              { name: "startTimestamp", type: "uint256" },
              { name: "endTimestamp", type: "uint256" },
              { name: "twapPriceYes", type: "uint256" },
              { name: "marketEndedAt", type: "uint256" },
              { name: "marketEndYesPrice", type: "uint256" },
            ],
          },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [],
  },
] as const;
