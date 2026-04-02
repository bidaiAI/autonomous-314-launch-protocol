import { readFile } from "fs/promises";
import net from "net";
import path from "path";
import process from "process";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const currentFile = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(currentFile), "..");
const demoConfigPath = path.join(workspaceRoot, ".demo/local-demo.json");
const localRpcPort = 8545;
const indexerPort = 8787;

const children = [];

function spawnLogged(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: workspaceRoot,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false
  });

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${name}] ${chunk}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${name}] ${chunk}`);
  });

  children.push(child);
  return child;
}

function runOnce(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnLogged(name, command, args, options);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${name} exited with code ${code ?? "null"}`));
    });
  });
}

async function waitForTcp(port, label, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.destroy();
          resolve(undefined);
        });
        socket.on("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`Timed out waiting for ${label} on port ${port}`);
}

function terminateChildren() {
  for (const child of children) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
}

async function main() {
  process.on("SIGINT", () => {
    terminateChildren();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    terminateChildren();
    process.exit(0);
  });

  console.log("[demo] starting local Hardhat node");
  spawnLogged("node", "pnpm", ["--filter", "@autonomous314/contracts", "node"]);
  await waitForTcp(localRpcPort, "Hardhat node");

  console.log("[demo] deploying local demo profile (0.2 BNB graduation)");
  await runOnce("deploy", "pnpm", ["--filter", "@autonomous314/contracts", "demo:local"], {
    env: {
      LOCAL_DEMO_RPC_URL: "http://127.0.0.1:8545",
      LOCAL_DEMO_GRADUATION_TARGET_BNB: process.env.LOCAL_DEMO_GRADUATION_TARGET_BNB ?? "0.2",
      LOCAL_DEMO_CREATE_FEE_BNB: process.env.LOCAL_DEMO_CREATE_FEE_BNB ?? "0.03",
      LOCAL_DEMO_INDEXER_API_URL: "http://127.0.0.1:8787"
    }
  });

  const demoConfig = JSON.parse(await readFile(demoConfigPath, "utf8"));
  const sharedEnv = {
    VITE_RPC_URL: demoConfig.rpcUrl,
    VITE_CHAIN_ID: String(demoConfig.chainId),
    VITE_FACTORY_ADDRESS: demoConfig.factory,
    VITE_INDEXER_API_URL: "http://127.0.0.1:8787",
    INDEXER_RPC_URL: demoConfig.rpcUrl,
    INDEXER_CHAIN_ID: String(demoConfig.chainId),
    INDEXER_FACTORY_ADDRESS: demoConfig.factory,
    INDEXER_PORT: String(indexerPort),
    INDEXER_CACHE_TTL_MS: process.env.INDEXER_CACHE_TTL_MS ?? "15000"
  };

  console.log("[demo] starting indexer API");
  spawnLogged("indexer", "pnpm", ["--filter", "@autonomous314/indexer", "serve"], {
    env: sharedEnv
  });
  await waitForTcp(indexerPort, "indexer API");

  console.log("[demo] starting web app");
  spawnLogged("web", "pnpm", ["--filter", "@autonomous314/web", "dev"], {
    env: sharedEnv
  });

  console.log("\n[demo] local stack ready");
  console.log(`[demo] factory: ${demoConfig.factory}`);
  console.log(`[demo] router: ${demoConfig.router}`);
  console.log(`[demo] graduation target: ${demoConfig.graduationQuoteReserve} BNB`);
  console.log("[demo] rpc: http://127.0.0.1:8545");
  console.log("[demo] indexer: http://127.0.0.1:8787/health");
  console.log("[demo] web: http://127.0.0.1:4173");
  console.log("[demo] connect your wallet to Local Hardhat (chainId 31337) before interacting.");
}

void main().catch((error) => {
  terminateChildren();
  console.error("[demo] fatal", error);
  process.exitCode = 1;
});
