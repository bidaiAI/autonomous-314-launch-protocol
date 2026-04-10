import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "..", "..", "..");
const sourceRoot = join(repoRoot, "packages", "contracts", "artifacts");
const targetRoot = join(repoRoot, "apps", "indexer", "verification-artifacts");

const artifactPairs = [
  ["contracts/LaunchFactory.sol", "LaunchFactory"],
  ["contracts/LaunchToken.sol", "LaunchToken"],
  ["contracts/LaunchTokenWhitelist.sol", "LaunchTokenWhitelist"],
  ["contracts/LaunchTokenTaxed.sol", "LaunchTokenTaxed"],
  ["contracts/LaunchTokenWhitelistTaxed.sol", "LaunchTokenWhitelistTaxed"],
  ["contracts/LaunchTokenDeployer.sol", "LaunchTokenDeployer"],
  ["contracts/LaunchTokenWhitelistDeployer.sol", "LaunchTokenWhitelistDeployer"],
  ["contracts/LaunchTokenTaxedDeployer.sol", "LaunchTokenTaxedDeployer"],
  ["contracts/LaunchCreate2Deployer.sol", "LaunchCreate2Deployer"]
];

rmSync(targetRoot, { recursive: true, force: true });

const copiedBuildInfo = new Set();

for (const [sourceName, contractName] of artifactPairs) {
  const artifactRelativePath = join(sourceName, `${contractName}.json`);
  const debugRelativePath = join(sourceName, `${contractName}.dbg.json`);

  const sourceArtifactPath = join(sourceRoot, artifactRelativePath);
  const sourceDebugPath = join(sourceRoot, debugRelativePath);
  const targetArtifactPath = join(targetRoot, artifactRelativePath);
  const targetDebugPath = join(targetRoot, debugRelativePath);

  mkdirSync(dirname(targetArtifactPath), { recursive: true });
  cpSync(sourceArtifactPath, targetArtifactPath);
  cpSync(sourceDebugPath, targetDebugPath);

  const debugArtifact = JSON.parse(readFileSync(sourceDebugPath, "utf-8"));
  const buildInfoPath = resolve(dirname(sourceDebugPath), debugArtifact.buildInfo);
  const targetBuildInfoPath = resolve(dirname(targetDebugPath), debugArtifact.buildInfo);
  const buildInfoKey = targetBuildInfoPath;

  if (!copiedBuildInfo.has(buildInfoKey)) {
    mkdirSync(dirname(targetBuildInfoPath), { recursive: true });
    cpSync(buildInfoPath, targetBuildInfoPath);
    copiedBuildInfo.add(buildInfoKey);
  }
}

console.log(`Synced verification artifacts to ${targetRoot}`);
