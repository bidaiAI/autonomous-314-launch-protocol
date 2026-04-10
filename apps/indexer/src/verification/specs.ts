import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { encodeDeployData, getAddress, type Abi, type Hex } from "viem";

export type ContractBuildSpec = {
  contractIdentifier: string;
  sourceName: string;
  contractName: string;
  abi: Abi;
  bytecode: Hex;
  compilerVersion: string;
  stdJsonInput: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type BootstrapVerificationTarget = {
  address: `0x${string}`;
  contractIdentifier: string;
  creationTransactionHash: `0x${string}`;
  label: string;
  source: "official";
};

const officialFactoryWhitelistPresetsByChain: Record<number, { thresholds: bigint[]; slotSizes: bigint[] }> = {
  56: {
    thresholds: [4n * 10n ** 18n, 6n * 10n ** 18n, 8n * 10n ** 18n],
    slotSizes: [1n * 10n ** 17n, 2n * 10n ** 17n, 5n * 10n ** 17n, 1n * 10n ** 18n]
  },
  8453: {
    thresholds: [1n * 10n ** 18n, 2n * 10n ** 18n, 3n * 10n ** 18n],
    slotSizes: [4n * 10n ** 16n, 1n * 10n ** 17n, 2n * 10n ** 17n, 25n * 10n ** 16n]
  }
};

type BuildInfoFile = {
  input: Record<string, unknown>;
  output: {
    contracts: Record<string, Record<string, { metadata?: string }>>;
  };
  solcVersion: string;
  solcLongVersion?: string;
};

type ArtifactJson = {
  abi: Abi;
  bytecode: Hex;
  contractName: string;
  sourceName: string;
};

type DebugArtifactJson = {
  buildInfo: string;
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "..", "..", "..", "..");
const bundledArtifactsRoot = resolve(moduleDir, "..", "..", "verification-artifacts");
const bundledBscLegacyArtifactsRoot = resolve(moduleDir, "..", "..", "verification-artifacts-bsc-legacy");
const officialBscFactoryAddress = getAddress("0xa5d62930AA7CDD332B6bF1A32dB0cC7095FC0314");

const buildSpecCache = new Map<string, ContractBuildSpec>();
const solidityMetadataMarkers = [
  "a264697066735822",
  "a264697066735820",
  "a165627a7a72305820"
] as const;

const officialBscBootstrapTargets: BootstrapVerificationTarget[] = [
  {
    address: getAddress("0x8FcAf0Fe7e49245d3f28f04e7b91978aBdD38A71"),
    contractIdentifier: "contracts/LaunchTokenDeployer.sol:LaunchTokenDeployer",
    creationTransactionHash: "0xe7bf7a28e85e222a5387ef4ae520262217ff65be75d023fa8534c497f4119d36",
    label: "Official LaunchTokenDeployer",
    source: "official"
  },
  {
    address: getAddress("0x6E70b0eCcF42D2d8358daD89Fe37cfA1F8c8a9F2"),
    contractIdentifier: "contracts/LaunchTokenWhitelistDeployer.sol:LaunchTokenWhitelistDeployer",
    creationTransactionHash: "0xcd77bf0e98327158f16c1645a9c2f0bc8b6c5589862ecc8344ef831723856140",
    label: "Official LaunchTokenWhitelistDeployer",
    source: "official"
  },
  {
    address: getAddress("0x9a5CD709C9B0a18bD7BD5C8a2f637cbE5087D1B9"),
    contractIdentifier: "contracts/LaunchTokenTaxedDeployer.sol:LaunchTokenTaxedDeployer",
    creationTransactionHash: "0x29e4824246581158804daa1d86aaba675f04f1e497166eac9961872f394bdd82",
    label: "Official LaunchTokenTaxedDeployer",
    source: "official"
  },
  {
    address: getAddress("0xcDc3D935b2349CF282e5517a8126B0fA890631e5"),
    contractIdentifier: "contracts/LaunchCreate2Deployer.sol:LaunchCreate2Deployer",
    creationTransactionHash: "0x18bc4724f5275a3fc4fd2e4c476c9e8c1d140b5a4d3eceffbdec8e8d5e024260",
    label: "Official LaunchCreate2Deployer",
    source: "official"
  },
  {
    address: getAddress("0xa5d62930AA7CDD332B6bF1A32dB0cC7095FC0314"),
    contractIdentifier: "contracts/LaunchFactory.sol:LaunchFactory",
    creationTransactionHash: "0xf77b68c21d31c51f0dbbffb5756f233c9a6718d49f549c262220d92a875afc06",
    label: "Official LaunchFactory",
    source: "official"
  }
];

const officialBaseBootstrapTargets: BootstrapVerificationTarget[] = [
  {
    address: getAddress("0xc6611f07a35222095A78Be7fa6e5f5E3B9585e83"),
    contractIdentifier: "contracts/LaunchTokenDeployer.sol:LaunchTokenDeployer",
    creationTransactionHash: "0x971a8396501b0687b3cc3090c8e413fcc9df5fd0a57ff8d0355d27b2022863d4",
    label: "Official LaunchTokenDeployer",
    source: "official"
  },
  {
    address: getAddress("0x502C1605B17E2c0B67Dd4C855E095989945aB3cc"),
    contractIdentifier: "contracts/LaunchTokenWhitelistDeployer.sol:LaunchTokenWhitelistDeployer",
    creationTransactionHash: "0x34972b27827172cef5e3058da9f69a7f596f281412f6e18d4a87f95760e3c20f",
    label: "Official LaunchTokenWhitelistDeployer",
    source: "official"
  },
  {
    address: getAddress("0xA45921Dc733188c8C68D017984224E0EC125b095"),
    contractIdentifier: "contracts/LaunchTokenTaxedDeployer.sol:LaunchTokenTaxedDeployer",
    creationTransactionHash: "0xb6086624c3eaf66d3011caa02f30c3319c093fd2b932251e84aec202bb27f3e2",
    label: "Official LaunchTokenTaxedDeployer",
    source: "official"
  },
  {
    address: getAddress("0xf0Ef9342fB2866580F4d428E6FF00E5394E15182"),
    contractIdentifier: "contracts/LaunchCreate2Deployer.sol:LaunchCreate2Deployer",
    creationTransactionHash: "0xaf3eb01d437c08bea997c039492e1bb51e2c546988e2e02c7f16986526075920",
    label: "Official LaunchCreate2Deployer",
    source: "official"
  },
  {
    address: getAddress("0x6fDE83bB814AC79D1267695d532e2Dd9d16A0314"),
    contractIdentifier: "contracts/LaunchFactory.sol:LaunchFactory",
    creationTransactionHash: "0x66f47b312f40ccff7c22f52bffc0b4610c0c091e42d5ea3409a3e4926b2f6814",
    label: "Official LaunchFactory",
    source: "official"
  }
];

const officialBootstrapTargetsByChain: Record<number, BootstrapVerificationTarget[]> = {
  56: officialBscBootstrapTargets,
  8453: officialBaseBootstrapTargets
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export function shouldUseLegacyBscArtifactsFor(chainId?: number | null, factoryAddress?: string) {
  if (chainId !== 56 || !factoryAddress) {
    return false;
  }

  try {
    return getAddress(factoryAddress) === officialBscFactoryAddress;
  } catch {
    return false;
  }
}

function resolveCandidateArtifactsRoots() {
  const runtimeChainId = process.env.INDEXER_CHAIN_ID ? Number(process.env.INDEXER_CHAIN_ID) : null;
  const runtimeFactoryAddress = process.env.INDEXER_FACTORY_ADDRESS;
  const roots = [
    process.env.INDEXER_VERIFICATION_ARTIFACTS_ROOT
      ? resolve(process.env.INDEXER_VERIFICATION_ARTIFACTS_ROOT)
      : null,
    shouldUseLegacyBscArtifactsFor(runtimeChainId, runtimeFactoryAddress) ? bundledBscLegacyArtifactsRoot : null,
    join(repoRoot, "packages", "contracts", "artifacts"),
    bundledArtifactsRoot
  ].filter((root): root is string => Boolean(root));

  return [...new Set(roots)];
}

function resolveArtifactPaths(contractIdentifier: string) {
  const [sourceName, contractName] = contractIdentifier.split(":");
  if (!sourceName || !contractName) {
    throw new Error(`Invalid contract identifier: ${contractIdentifier}`);
  }

  const candidateArtifactsRoots = resolveCandidateArtifactsRoots();

  for (const artifactsRoot of candidateArtifactsRoots) {
    const artifactPath = join(artifactsRoot, sourceName, `${contractName}.json`);
    const debugArtifactPath = join(artifactsRoot, sourceName, `${contractName}.dbg.json`);
    if (existsSync(artifactPath) && existsSync(debugArtifactPath)) {
      return {
        sourceName,
        contractName,
        artifactPath,
        debugArtifactPath
      };
    }
  }

  throw new Error(
    `Missing artifact files for ${contractIdentifier} in ${candidateArtifactsRoots.join(", ")}`
  );
}

export function loadContractBuildSpec(contractIdentifier: string): ContractBuildSpec {
  const { sourceName, contractName, artifactPath, debugArtifactPath } = resolveArtifactPaths(contractIdentifier);
  const cacheKey = `${artifactPath}:${contractIdentifier}`;
  const cached = buildSpecCache.get(cacheKey);
  if (cached) return cached;

  const artifact = readJson<ArtifactJson>(artifactPath);
  const debugArtifact = readJson<DebugArtifactJson>(debugArtifactPath);
  const buildInfoPath = resolve(dirname(debugArtifactPath), debugArtifact.buildInfo);
  const buildInfo = readJson<BuildInfoFile>(buildInfoPath);
  const metadataRaw = buildInfo.output.contracts[sourceName]?.[contractName]?.metadata;

  if (!metadataRaw) {
    throw new Error(`Missing metadata for ${contractIdentifier}`);
  }

  const spec: ContractBuildSpec = {
    contractIdentifier,
    sourceName,
    contractName,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    compilerVersion: buildInfo.solcLongVersion ?? buildInfo.solcVersion,
    stdJsonInput: buildInfo.input,
    metadata: JSON.parse(metadataRaw) as Record<string, unknown>
  };

  buildSpecCache.set(cacheKey, spec);
  return spec;
}

export function encodeConstructorArguments(contractIdentifier: string, args: readonly unknown[]): Hex {
  const spec = loadContractBuildSpec(contractIdentifier);
  const deployData = encodeDeployData({
    abi: spec.abi,
    bytecode: spec.bytecode,
    args
  });
  return (`0x${deployData.slice(spec.bytecode.length)}` || "0x") as Hex;
}

export function constructorInputCount(contractIdentifier: string) {
  const spec = loadContractBuildSpec(contractIdentifier);
  const constructorAbi = spec.abi.find((entry) => entry.type === "constructor");
  return constructorAbi?.type === "constructor" ? constructorAbi.inputs.length : 0;
}

function findSolidityMetadataStart(bytecode: Hex) {
  const normalized = bytecode.toLowerCase();
  let index = -1;
  for (const marker of solidityMetadataMarkers) {
    index = Math.max(index, normalized.lastIndexOf(marker));
  }
  return index >= 0 ? index : null;
}

function hasCompatibleCreationPrefix(bytecode: Hex, creationInput: Hex) {
  if (creationInput.startsWith(bytecode)) {
    return true;
  }

  if (creationInput.length < bytecode.length) {
    return false;
  }

  const metadataStart = findSolidityMetadataStart(bytecode);
  if (metadataStart === null) {
    return false;
  }

  const expectedPrefix = bytecode.toLowerCase();
  const actualPrefix = creationInput.slice(0, bytecode.length).toLowerCase();
  return actualPrefix.slice(0, metadataStart) === expectedPrefix.slice(0, metadataStart);
}

export function extractConstructorArgumentsFromCreationInput(contractIdentifier: string, creationInput: Hex): Hex {
  const spec = loadContractBuildSpec(contractIdentifier);
  if (!hasCompatibleCreationPrefix(spec.bytecode, creationInput)) {
    throw new Error(`Creation input for ${contractIdentifier} does not match artifact bytecode prefix`);
  }
  return (`0x${creationInput.slice(spec.bytecode.length)}` || "0x") as Hex;
}

export function findSolidityMetadataStartForTest(bytecode: Hex) {
  return findSolidityMetadataStart(bytecode);
}

export function launchContractIdentifierForMode(mode: number) {
  if (mode === 1) return "contracts/LaunchToken.sol:LaunchToken";
  if (mode === 2) return "contracts/LaunchTokenWhitelist.sol:LaunchTokenWhitelist";
  if (mode >= 3 && mode <= 11) return "contracts/LaunchTokenTaxed.sol:LaunchTokenTaxed";
  if (mode === 12) return "contracts/LaunchTokenWhitelistTaxed.sol:LaunchTokenWhitelistTaxed";
  throw new Error(`Unsupported launch mode for verification: ${mode}`);
}

export function officialBootstrapTargetsFor(chainId: number, factoryAddress?: `0x${string}`) {
  const targets = officialBootstrapTargetsByChain[chainId] ?? [] as BootstrapVerificationTarget[];
  if (chainId === 56) {
    if (factoryAddress && getAddress(factoryAddress) !== officialBscBootstrapTargets[4].address) {
      return [] as BootstrapVerificationTarget[];
    }
    return targets;
  }
  if (chainId === 8453) {
    if (factoryAddress && getAddress(factoryAddress) !== officialBaseBootstrapTargets[4].address) {
      return [] as BootstrapVerificationTarget[];
    }
    return targets;
  }
  return targets;
}

export function officialFactoryWhitelistPresetsFor(chainId: number) {
  return officialFactoryWhitelistPresetsByChain[chainId] ?? null;
}
