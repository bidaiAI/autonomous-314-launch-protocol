import { createServer, type ServerResponse, type IncomingMessage } from "http";
import { buildIndexerSnapshot } from "./service";
import type { IndexerSnapshot } from "./schema";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __metadir = dirname(fileURLToPath(import.meta.url));
const METADATA_DIR = join(__metadir, "..", "metadata");

const port = Number(process.env.PORT ?? process.env.INDEXER_PORT ?? 8787);
const cacheTtlMs = Number(process.env.INDEXER_CACHE_TTL_MS ?? 15_000);
const corsOrigin = process.env.INDEXER_CORS_ORIGIN ?? "*";

let cache: { expiresAt: number; snapshot: IndexerSnapshot } | null = null;
let inflight: Promise<IndexerSnapshot> | null = null;

async function getSnapshot(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cache && cache.expiresAt > now) {
    return cache.snapshot;
  }

  if (!forceRefresh && inflight) {
    return inflight;
  }

  inflight = buildIndexerSnapshot()
    .then((snapshot) => {
      cache = {
        snapshot,
        expiresAt: Date.now() + cacheTtlMs
      };
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("access-control-allow-origin", corsOrigin);
  res.setHeader("access-control-allow-methods", "GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "Content-Type");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(
      body,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    )
  );
}

function detectPublicOrigin(req: IncomingMessage) {
  const host = req.headers.host ?? `127.0.0.1:${port}`;
  const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string"
    ? req.headers["x-forwarded-proto"].split(",")[0]?.trim()
    : undefined;
  const protocol = forwardedProto || (/^(127\.0\.0\.1|localhost)(:|$)/.test(host) ? "http" : "https");
  return `${protocol}://${host}`;
}

function parseLimit(value: string | null, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (!req.url) {
      sendJson(res, 400, { error: "Missing request URL" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.setHeader("access-control-allow-origin", corsOrigin);
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "Content-Type");
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // ── Metadata upload (POST /api/metadata) ──
    if (req.method === "POST" && url.pathname === "/api/metadata") {
      const body = await readBody(req);
      try {
        const metadata = JSON.parse(body);
        if (!metadata.name || !metadata.symbol) {
          sendJson(res, 400, { error: "Metadata must include name and symbol" });
          return;
        }
        if (!existsSync(METADATA_DIR)) mkdirSync(METADATA_DIR, { recursive: true });
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const filename = `${id}.json`;
        writeFileSync(join(METADATA_DIR, filename), JSON.stringify(metadata, null, 2));
        const metadataUrl = `${detectPublicOrigin(req)}/api/metadata/${id}`;
        sendJson(res, 201, { ok: true, id, url: metadataUrl });
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
      }
      return;
    }

    // ── Serve saved metadata (GET /api/metadata/:id) ──
    if (req.method === "GET" && url.pathname.startsWith("/api/metadata/")) {
      const id = url.pathname.replace("/api/metadata/", "").replace(/\.json$/, "");
      const filepath = join(METADATA_DIR, `${id}.json`);
      if (!existsSync(filepath)) {
        sendJson(res, 404, { error: "Metadata not found" });
        return;
      }
      try {
        const data = JSON.parse(readFileSync(filepath, "utf-8"));
        sendJson(res, 200, data);
      } catch {
        sendJson(res, 500, { error: "Failed to read metadata" });
      }
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const forceRefresh = url.searchParams.get("refresh") === "1";

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, cacheTtlMs });
      return;
    }

    const snapshot = await getSnapshot(forceRefresh);

    if (url.pathname === "/snapshot") {
      sendJson(res, 200, snapshot);
      return;
    }

    if (url.pathname === "/launches") {
      const limit = parseLimit(url.searchParams.get("limit"), snapshot.launches.length, snapshot.launches.length);
      sendJson(res, 200, {
        generatedAtMs: snapshot.generatedAtMs,
        chainId: snapshot.chainId,
        chain: snapshot.chain,
        nativeSymbol: snapshot.nativeSymbol,
        wrappedNativeSymbol: snapshot.wrappedNativeSymbol,
        dexName: snapshot.dexName,
        indexedToBlock: snapshot.toBlock,
        factory: snapshot.factory,
        count: Math.min(limit, snapshot.launches.length),
        launches: snapshot.launches.slice(0, limit).map((launch) => ({
          token: launch.token,
          creator: launch.creator,
          metadataURI: launch.metadataURI,
          symbol: launch.symbol,
          name: launch.name,
          mode: launch.mode,
          modeLabel: launch.modeLabel,
          suffix: launch.suffix,
          state: launch.state,
          pair: launch.pair,
          graduationQuoteReserve: launch.graduationQuoteReserve,
          currentPriceQuotePerToken: launch.currentPriceQuotePerToken,
          graduationProgressBps: launch.graduationProgressBps,
          pairPreloadedQuote: launch.pairPreloadedQuote,
          whitelistStatus: launch.whitelistStatus,
          whitelistSnapshot: launch.whitelistSnapshot,
          taxConfig: launch.taxConfig
        }))
      });
      return;
    }

    const launchMatch = url.pathname.match(/^\/launches\/(0x[a-fA-F0-9]{40})(?:\/(activity|chart))?$/);
    if (launchMatch) {
      const token = launchMatch[1].toLowerCase();
      const mode = launchMatch[2];
      const launch = snapshot.launches.find((item) => item.token.toLowerCase() === token);

      if (!launch) {
        sendJson(res, 404, { error: "Launch not found" });
        return;
      }

      if (mode === "activity") {
        const limit = parseLimit(url.searchParams.get("limit"), launch.recentActivity.length, launch.recentActivity.length);
        sendJson(res, 200, {
          token: launch.token,
          chainId: snapshot.chainId,
          chain: snapshot.chain,
          nativeSymbol: snapshot.nativeSymbol,
          wrappedNativeSymbol: snapshot.wrappedNativeSymbol,
          dexName: snapshot.dexName,
          factory: snapshot.factory,
          generatedAtMs: snapshot.generatedAtMs,
          indexedToBlock: snapshot.toBlock,
          count: Math.min(limit, launch.recentActivity.length),
          recentActivity: launch.recentActivity.slice(0, limit)
        });
        return;
      }

      if (mode === "chart") {
        sendJson(res, 200, {
          token: launch.token,
          chainId: snapshot.chainId,
          chain: snapshot.chain,
          nativeSymbol: snapshot.nativeSymbol,
          wrappedNativeSymbol: snapshot.wrappedNativeSymbol,
          dexName: snapshot.dexName,
          factory: snapshot.factory,
          generatedAtMs: snapshot.generatedAtMs,
          indexedToBlock: snapshot.toBlock,
          segmentedChart: launch.segmentedChart
        });
        return;
      }

      sendJson(res, 200, {
        chainId: snapshot.chainId,
        chain: snapshot.chain,
        nativeSymbol: snapshot.nativeSymbol,
        wrappedNativeSymbol: snapshot.wrappedNativeSymbol,
        dexName: snapshot.dexName,
        factory: snapshot.factory,
        generatedAtMs: snapshot.generatedAtMs,
        indexedToBlock: snapshot.toBlock,
        launch: {
          token: launch.token,
          creator: launch.creator,
          name: launch.name,
          symbol: launch.symbol,
          metadataURI: launch.metadataURI,
          mode: launch.mode,
          modeLabel: launch.modeLabel,
          suffix: launch.suffix,
          state: launch.state,
          pair: launch.pair,
          graduationQuoteReserve: launch.graduationQuoteReserve,
          currentPriceQuotePerToken: launch.currentPriceQuotePerToken,
          graduationProgressBps: launch.graduationProgressBps,
          remainingQuoteCapacity: launch.remainingQuoteCapacity,
          pairPreloadedQuote: launch.pairPreloadedQuote,
          pairClean: launch.pairClean,
          pairGraduationCompatible: launch.pairGraduationCompatible,
          protocolClaimable: launch.protocolClaimable,
          creatorClaimable: launch.creatorClaimable,
          whitelistStatus: launch.whitelistStatus,
          whitelistSnapshot: launch.whitelistSnapshot,
          taxConfig: launch.taxConfig,
          dexTokenReserve: launch.dexTokenReserve,
          dexQuoteReserve: launch.dexQuoteReserve
        }
      });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    console.error("[indexer-api] request failed", {
      method: req.method,
      url: req.url,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          : String(error)
    });
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Internal server error"
    });
  }
});

server.listen(port, () => {
  console.log(`[indexer-api] listening on http://127.0.0.1:${port}`);
  console.log(`[indexer-api] cache ttl: ${cacheTtlMs}ms`);
});
