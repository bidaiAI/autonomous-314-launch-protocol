import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";

function normalizePrivateKey(value?: string) {
  if (!value) return undefined;
  return value.startsWith("0x") ? value : `0x${value}`;
}

const defaultDeployerPrivateKey = normalizePrivateKey(process.env.DEPLOYER_PRIVATE_KEY);
const bscDeployerPrivateKey = normalizePrivateKey(process.env.BSC_DEPLOYER_PRIVATE_KEY) ?? defaultDeployerPrivateKey;
const baseDeployerPrivateKey = normalizePrivateKey(process.env.BASE_DEPLOYER_PRIVATE_KEY) ?? defaultDeployerPrivateKey;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 1
      },
      viaIR: true
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  networks: {
    localhost: {
      url: process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545"
    },
    ...(process.env.BSC_RPC_URL && bscDeployerPrivateKey
      ? {
          bsc: {
            url: process.env.BSC_RPC_URL,
            chainId: 56,
            accounts: [bscDeployerPrivateKey]
          }
        }
      : {}),
    ...(process.env.BASE_RPC_URL && baseDeployerPrivateKey
      ? {
          base: {
            url: process.env.BASE_RPC_URL,
            chainId: 8453,
            accounts: [baseDeployerPrivateKey]
          }
        }
      : {})
  }
};

export default config;
