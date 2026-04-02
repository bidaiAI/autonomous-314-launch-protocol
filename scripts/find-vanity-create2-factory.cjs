#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

function requireWorkspaceEthers() {
  const workspaceRoot = path.resolve(__dirname, "..");
  const pnpmDir = path.join(workspaceRoot, "node_modules", ".pnpm");
  const entries = fs.existsSync(pnpmDir) ? fs.readdirSync(pnpmDir) : [];
  const ethersEntry = entries
    .filter((entry) => entry.startsWith("ethers@"))
    .sort()
    .reverse()[0];

  if (!ethersEntry) {
    throw new Error(`Unable to locate ethers package under ${pnpmDir}`);
  }

  return require(path.join(pnpmDir, ethersEntry, "node_modules", "ethers"));
}

function parseArgs(argv) {
  const options = {
    suffix: "0314",
    workers: Math.max(1, Math.min(os.cpus().length, 8)),
    benchmarkSeconds: 0
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--suffix" && next) {
      options.suffix = next.toLowerCase();
      i += 1;
      continue;
    }
    if (current === "--workers" && next) {
      options.workers = Math.max(1, Number(next));
      i += 1;
      continue;
    }
    if (current === "--benchmark" && next) {
      options.benchmarkSeconds = Math.max(1, Number(next));
      i += 1;
      continue;
    }
    if (current === "--create2-deployer" && next) {
      options.create2Deployer = next;
      i += 1;
      continue;
    }
    if (current === "--owner" && next) {
      options.owner = next;
      i += 1;
      continue;
    }
    if (current === "--router" && next) {
      options.router = next;
      i += 1;
      continue;
    }
    if (current === "--protocol-fee-recipient" && next) {
      options.protocolFeeRecipient = next;
      i += 1;
      continue;
    }
    if (current === "--create-fee" && next) {
      options.createFee = next;
      i += 1;
      continue;
    }
    if (current === "--graduation-target" && next) {
      options.graduationTarget = next;
      i += 1;
      continue;
    }
  }

  const required = [
    "create2Deployer",
    "owner",
    "router",
    "protocolFeeRecipient",
    "createFee",
    "graduationTarget"
  ];
  for (const key of required) {
    if (!options[key]) {
      throw new Error(`Missing required flag --${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
    }
  }

  if (!/^[0-9a-f]+$/i.test(options.suffix)) {
    throw new Error("suffix must be hex characters only");
  }

  return options;
}

function buildFactoryInitCode(ethers, options) {
  const artifactPath = path.join(
    __dirname,
    "..",
    "packages/contracts/artifacts/contracts/LaunchFactory.sol/LaunchFactory.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encodedArgs = abiCoder.encode(
    ["address", "address", "address", "uint256", "uint256"],
    [
      options.owner,
      options.router,
      options.protocolFeeRecipient,
      ethers.parseEther(options.createFee),
      ethers.parseEther(options.graduationTarget)
    ]
  );
  return artifact.bytecode + encodedArgs.slice(2);
}

if (!isMainThread) {
  const { randomBytes } = require("crypto");
  const ethers = requireWorkspaceEthers();
  const { getCreate2Address, keccak256, hexlify } = ethers;
  const { suffix, deployer, initCodeHash, benchmarkMs } = workerData;

  let attempts = 0;
  const started = Date.now();

  while (true) {
    const salt = hexlify(randomBytes(32));
    const predicted = getCreate2Address(deployer, salt, initCodeHash);
    attempts += 1;

    if (benchmarkMs > 0 && Date.now() - started >= benchmarkMs) {
      parentPort.postMessage({ mode: "benchmark", attempts, elapsedMs: Date.now() - started });
      break;
    }

    if (predicted.toLowerCase().endsWith(suffix)) {
      parentPort.postMessage({
        mode: "found",
        attempts,
        elapsedMs: Date.now() - started,
        salt,
        address: predicted
      });
      break;
    }

    if ((attempts & 0x7fff) === 0) {
      parentPort.postMessage({ mode: "progress", attempts });
    }
  }
} else {
  const options = parseArgs(process.argv.slice(2));
  const ethers = requireWorkspaceEthers();

  const normalized = {
    ...options,
    create2Deployer: ethers.getAddress(options.create2Deployer),
    owner: ethers.getAddress(options.owner),
    router: ethers.getAddress(options.router),
    protocolFeeRecipient: ethers.getAddress(options.protocolFeeRecipient)
  };

  const initCode = buildFactoryInitCode(ethers, normalized);
  const initCodeHash = ethers.keccak256(initCode);
  const started = Date.now();
  const pool = [];
  let finished = false;
  let attemptsSeen = 0;
  let benchmarkReports = 0;

  function shutdown(code = 0) {
    for (const worker of pool) {
      try {
        worker.terminate();
      } catch {}
    }
    process.exit(code);
  }

  for (let index = 0; index < normalized.workers; index += 1) {
    const worker = new Worker(__filename, {
      workerData: {
        suffix: normalized.suffix,
        deployer: normalized.create2Deployer,
        initCodeHash,
        benchmarkMs: normalized.benchmarkSeconds > 0 ? normalized.benchmarkSeconds * 1000 : 0
      }
    });

    pool.push(worker);

    worker.on("message", (message) => {
      if (finished) return;

      if (message.mode === "progress") {
        attemptsSeen += message.attempts;
        return;
      }

      if (message.mode === "benchmark") {
        attemptsSeen += message.attempts;
        benchmarkReports += 1;
        if (benchmarkReports === normalized.workers) {
          finished = true;
          const elapsedMs = Date.now() - started;
          console.log(JSON.stringify({
            mode: "benchmark",
            type: "factory-create2",
            suffix: normalized.suffix,
            workers: normalized.workers,
            create2Deployer: normalized.create2Deployer,
            elapsedMs,
            attemptsApprox: attemptsSeen,
            rateApprox: Math.round(attemptsSeen / Math.max(elapsedMs / 1000, 0.001)),
            initCodeHash
          }, null, 2));
          shutdown(0);
        }
        return;
      }

      if (message.mode === "found") {
        finished = true;
        attemptsSeen += message.attempts;
        const elapsedMs = Date.now() - started;
        console.log(JSON.stringify({
          mode: "found",
          type: "factory-create2",
          suffix: normalized.suffix,
          workers: normalized.workers,
          create2Deployer: normalized.create2Deployer,
          owner: normalized.owner,
          router: normalized.router,
          protocolFeeRecipient: normalized.protocolFeeRecipient,
          createFee: normalized.createFee,
          graduationTarget: normalized.graduationTarget,
          initCodeHash,
          elapsedMs,
          attemptsApprox: attemptsSeen,
          rateApprox: Math.round(attemptsSeen / Math.max(elapsedMs / 1000, 0.001)),
          salt: message.salt,
          address: message.address
        }, null, 2));
        shutdown(0);
      }
    });

    worker.on("error", (error) => {
      console.error(error);
      if (!finished) {
        finished = true;
        shutdown(1);
      }
    });

    worker.on("exit", (code) => {
      if (!finished && code !== 0) {
        console.error(`worker exited unexpectedly with code ${code}`);
        finished = true;
        shutdown(code || 1);
      }
    });
  }
}
