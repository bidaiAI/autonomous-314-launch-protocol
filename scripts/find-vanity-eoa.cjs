#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

function parseArgs(argv) {
  const options = {
    suffix: "314314",
    workers: Math.max(1, Math.min(os.cpus().length, 8)),
    benchmarkSeconds: 0
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (current === "--suffix" && argv[i + 1]) {
      options.suffix = argv[i + 1].toLowerCase();
      i += 1;
      continue;
    }
    if (current === "--workers" && argv[i + 1]) {
      options.workers = Math.max(1, Number(argv[i + 1]));
      i += 1;
      continue;
    }
    if (current === "--benchmark" && argv[i + 1]) {
      options.benchmarkSeconds = Math.max(1, Number(argv[i + 1]));
      i += 1;
      continue;
    }
  }

  if (!/^[0-9a-f]+$/i.test(options.suffix)) {
    throw new Error("suffix must be hex characters only");
  }

  return options;
}

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

if (!isMainThread) {
  const { randomBytes } = require("crypto");
  const ethers = requireWorkspaceEthers();
  const computeAddress = ethers.computeAddress || ethers.utils.computeAddress;
  const hexlify = ethers.hexlify || ethers.utils.hexlify;
  const { suffix, benchmarkMs } = workerData;

  let attempts = 0;
  const started = Date.now();

  while (true) {
    const pk = hexlify(randomBytes(32));
    const address = computeAddress(pk);
    attempts += 1;

    if (benchmarkMs > 0 && Date.now() - started >= benchmarkMs) {
      parentPort.postMessage({
        mode: "benchmark",
        attempts,
        elapsedMs: Date.now() - started
      });
      break;
    }

    if (address.toLowerCase().endsWith(suffix)) {
      parentPort.postMessage({
        mode: "found",
        privateKey: pk,
        address,
        attempts,
        elapsedMs: Date.now() - started
      });
      break;
    }

    if ((attempts & 0x7fff) === 0) {
      parentPort.postMessage({
        mode: "progress",
        attempts
      });
    }
  }
} else {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const pool = [];
  let finished = false;
  let attemptsSeen = 0;
  let benchmarkReports = 0;

  function shutdown(code = 0) {
    for (const worker of pool) {
      try {
        worker.terminate();
      } catch {
        // ignore
      }
    }
    process.exit(code);
  }

  for (let index = 0; index < options.workers; index += 1) {
    const worker = new Worker(__filename, {
      workerData: {
        suffix: options.suffix,
        benchmarkMs: options.benchmarkSeconds > 0 ? options.benchmarkSeconds * 1000 : 0
      }
    });

    pool.push(worker);

    worker.on("message", (message) => {
      if (finished) {
        return;
      }

      if (message.mode === "progress") {
        attemptsSeen += message.attempts;
        return;
      }

      if (message.mode === "benchmark") {
        attemptsSeen += message.attempts;
        benchmarkReports += 1;

        if (benchmarkReports === options.workers) {
          finished = true;
          const elapsedMs = Date.now() - started;
          console.log(
            JSON.stringify(
              {
                mode: "benchmark",
                suffix: options.suffix,
                workers: options.workers,
                elapsedMs,
                attemptsApprox: attemptsSeen,
                rateApprox: Math.round(attemptsSeen / Math.max(elapsedMs / 1000, 0.001))
              },
              null,
              2
            )
          );
          shutdown(0);
        }

        return;
      }

      if (message.mode === "found") {
        finished = true;
        attemptsSeen += message.attempts;
        const elapsedMs = Date.now() - started;
        console.log(
          JSON.stringify(
            {
              mode: "found",
              suffix: options.suffix,
              workers: options.workers,
              elapsedMs,
              attemptsApprox: attemptsSeen,
              rateApprox: Math.round(attemptsSeen / Math.max(elapsedMs / 1000, 0.001)),
              address: message.address,
              privateKey: message.privateKey
            },
            null,
            2
          )
        );
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
