type XPublishConfig = {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
};

export type XUserAuthConfig = XPublishConfig;

type XTokenRefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

type XCreateTweetResponse = {
  data?: {
    id?: string;
    text?: string;
  };
  errors?: Array<{ message?: string; detail?: string; title?: string }>;
  error?: string;
};

type CreateXPostInput = {
  text: string;
  replyToTweetId?: string;
};

type CreateXPostResult = {
  id: string;
  text: string;
  tokenRefreshed: boolean;
  refreshTokenRotated: boolean;
};

const TOKEN_URL = "https://api.x.com/2/oauth2/token";
const CREATE_TWEET_URL = "https://api.x.com/2/tweets";

const runtimeTokens: {
  seeded: boolean;
  accessToken?: string;
  refreshToken?: string;
} = {
  seeded: false
};

export class XPublishError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = "XPublishError";
    this.status = status;
  }
}

function seedRuntimeTokens(config: XPublishConfig) {
  if (runtimeTokens.seeded) {
    return;
  }

  runtimeTokens.seeded = true;
  runtimeTokens.accessToken = config.accessToken;
  runtimeTokens.refreshToken = config.refreshToken;
}

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function refreshXAccessToken(config: XPublishConfig) {
  seedRuntimeTokens(config);

  if (!config.clientId || !config.clientSecret) {
    throw new XPublishError("X publish client credentials are missing.", 503);
  }

  if (!runtimeTokens.refreshToken) {
    throw new XPublishError("X account refresh token is missing.", 503);
  }

  const params = new URLSearchParams();
  params.set("grant_type", "refresh_token");
  params.set("refresh_token", runtimeTokens.refreshToken);
  params.set("client_id", config.clientId);

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: params.toString()
  });

  const text = await response.text();
  const payload = parseJsonSafe<XTokenRefreshResponse>(text);

  if (!response.ok || !payload?.access_token) {
    throw new XPublishError(
      payload?.error_description || payload?.error || `X token refresh failed with ${response.status}.`,
      response.status || 502
    );
  }

  const previousRefreshToken = runtimeTokens.refreshToken;
  runtimeTokens.accessToken = payload.access_token;
  runtimeTokens.refreshToken = payload.refresh_token ?? runtimeTokens.refreshToken;

  return {
    accessToken: runtimeTokens.accessToken,
    refreshTokenRotated: Boolean(payload.refresh_token && payload.refresh_token !== previousRefreshToken)
  };
}

export async function getXAccessToken(config: XUserAuthConfig) {
  seedRuntimeTokens(config);

  if (!config.clientId || !config.clientSecret) {
    throw new XPublishError("X publish client credentials are missing.", 503);
  }

  if (!runtimeTokens.accessToken && !runtimeTokens.refreshToken) {
    throw new XPublishError("X account access token or refresh token is missing.", 503);
  }

  if (runtimeTokens.accessToken) {
    return {
      accessToken: runtimeTokens.accessToken,
      tokenRefreshed: false,
      refreshTokenRotated: false
    };
  }

  const refreshed = await refreshXAccessToken(config);
  return {
    accessToken: refreshed.accessToken,
    tokenRefreshed: true,
    refreshTokenRotated: refreshed.refreshTokenRotated
  };
}

export async function refreshXAccessTokenForApi(config: XUserAuthConfig) {
  const refreshed = await refreshXAccessToken(config);
  return {
    accessToken: refreshed.accessToken,
    tokenRefreshed: true,
    refreshTokenRotated: refreshed.refreshTokenRotated
  };
}

async function sendCreateTweet(accessToken: string, input: CreateXPostInput) {
  const response = await fetch(CREATE_TWEET_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      text: input.text,
      ...(input.replyToTweetId
        ? {
            reply: {
              in_reply_to_tweet_id: input.replyToTweetId
            }
          }
        : {})
    })
  });

  const text = await response.text();
  const payload = parseJsonSafe<XCreateTweetResponse>(text);

  return {
    status: response.status,
    ok: response.ok,
    payload,
    raw: text
  };
}

function extractPublishError(payload: XCreateTweetResponse | null, fallbackStatus: number, fallbackRaw: string) {
  const nested = payload?.errors?.[0];
  return new XPublishError(
    nested?.detail || nested?.message || nested?.title || payload?.error || fallbackRaw || "X publish failed.",
    fallbackStatus
  );
}

export function isXPublishingConfigured(config: XPublishConfig) {
  return Boolean(config.clientId && config.clientSecret && (config.accessToken || config.refreshToken));
}

export function resetXPublishRuntimeTokensForTest() {
  runtimeTokens.seeded = false;
  runtimeTokens.accessToken = undefined;
  runtimeTokens.refreshToken = undefined;
}

export function getXPublishRuntimeStateForTest() {
  return {
    accessToken: runtimeTokens.accessToken,
    refreshToken: runtimeTokens.refreshToken,
    seeded: runtimeTokens.seeded
  };
}

export async function createXPost(config: XPublishConfig, input: CreateXPostInput): Promise<CreateXPostResult> {
  let { accessToken, tokenRefreshed, refreshTokenRotated } = await getXAccessToken(config);

  let publish = await sendCreateTweet(accessToken, input);

  if (!publish.ok && publish.status === 401 && runtimeTokens.refreshToken) {
    const refreshed = await refreshXAccessTokenForApi(config);
    accessToken = refreshed.accessToken;
    tokenRefreshed = true;
    refreshTokenRotated = refreshTokenRotated || refreshed.refreshTokenRotated;
    publish = await sendCreateTweet(accessToken, input);
  }

  if (!publish.ok || !publish.payload?.data?.id || !publish.payload.data.text) {
    throw extractPublishError(publish.payload ?? null, publish.status || 502, publish.raw);
  }

  return {
    id: publish.payload.data.id,
    text: publish.payload.data.text,
    tokenRefreshed,
    refreshTokenRotated
  };
}
