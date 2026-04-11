import { PassThrough } from "stream";
import type { IncomingMessage, ServerResponse } from "http";
import test from "node:test";
import assert from "node:assert/strict";
import { RequestBodyTooLargeError, filterSegmentedChartByTimeframe, parseChartTimeframe, readBody, requireSharedSecret, sendJson } from "./server";

function createMockResponse() {
  const headers = new Map<string, string>();
  let body = "";

  const res = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(value?: string) {
      body = value ?? "";
      return res;
    }
  } as unknown as ServerResponse;

  return {
    res,
    headers,
    getBody: () => body
  };
}

function createMockRequest(headers: Record<string, string | undefined> = {}) {
  const req = new PassThrough() as PassThrough & IncomingMessage;
  req.headers = headers as IncomingMessage["headers"];
  return req;
}

test("writes CORS headers only for public JSON responses", () => {
  const { res, headers, getBody } = createMockResponse();

  sendJson(res, 200, { ok: true });
  assert.equal(typeof headers.get("access-control-allow-origin"), "string");
  assert.equal(headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.match(getBody(), /"ok": true/);

  const postResponse = createMockResponse();
  sendJson(postResponse.res, 201, { ok: true }, {
    allowMethods: "GET, POST, OPTIONS",
    allowHeaders: "Content-Type, Authorization"
  });
  assert.equal(postResponse.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
  assert.equal(postResponse.headers.get("access-control-allow-headers"), "Content-Type, Authorization");

  const privateResponse = createMockResponse();
  sendJson(privateResponse.res, 200, { ok: true }, { allowCors: false });
  assert.equal(privateResponse.headers.has("access-control-allow-origin"), false);
});

test("rejects oversized request bodies with a dedicated error", async () => {
  const req = createMockRequest();
  const read = readBody(req, 5);

  req.write("hello");
  req.write("world");
  req.end();

  try {
    await read;
    assert.fail("expected readBody to reject");
  } catch (error) {
    assert.ok(error instanceof RequestBodyTooLargeError);
    assert.equal((error as RequestBodyTooLargeError).maxBytes, 5);
  }
});

test("requires the shared secret and accepts an exact bearer token", () => {
  const req = createMockRequest({ authorization: "Bearer shh-secret" });
  const missingReq = createMockRequest();

  const okResponse = createMockResponse();
  assert.equal(
    requireSharedSecret(req, okResponse.res, "shh-secret", {
      label: "Metadata upload",
      requiredEnv: ["INDEXER_METADATA_POST_SHARED_SECRET"]
    }),
    true
  );

  const missingResponse = createMockResponse();
  assert.equal(
    requireSharedSecret(missingReq, missingResponse.res, "shh-secret", {
      label: "Metadata upload",
      requiredEnv: ["INDEXER_METADATA_POST_SHARED_SECRET"]
    }),
    false
  );
  assert.equal(missingResponse.res.statusCode, 401);
});

test("parses and filters chart timeframes for chart responses", () => {
  assert.equal(parseChartTimeframe("1m"), "1m");
  assert.equal(parseChartTimeframe("1h"), "1h");
  assert.equal(parseChartTimeframe("bogus"), null);

  const filtered = filterSegmentedChartByTimeframe(
    {
      bondingCandles: [
        {
          token: "0x0000000000000000000000000000000000000001",
          timeframe: "1m",
          bucketStart: 60_000,
          open: "1",
          high: "2",
          low: "1",
          close: "2",
          volumeQuote: "10",
          volumeToken: "5",
          trades: 1
        },
        {
          token: "0x0000000000000000000000000000000000000001",
          timeframe: "5m",
          bucketStart: 0,
          open: "1",
          high: "2",
          low: "1",
          close: "2",
          volumeQuote: "10",
          volumeToken: "5",
          trades: 1
        }
      ],
      dexCandles: [
        {
          token: "0x0000000000000000000000000000000000000001",
          timeframe: "5m",
          bucketStart: 0,
          open: "2",
          high: "3",
          low: "2",
          close: "3",
          volumeQuote: "12",
          volumeToken: "6",
          trades: 1
        }
      ],
      graduationTimestampMs: 123_000
    },
    "5m"
  );

  assert.equal(filtered.bondingCandles.length, 1);
  assert.equal(filtered.bondingCandles[0]?.timeframe, "5m");
  assert.equal(filtered.dexCandles.length, 1);
  assert.equal(filtered.dexCandles[0]?.timeframe, "5m");
  assert.equal(filtered.graduationTimestampMs, 123_000);
});
