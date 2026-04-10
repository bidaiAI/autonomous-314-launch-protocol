import { createHash, randomBytes } from "node:crypto";

type XAuthConfig = {
  clientId?: string;
  clientSecret?: string;
  callbackUrl?: string;
  scopes: string[];
};

type PendingAuthState = {
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
};

type XTokenResponse = {
  token_type?: string;
  expires_in?: number;
  access_token?: string;
  scope?: string;
  refresh_token?: string;
};

const AUTHORIZE_URL = "https://x.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const STATE_TTL_MS = 15 * 60_000;
const pendingStates = new Map<string, PendingAuthState>();

function base64Url(input: Buffer | string) {
  const value = Buffer.isBuffer(input) ? input.toString("base64") : Buffer.from(input).toString("base64");
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256Base64Url(value: string) {
  return base64Url(createHash("sha256").update(value).digest());
}

function pruneExpiredStates(now = Date.now()) {
  for (const [state, session] of pendingStates.entries()) {
    if (now - session.createdAt > STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

function createCodeVerifier() {
  return base64Url(randomBytes(48));
}

function createState() {
  return base64Url(randomBytes(24));
}

export function isXAuthConfigured(config: XAuthConfig) {
  return Boolean(config.clientId && config.clientSecret && config.callbackUrl);
}

export function createXAuthorizationUrl(config: XAuthConfig) {
  if (!isXAuthConfigured(config)) {
    throw new Error("X OAuth is not configured.");
  }

  pruneExpiredStates();
  const codeVerifier = createCodeVerifier();
  const state = createState();
  const redirectUri = config.callbackUrl!;
  pendingStates.set(state, {
    codeVerifier,
    redirectUri,
    createdAt: Date.now()
  });

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");

  return {
    state,
    url: url.toString()
  };
}

export async function exchangeXOAuthCode(config: XAuthConfig, code: string, state: string) {
  if (!isXAuthConfigured(config)) {
    throw new Error("X OAuth is not configured.");
  }

  pruneExpiredStates();
  const pending = pendingStates.get(state);
  if (!pending) {
    throw new Error("Authorization state is missing or expired.");
  }
  pendingStates.delete(state);

  const params = new URLSearchParams();
  params.set("code", code);
  params.set("grant_type", "authorization_code");
  params.set("client_id", config.clientId!);
  params.set("redirect_uri", pending.redirectUri);
  params.set("code_verifier", pending.codeVerifier);

  const basic = Buffer.from(`${config.clientId!}:${config.clientSecret!}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const text = await response.text();
  let payload: XTokenResponse & { error?: string; error_description?: string };
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`X token exchange failed with ${response.status}: ${text}`);
  }

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || `X token exchange failed with ${response.status}.`);
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? "",
    scope: payload.scope ?? config.scopes.join(" "),
    tokenType: payload.token_type ?? "bearer",
    expiresIn: payload.expires_in ?? 0
  };
}
