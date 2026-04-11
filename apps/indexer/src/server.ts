import { createServer, type ServerResponse, type IncomingMessage } from "http";
import { buildIndexerSnapshot } from "./service";
import { getVerificationWorkerSnapshot, startVerificationWorker, stopVerificationWorker } from "./verifier";
import { getNotificationWorkerSnapshot, startNotificationWorker, stopNotificationWorker } from "./notifier";
import type { IndexerSnapshot } from "./schema";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import process from "node:process";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "node:crypto";
import { indexerConfig } from "./config";
import { createXAuthorizationUrl, exchangeXOAuthCode, isXAuthConfigured } from "./x-auth";
import { createXPost, isXPublishingConfigured, XPublishError } from "./x-publish";
import { updateXProfile } from "./x-profile";
import type { CandleBucket, SegmentedChartSnapshot } from "./schema";

const __metadir = dirname(fileURLToPath(import.meta.url));
const METADATA_DIR = join(__metadir, "..", "metadata");
const MEDIA_DIR = join(__metadir, "..", "media");

const port = Number(process.env.PORT ?? process.env.INDEXER_PORT ?? 8787);
const cacheTtlMs = Number(process.env.INDEXER_CACHE_TTL_MS ?? 15_000);
const prewarmIntervalMs = Number(process.env.INDEXER_PREWARM_INTERVAL_MS ?? 0);
const corsOrigin = process.env.INDEXER_CORS_ORIGIN ?? "*";
const runtimeProcess = process as unknown as NodeJS.Process & { argv: string[] };
const xAuthConfig = {
  clientId: indexerConfig.xClientId,
  clientSecret: indexerConfig.xClientSecret,
  callbackUrl: indexerConfig.xCallbackUrl,
  scopes: indexerConfig.xScopes
} as const;
const xPublishConfig = {
  clientId: indexerConfig.xClientId,
  clientSecret: indexerConfig.xClientSecret,
  accessToken: indexerConfig.xAccountAccessToken,
  refreshToken: indexerConfig.xAccountRefreshToken
} as const;

let cache: { expiresAt: number; snapshot: IndexerSnapshot } | null = null;
let inflight: Promise<IndexerSnapshot> | null = null;
const supportedChartTimeframes = new Set<CandleBucket["timeframe"]>(["1m", "5m", "15m", "1h", "4h", "1d"]);

export class RequestBodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`Request body exceeds limit of ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function parseChartTimeframe(value: string | null): CandleBucket["timeframe"] | null {
  if (!value) return null;
  return supportedChartTimeframes.has(value as CandleBucket["timeframe"]) ? (value as CandleBucket["timeframe"]) : null;
}

export function filterSegmentedChartByTimeframe(
  segmentedChart: SegmentedChartSnapshot,
  timeframe: CandleBucket["timeframe"] | null
): SegmentedChartSnapshot {
  if (!timeframe) {
    return segmentedChart;
  }

  return {
    bondingCandles: segmentedChart.bondingCandles.filter((candle) => candle.timeframe === timeframe),
    dexCandles: segmentedChart.dexCandles.filter((candle) => candle.timeframe === timeframe),
    graduationTimestampMs: segmentedChart.graduationTimestampMs
  };
}

function refreshSnapshot() {
  if (inflight) {
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

async function getSnapshot(forceRefresh = false) {
  const now = Date.now();
  if (forceRefresh) {
    return refreshSnapshot();
  }

  if (cache && cache.expiresAt > now) {
    return cache.snapshot;
  }

  if (cache) {
    void refreshSnapshot().catch((error) => {
      console.error("[indexer-api] background refresh failed", error);
    });
    return cache.snapshot;
  }

  return refreshSnapshot();
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  options?: {
    allowCors?: boolean;
    allowMethods?: string;
    allowHeaders?: string;
  }
) {
  res.statusCode = status;
  if (options?.allowCors !== false) {
    res.setHeader("access-control-allow-origin", corsOrigin);
    res.setHeader("access-control-allow-methods", options?.allowMethods ?? "GET, OPTIONS");
    res.setHeader("access-control-allow-headers", options?.allowHeaders ?? "Content-Type");
  }
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(
    JSON.stringify(
      body,
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
      2
    )
  );
}

export function sendHtml(res: ServerResponse, status: number, html: string) {
  res.statusCode = status;
  res.setHeader("access-control-allow-origin", corsOrigin);
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseBearerToken(header: string | string[] | undefined) {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    return null;
  }

  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function tokenEquals(expected: string, actual: string) {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function requireSharedSecret(
  req: IncomingMessage,
  res: ServerResponse,
  secret: string | undefined,
  context: {
    label: string;
    requiredEnv: string[];
  }
) {
  if (!secret) {
    sendJson(res, 503, {
      error: `${context.label} shared secret is not configured`,
      requiredEnv: context.requiredEnv
    }, { allowCors: false });
    return false;
  }

  const bearerToken = parseBearerToken(req.headers.authorization);
  if (!bearerToken) {
    res.statusCode = 401;
    res.setHeader("www-authenticate", 'Bearer realm="indexer-x-publish"');
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Missing bearer token" }, null, 2));
    return false;
  }

  if (!tokenEquals(secret, bearerToken)) {
    sendJson(res, 403, { error: "Invalid bearer token" }, { allowCors: false });
    return false;
  }

  return true;
}

function detectPublicOrigin(req: IncomingMessage) {
  const hostHeader = req.headers.host ?? `127.0.0.1:${port}`;
  const host = hostHeader.toLowerCase();
  if (/^(127\.0\.0\.1|localhost)(:|$)/.test(host)) {
    return `http://${hostHeader}`;
  }

  const normalizedOrigin = normalizeOriginHeader(req.headers.origin);
  if (normalizedOrigin && isAllowedMetadataPublicOrigin(normalizedOrigin)) {
    return normalizedOrigin;
  }

  const forwardedHostHeader = req.headers["x-forwarded-host"];
  const forwardedHost = typeof forwardedHostHeader === "string"
    ? forwardedHostHeader.split(",")[0]?.trim()
    : Array.isArray(forwardedHostHeader)
      ? forwardedHostHeader[0]?.trim()
      : undefined;
  const requestHost = forwardedHost || req.headers.host || `127.0.0.1:${port}`;
  const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string"
    ? req.headers["x-forwarded-proto"].split(",")[0]?.trim()
    : undefined;
  const protocol = forwardedProto || (/^(127\.0\.0\.1|localhost)(:|$)/.test(requestHost) ? "http" : "https");

  if (indexerConfig.publicBaseUrl) {
    return indexerConfig.publicBaseUrl;
  }

  return `${protocol}://${requestHost}`;
}

function normalizeOriginHeader(origin: string | string[] | undefined) {
  const value = Array.isArray(origin) ? origin[0] : origin;
  return value?.trim().replace(/\/$/, "").toLowerCase() || null;
}

function isAllowedMetadataPublicOrigin(origin: string | string[] | undefined) {
  const normalized = normalizeOriginHeader(origin);
  if (!normalized) return false;
  return indexerConfig.metadataPublicOrigins.includes(normalized);
}

function parseLimit(value: string | null, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function readBody(req: IncomingMessage, maxBytes = indexerConfig.maxPostBodyBytes): Promise<string> {
  return readBodyBuffer(req, maxBytes).then((buffer) => buffer.toString("utf-8"));
}

export function readBodyBuffer(req: IncomingMessage, maxBytes = indexerConfig.maxPostBodyBytes): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };

    const contentLength = req.headers["content-length"];
    if (typeof contentLength === "string") {
      const parsed = Number(contentLength);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        fail(new RequestBodyTooLargeError(maxBytes));
        return;
      }
    }

    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
  });
}

function getRequestHeaders(req: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") {
      headers.set(key, value);
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    }
  }
  return headers;
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "bin";
  }
}

function mimeTypeForExtension(extension: string) {
  switch (extension.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
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
      res.setHeader("access-control-allow-headers", "Content-Type, Authorization");
      res.end();
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/auth/x/start") {
      if (!isXAuthConfigured(xAuthConfig)) {
        sendJson(res, 503, {
          error: "X OAuth is not configured",
          requiredEnv: ["INDEXER_X_CLIENT_ID", "INDEXER_X_CLIENT_SECRET", "INDEXER_X_CALLBACK_URL"]
        });
        return;
      }

      const auth = createXAuthorizationUrl(xAuthConfig);
      if (url.searchParams.get("format") === "json") {
        sendJson(res, 200, {
          ok: true,
          authorizeUrl: auth.url,
          callbackUrl: xAuthConfig.callbackUrl,
          scopes: xAuthConfig.scopes
        });
        return;
      }

      res.statusCode = 302;
      res.setHeader("location", auth.url);
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/x/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description");

      if (error) {
        sendHtml(
          res,
          400,
          `<!doctype html><html><body style="font-family: sans-serif; padding: 24px; background: #081018; color: #fff;"><h1>X auth failed</h1><p>${escapeHtml(errorDescription || error)}</p></body></html>`
        );
        return;
      }

      if (!code || !state) {
        sendJson(res, 400, { error: "Missing code or state" });
        return;
      }

      const tokens = await exchangeXOAuthCode(xAuthConfig, code, state);
      sendHtml(
        res,
        200,
        `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>X OAuth complete</title>
  </head>
  <body style="font-family: Inter, sans-serif; padding: 24px; background: #081018; color: #fff;">
    <h1 style="margin: 0 0 12px;">官推授权成功</h1>
    <p style="color: #9fb0c0; line-height: 1.6;">下面是后续自动发推要保存的两个值。请复制后放进后端环境变量。</p>
    <div style="display: grid; gap: 12px; margin-top: 20px;">
      <div>
        <div style="font-size: 12px; color: #9fb0c0; margin-bottom: 6px;">X_ACCOUNT_ACCESS_TOKEN</div>
        <textarea readonly style="width: 100%; min-height: 120px; padding: 12px; border-radius: 12px; background: #0f1724; color: #fff; border: 1px solid #1f3346;">${escapeHtml(tokens.accessToken)}</textarea>
      </div>
      <div>
        <div style="font-size: 12px; color: #9fb0c0; margin-bottom: 6px;">X_ACCOUNT_REFRESH_TOKEN</div>
        <textarea readonly style="width: 100%; min-height: 120px; padding: 12px; border-radius: 12px; background: #0f1724; color: #fff; border: 1px solid #1f3346;">${escapeHtml(tokens.refreshToken)}</textarea>
      </div>
      <div style="font-size: 12px; color: #9fb0c0;">scope=${escapeHtml(tokens.scope)} · expires_in=${tokens.expiresIn}</div>
    </div>
  </body>
</html>`
      );
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/x/tweets") {
      if (!isXPublishingConfigured(xPublishConfig)) {
        sendJson(res, 503, {
          error: "X publish is not configured",
          requiredEnv: [
            "INDEXER_X_CLIENT_ID",
            "INDEXER_X_CLIENT_SECRET",
            "INDEXER_X_ACCOUNT_ACCESS_TOKEN or INDEXER_X_ACCOUNT_REFRESH_TOKEN",
            "INDEXER_X_POST_SHARED_SECRET"
          ]
        }, { allowCors: false });
        return;
      }

      if (!requireSharedSecret(req, res, indexerConfig.xPostSharedSecret, {
        label: "X publish",
        requiredEnv: ["INDEXER_X_POST_SHARED_SECRET"]
      })) {
        return;
      }

      const body = await readBody(req);
      let payload: { text?: unknown; replyToTweetId?: unknown };
      try {
        payload = JSON.parse(body) as { text?: unknown; replyToTweetId?: unknown };
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" }, { allowCors: false });
        return;
      }

      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const replyToTweetId = typeof payload.replyToTweetId === "string" ? payload.replyToTweetId.trim() : undefined;

      if (!text) {
        sendJson(res, 400, { error: "Field `text` is required" }, { allowCors: false });
        return;
      }

      if (replyToTweetId && !/^\d+$/.test(replyToTweetId)) {
        sendJson(res, 400, { error: "Field `replyToTweetId` must be a numeric tweet id" }, { allowCors: false });
        return;
      }

      const result = await createXPost(xPublishConfig, {
        text,
        replyToTweetId
      });

      if (result.refreshTokenRotated) {
        console.warn("[indexer-api] X refresh token rotated in memory; update Railway env to persist it across restarts.");
      }

      sendJson(res, 200, {
        ok: true,
        tweetId: result.id,
        text: result.text,
        tokenRefreshed: result.tokenRefreshed,
        refreshTokenRotated: result.refreshTokenRotated,
        refreshTokenPersistence: result.refreshTokenRotated ? "runtime-only-until-env-is-updated" : "env"
      }, { allowCors: false });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/x/profile") {
      if (!isXPublishingConfigured(xPublishConfig)) {
        sendJson(res, 503, {
          error: "X profile update is not configured",
          requiredEnv: [
            "INDEXER_X_CLIENT_ID",
            "INDEXER_X_CLIENT_SECRET",
            "INDEXER_X_ACCOUNT_ACCESS_TOKEN or INDEXER_X_ACCOUNT_REFRESH_TOKEN",
            "INDEXER_X_POST_SHARED_SECRET"
          ]
        }, { allowCors: false });
        return;
      }

      if (!requireSharedSecret(req, res, indexerConfig.xPostSharedSecret, {
        label: "X profile update",
        requiredEnv: ["INDEXER_X_POST_SHARED_SECRET"]
      })) {
        return;
      }

      const body = await readBody(req);
      let payload: {
        name?: unknown;
        description?: unknown;
        url?: unknown;
        location?: unknown;
        profileImageBase64?: unknown;
        bannerBase64?: unknown;
      };
      try {
        payload = JSON.parse(body) as typeof payload;
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" }, { allowCors: false });
        return;
      }

      const result = await updateXProfile(xPublishConfig, {
        name: typeof payload.name === "string" ? payload.name : undefined,
        description: typeof payload.description === "string" ? payload.description : undefined,
        url: typeof payload.url === "string" ? payload.url : undefined,
        location: typeof payload.location === "string" ? payload.location : undefined,
        profileImageBase64: typeof payload.profileImageBase64 === "string" ? payload.profileImageBase64 : undefined,
        bannerBase64: typeof payload.bannerBase64 === "string" ? payload.bannerBase64 : undefined
      });

      sendJson(res, 200, {
        ok: true,
        ...result
      }, { allowCors: false });
      return;
    }

    // ── Metadata upload (POST /api/metadata) ──
    if (req.method === "POST" && url.pathname === "/api/metadata") {
      const allowPublicMetadataUpload =
        !normalizeOriginHeader(req.headers.origin)
        || isAllowedMetadataPublicOrigin(req.headers.origin);
      console.log(
        `[indexer-api] metadata upload origin=${normalizeOriginHeader(req.headers.origin) ?? "none"} public=${allowPublicMetadataUpload}`
      );

      if (
        !allowPublicMetadataUpload
        && !requireSharedSecret(req, res, indexerConfig.metadataPostSharedSecret, {
        label: "Metadata upload",
        requiredEnv: ["INDEXER_METADATA_POST_SHARED_SECRET", "INDEXER_X_POST_SHARED_SECRET"]
      })
      ) {
        return;
      }

      let body: string;
      try {
        body = await readBody(req);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          sendJson(
            res,
            413,
            { error: "Request body too large", limitBytes: error.maxBytes },
            { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
          );
          return;
        }
        throw error;
      }

      try {
        const metadata = JSON.parse(body);
        if (!metadata.name || !metadata.symbol) {
          sendJson(
            res,
            400,
            { error: "Metadata must include name and symbol" },
            { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
          );
          return;
        }
        if (!existsSync(METADATA_DIR)) mkdirSync(METADATA_DIR, { recursive: true });
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const filename = `${id}.json`;
        writeFileSync(join(METADATA_DIR, filename), JSON.stringify(metadata, null, 2));
        const metadataUrl = `${detectPublicOrigin(req)}/api/metadata/${id}`;
        sendJson(
          res,
          201,
          { ok: true, id, url: metadataUrl },
          { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
        );
      } catch {
        sendJson(
          res,
          400,
          { error: "Invalid JSON body" },
          { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
        );
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/upload-image") {
      const allowPublicImageUpload =
        !normalizeOriginHeader(req.headers.origin)
        || isAllowedMetadataPublicOrigin(req.headers.origin);

      if (
        !allowPublicImageUpload
        && !requireSharedSecret(req, res, indexerConfig.metadataPostSharedSecret, {
          label: "Image upload",
          requiredEnv: ["INDEXER_METADATA_POST_SHARED_SECRET", "INDEXER_X_POST_SHARED_SECRET"]
        })
      ) {
        return;
      }

      let body: Buffer;
      try {
        body = await readBodyBuffer(req, indexerConfig.maxImageUploadBytes);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          sendJson(
            res,
            413,
            { error: "Request body too large", limitBytes: error.maxBytes },
            { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
          );
          return;
        }
        throw error;
      }

      try {
        const request = new Request(`${detectPublicOrigin(req)}${url.pathname}`, {
          method: "POST",
          headers: getRequestHeaders(req),
          body: new Uint8Array(body)
        });
        const form = await request.formData();
        const uploaded = form.get("file");
        const isUploadFile =
          uploaded !== null
          && typeof uploaded === "object"
          && "arrayBuffer" in uploaded
          && "type" in uploaded
          && "size" in uploaded;
        if (!isUploadFile) {
          sendJson(
            res,
            400,
            { error: "Field `file` is required" },
            { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
          );
          return;
        }

        const uploadedFile = uploaded as {
          type?: string;
          size?: number;
          arrayBuffer: () => Promise<ArrayBuffer>;
        };
        const mimeType = uploadedFile.type || "application/octet-stream";
        if (!mimeType.startsWith("image/")) {
          sendJson(
            res,
            400,
            { error: "Uploaded file must be an image" },
            { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
          );
          return;
        }

        if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
        const ext = extensionForMimeType(mimeType);
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        writeFileSync(join(MEDIA_DIR, id), Buffer.from(await uploadedFile.arrayBuffer()));
        const imageUrl = `${detectPublicOrigin(req)}/api/media/${id}`;
        sendJson(
          res,
          201,
          { ok: true, id, url: imageUrl, contentType: mimeType, bytes: uploadedFile.size ?? 0 },
          { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
        );
      } catch {
        sendJson(
          res,
          400,
          { error: "Invalid image upload body" },
          { allowMethods: "GET, POST, OPTIONS", allowHeaders: "Content-Type, Authorization" }
        );
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

    if (req.method === "GET" && url.pathname.startsWith("/api/media/")) {
      const id = url.pathname.replace("/api/media/", "");
      const filepath = join(MEDIA_DIR, id);
      if (!existsSync(filepath)) {
        sendJson(res, 404, { error: "Media not found" });
        return;
      }
      const ext = id.includes(".") ? id.split(".").pop() || "" : "";
      res.statusCode = 200;
      res.setHeader("access-control-allow-origin", corsOrigin);
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("content-type", mimeTypeForExtension(ext));
      res.end(readFileSync(filepath));
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    const forceRefresh = url.searchParams.get("refresh") === "1";

    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        cacheTtlMs,
        prewarmIntervalMs,
        hasCache: Boolean(cache),
        refreshInFlight: Boolean(inflight),
        verifier: getVerificationWorkerSnapshot(),
        notifier: getNotificationWorkerSnapshot()
      });
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
          protocolFeeAccrued: launch.protocolFeeAccrued,
          creatorFeeAccrued: launch.creatorFeeAccrued,
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
        const requestedTimeframe = url.searchParams.get("timeframe");
        const timeframe = parseChartTimeframe(requestedTimeframe);
        if (requestedTimeframe && !timeframe) {
          sendJson(res, 400, {
            error: "Invalid chart timeframe",
            supportedTimeframes: [...supportedChartTimeframes]
          });
          return;
        }

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
          timeframe,
          segmentedChart: filterSegmentedChartByTimeframe(launch.segmentedChart, timeframe)
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
          protocolFeeAccrued: launch.protocolFeeAccrued,
          creatorFeeAccrued: launch.creatorFeeAccrued,
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
    const status =
      error instanceof Error && "status" in error && typeof error.status === "number"
        ? error.status
        : 500;
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
    sendJson(res, status, {
      error: error instanceof Error ? error.message : "Internal server error"
    });
  }
});

export function startIndexerServer() {
  startVerificationWorker();
  startNotificationWorker();

  server.listen(port, () => {
    console.log(`[indexer-api] listening on http://127.0.0.1:${port}`);
    console.log(`[indexer-api] verifier enabled: ${getVerificationWorkerSnapshot().enabled}`);
    console.log(`[indexer-api] notifier enabled: ${getNotificationWorkerSnapshot().enabled}`);
    console.log(`[indexer-api] cache ttl: ${cacheTtlMs}ms`);
    console.log(`[indexer-api] metadata public origins: ${indexerConfig.metadataPublicOrigins.join(", ")}`);
    if (prewarmIntervalMs > 0) {
      console.log(`[indexer-api] prewarm interval: ${prewarmIntervalMs}ms`);
      void refreshSnapshot().catch((error) => {
        console.error("[indexer-api] initial prewarm failed", error);
      });
      setInterval(() => {
        void refreshSnapshot().catch((error) => {
          console.error("[indexer-api] scheduled prewarm failed", error);
        });
      }, prewarmIntervalMs).unref();
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    runtimeProcess.on(signal, () => {
      stopVerificationWorker();
      stopNotificationWorker();
      server.close();
    });
  }
}

if (runtimeProcess.argv[1] && fileURLToPath(import.meta.url) === runtimeProcess.argv[1]) {
  startIndexerServer();
}
