import factoryArtifact from "./artifacts/LaunchFactory.json";
import tokenArtifact from "./artifacts/LaunchToken.json";
import whitelistTokenArtifact from "./artifacts/LaunchTokenWhitelist.json";
import taxedTokenArtifact from "../../../packages/contracts/artifacts/contracts/LaunchTokenTaxed.sol/LaunchTokenTaxed.json";
import whitelistTaxedTokenArtifact from "../../../packages/contracts/artifacts/contracts/LaunchTokenWhitelistTaxed.sol/LaunchTokenWhitelistTaxed.json";
import pairArtifact from "./artifacts/IUniswapV2LikePair.json";

const extraFactoryAbi = [
  {
    type: "function",
    name: "modeOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "standardDeployer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "whitelistDeployer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "taxedDeployer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "whitelistTaxedDeployer",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }]
  },
  {
    type: "function",
    name: "pendingModeOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "createTaxLaunch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "taxBps", type: "uint16" },
      { name: "burnShareBps", type: "uint16" },
      { name: "treasuryShareBps", type: "uint16" },
      { name: "treasuryWallet", type: "address" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createLaunchAndBuy",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "minTokenOut", type: "uint256" }
    ],
    outputs: [{ name: "token", type: "address" }, { name: "tokenOut", type: "uint256" }]
  },
  {
    type: "function",
    name: "createLaunchAndBuyWithSalt",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "salt", type: "bytes32" },
      { name: "minTokenOut", type: "uint256" }
    ],
    outputs: [{ name: "token", type: "address" }, { name: "tokenOut", type: "uint256" }]
  },
  {
    type: "function",
    name: "createWhitelistLaunch",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "whitelistThreshold", type: "uint256" },
      { name: "whitelistSlotSize", type: "uint256" },
      { name: "whitelistAddresses", type: "address[]" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createWhitelistLaunchWithSalt",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "whitelistThreshold", type: "uint256" },
      { name: "whitelistSlotSize", type: "uint256" },
      { name: "whitelistAddresses", type: "address[]" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createWhitelistLaunchAndCommit",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "whitelistThreshold", type: "uint256" },
      { name: "whitelistSlotSize", type: "uint256" },
      { name: "whitelistAddresses", type: "address[]" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createWhitelistLaunchAndCommitWithSalt",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "whitelistThreshold", type: "uint256" },
      { name: "whitelistSlotSize", type: "uint256" },
      { name: "whitelistAddresses", type: "address[]" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createTaxLaunchWithSalt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "taxBps", type: "uint16" },
      { name: "burnShareBps", type: "uint16" },
      { name: "treasuryShareBps", type: "uint16" },
      { name: "treasuryWallet", type: "address" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createTaxLaunchAndBuy",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "taxBps", type: "uint16" },
      { name: "burnShareBps", type: "uint16" },
      { name: "treasuryShareBps", type: "uint16" },
      { name: "treasuryWallet", type: "address" },
      { name: "minTokenOut", type: "uint256" }
    ],
    outputs: [{ name: "token", type: "address" }, { name: "tokenOut", type: "uint256" }]
  },
  {
    type: "function",
    name: "createTaxLaunchAndBuyWithSalt",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "taxBps", type: "uint16" },
      { name: "burnShareBps", type: "uint16" },
      { name: "treasuryShareBps", type: "uint16" },
      { name: "treasuryWallet", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "minTokenOut", type: "uint256" }
    ],
    outputs: [{ name: "token", type: "address" }, { name: "tokenOut", type: "uint256" }]
  },
  {
    type: "function",
    name: "createWhitelistTaxLaunch",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      {
        name: "whitelistConfig",
        type: "tuple",
        components: [
          { name: "whitelistThreshold", type: "uint256" },
          { name: "whitelistSlotSize", type: "uint256" },
          { name: "whitelistAddresses", type: "address[]" }
        ]
      },
      {
        name: "taxConfig",
        type: "tuple",
        components: [
          { name: "taxBps", type: "uint16" },
          { name: "burnShareBps", type: "uint16" },
          { name: "treasuryShareBps", type: "uint16" },
          { name: "treasuryWallet", type: "address" }
        ]
      },
      { name: "initCode", type: "bytes" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createWhitelistTaxLaunchWithSalt",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      {
        name: "whitelistConfig",
        type: "tuple",
        components: [
          { name: "whitelistThreshold", type: "uint256" },
          { name: "whitelistSlotSize", type: "uint256" },
          { name: "whitelistAddresses", type: "address[]" }
        ]
      },
      {
        name: "taxConfig",
        type: "tuple",
        components: [
          { name: "taxBps", type: "uint16" },
          { name: "burnShareBps", type: "uint16" },
          { name: "treasuryShareBps", type: "uint16" },
          { name: "treasuryWallet", type: "address" }
        ]
      },
      { name: "initCode", type: "bytes" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createWhitelistTaxLaunchAndCommit",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      {
        name: "whitelistConfig",
        type: "tuple",
        components: [
          { name: "whitelistThreshold", type: "uint256" },
          { name: "whitelistSlotSize", type: "uint256" },
          { name: "whitelistAddresses", type: "address[]" }
        ]
      },
      {
        name: "taxConfig",
        type: "tuple",
        components: [
          { name: "taxBps", type: "uint16" },
          { name: "burnShareBps", type: "uint16" },
          { name: "treasuryShareBps", type: "uint16" },
          { name: "treasuryWallet", type: "address" }
        ]
      },
      { name: "initCode", type: "bytes" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "createWhitelistTaxLaunchAndCommitWithSalt",
    stateMutability: "payable",
    inputs: [
      { name: "name", type: "string" },
      { name: "symbol", type: "string" },
      { name: "metadataURI", type: "string" },
      {
        name: "whitelistConfig",
        type: "tuple",
        components: [
          { name: "whitelistThreshold", type: "uint256" },
          { name: "whitelistSlotSize", type: "uint256" },
          { name: "whitelistAddresses", type: "address[]" }
        ]
      },
      {
        name: "taxConfig",
        type: "tuple",
        components: [
          { name: "taxBps", type: "uint16" },
          { name: "burnShareBps", type: "uint16" },
          { name: "treasuryShareBps", type: "uint16" },
          { name: "treasuryWallet", type: "address" }
        ]
      },
      { name: "initCode", type: "bytes" },
      { name: "salt", type: "bytes32" }
    ],
    outputs: [{ name: "token", type: "address" }]
  },
  {
    type: "function",
    name: "batchClaimProtocolFees",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokens", type: "address[]" },
      { name: "recipient", type: "address" }
    ],
    outputs: [
      { name: "totalClaimed", type: "uint256" },
      { name: "claimedCount", type: "uint256" }
    ]
  },
  {
    type: "function",
    name: "batchSweepAbandonedCreatorFees",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokens", type: "address[]" }],
    outputs: [
      { name: "totalSwept", type: "uint256" },
      { name: "sweptCount", type: "uint256" }
    ]
  }
] as const;

const extraTokenAbi = [
  {
    type: "function",
    name: "taxConfig",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "enabled", type: "bool" },
      { name: "configuredTaxBps", type: "uint16" },
      { name: "burnBps", type: "uint16" },
      { name: "treasuryBps", type: "uint16" },
      { name: "wallet", type: "address" },
      { name: "active", type: "bool" }
    ]
  }
] as const;

export const launchFactoryAbi = [...factoryArtifact.abi, ...extraFactoryAbi] as const;
export const launchTokenAbi = [...tokenArtifact.abi, ...extraTokenAbi] as const;
export const launchTokenWhitelistAbi = [...whitelistTokenArtifact.abi, ...extraTokenAbi] as const;
export const launchTokenTaxedAbi = [...taxedTokenArtifact.abi, ...extraTokenAbi] as const;
export const launchTokenWhitelistTaxedAbi = [...whitelistTaxedTokenArtifact.abi, ...extraTokenAbi] as const;
export const v2PairAbi = pairArtifact.abi;
export const launchTokenBytecode = tokenArtifact.bytecode as `0x${string}`;
export const launchTokenWhitelistBytecode = whitelistTokenArtifact.bytecode as `0x${string}`;
export const launchTokenTaxedBytecode = taxedTokenArtifact.bytecode as `0x${string}`;
export const launchTokenWhitelistTaxedBytecode = whitelistTaxedTokenArtifact.bytecode as `0x${string}`;
