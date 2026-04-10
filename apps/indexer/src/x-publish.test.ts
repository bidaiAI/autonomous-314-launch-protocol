import test from "node:test";
import assert from "node:assert/strict";
import {
  createXPost,
  getXPublishRuntimeStateForTest,
  isXPublishingConfigured,
  resetXPublishRuntimeTokensForTest
} from "./x-publish";

test("isXPublishingConfigured accepts client credentials plus an account token", () => {
  assert.equal(
    isXPublishingConfigured({
      clientId: "client",
      clientSecret: "secret",
      accessToken: "access"
    }),
    true
  );

  assert.equal(
    isXPublishingConfigured({
      clientId: "client",
      clientSecret: "secret"
    }),
    false
  );
});

test("createXPost posts immediately with an existing access token", async () => {
  resetXPublishRuntimeTokensForTest();

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      data: {
        id: "123",
        text: "hello world"
      }
    }), {
      status: 201,
      headers: {
        "content-type": "application/json"
      }
    });
  }) as typeof fetch;

  try {
    const result = await createXPost({
      clientId: "client",
      clientSecret: "secret",
      accessToken: "access-token",
      refreshToken: "refresh-token"
    }, {
      text: "hello world"
    });

    assert.equal(result.id, "123");
    assert.equal(result.tokenRefreshed, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.x.com/2/tweets");
    assert.equal(calls[0]?.init?.headers && (calls[0].init.headers as Record<string, string>).authorization, "Bearer access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createXPost refreshes and retries after an expired access token", async () => {
  resetXPublishRuntimeTokensForTest();

  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  let step = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    step += 1;

    if (step === 1) {
      return new Response(JSON.stringify({
        error: "Unauthorized"
      }), {
        status: 401,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    if (step === 2) {
      return new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh"
      }), {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    return new Response(JSON.stringify({
      data: {
        id: "456",
        text: "after refresh"
      }
    }), {
      status: 201,
      headers: {
        "content-type": "application/json"
      }
    });
  }) as typeof fetch;

  try {
    const result = await createXPost({
      clientId: "client",
      clientSecret: "secret",
      accessToken: "old-access",
      refreshToken: "old-refresh"
    }, {
      text: "after refresh"
    });

    assert.equal(result.id, "456");
    assert.equal(result.tokenRefreshed, true);
    assert.equal(result.refreshTokenRotated, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0]?.url, "https://api.x.com/2/tweets");
    assert.equal(calls[1]?.url, "https://api.x.com/2/oauth2/token");
    assert.equal(calls[2]?.url, "https://api.x.com/2/tweets");
    assert.equal(getXPublishRuntimeStateForTest().accessToken, "new-access");
    assert.equal(getXPublishRuntimeStateForTest().refreshToken, "new-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
