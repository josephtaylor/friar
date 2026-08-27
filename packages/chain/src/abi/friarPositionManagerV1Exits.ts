// Exit verbs as they existed on pre-2026-07-27 managers, kept so retired deployments stay
// callable from the UI forever. Those managers lack maxPay0/maxPay1 — the caps that stop a
// zap venue's hook from settling a debt against the owner's wallet — so exits here should
// prefer no-zap (`zap.enabled = false`), which routes through no hook at all.
//
// Hand-written on purpose: this is a frozen historical interface, not a generated artifact.
// Do NOT regenerate it from the current contract.
export const friarPositionManagerV1ExitsAbi = [
  {
    type: "function",
    name: "close",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      {
        name: "zap",
        type: "tuple",
        components: [
          { name: "enabled", type: "bool" },
          {
            name: "venue",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
        ],
      },
      { name: "minReceive0", type: "uint256" },
      { name: "minReceive1", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      {
        name: "zap",
        type: "tuple",
        components: [
          { name: "enabled", type: "bool" },
          {
            name: "venue",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
        ],
      },
      { name: "minReceive0", type: "uint256" },
      { name: "minReceive1", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "decrease",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "liquidityDeltas", type: "uint128[]" },
      {
        name: "zap",
        type: "tuple",
        components: [
          { name: "enabled", type: "bool" },
          {
            name: "venue",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
        ],
      },
      { name: "minReceive0", type: "uint256" },
      { name: "minReceive1", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
