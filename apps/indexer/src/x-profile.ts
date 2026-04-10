import {
  XPublishError,
  type XUserAuthConfig,
  getXAccessToken,
  isXPublishingConfigured,
  refreshXAccessTokenForApi
} from "./x-publish";

type UpdateXProfileInput = {
  name?: string;
  description?: string;
  url?: string;
  location?: string;
  profileImageBase64?: string;
  bannerBase64?: string;
};

type XApiResponse = {
  errors?: Array<{ message?: string; detail?: string; title?: string }>;
  error?: string;
};

type XProfileUpdateResult = {
  fieldsUpdated: boolean;
  profileImageUpdated: boolean;
  bannerUpdated: boolean;
  tokenRefreshed: boolean;
  refreshTokenRotated: boolean;
};

const UPDATE_PROFILE_URL = "https://api.x.com/1.1/account/update_profile.json";
const UPDATE_PROFILE_IMAGE_URL = "https://api.x.com/1.1/account/update_profile_image.json";
const UPDATE_PROFILE_BANNER_URL = "https://api.x.com/1.1/account/update_profile_banner.json";

function parseJsonSafe<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function sanitizeBase64Image(value: string | undefined) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
}

function appendMaybe(params: URLSearchParams, key: string, value: string | undefined) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (!trimmed) return;
  params.set(key, trimmed);
}

function extractXApiError(payload: XApiResponse | null, status: number, raw: string) {
  const nested = payload?.errors?.[0];
  return new XPublishError(
    nested?.detail || nested?.message || nested?.title || payload?.error || raw || `X profile update failed with ${status}.`,
    status || 502
  );
}

async function postForm(accessToken: string, url: string, body: URLSearchParams) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });

  const raw = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    raw,
    payload: parseJsonSafe<XApiResponse>(raw)
  };
}

async function callWithRefresh(
  config: XUserAuthConfig,
  run: (accessToken: string) => Promise<{ ok: boolean; status: number; raw: string; payload: XApiResponse | null }>
) {
  let { accessToken, tokenRefreshed, refreshTokenRotated } = await getXAccessToken(config);
  let result = await run(accessToken);

  if (!result.ok && result.status === 401 && config.refreshToken) {
    const refreshed = await refreshXAccessTokenForApi(config);
    accessToken = refreshed.accessToken;
    tokenRefreshed = true;
    refreshTokenRotated = refreshTokenRotated || refreshed.refreshTokenRotated;
    result = await run(accessToken);
  }

  return {
    ...result,
    tokenRefreshed,
    refreshTokenRotated
  };
}

export async function updateXProfile(config: XUserAuthConfig, input: UpdateXProfileInput): Promise<XProfileUpdateResult> {
  if (!isXPublishingConfigured(config)) {
    throw new XPublishError("X profile update is not configured.", 503);
  }

  const normalizedInput = {
    ...input,
    profileImageBase64: sanitizeBase64Image(input.profileImageBase64),
    bannerBase64: sanitizeBase64Image(input.bannerBase64)
  };

  const hasFields =
    Boolean(normalizedInput.name?.trim())
    || Boolean(normalizedInput.description?.trim())
    || Boolean(normalizedInput.url?.trim())
    || Boolean(normalizedInput.location?.trim());

  if (!hasFields && !normalizedInput.profileImageBase64 && !normalizedInput.bannerBase64) {
    throw new XPublishError("At least one X profile field or image is required.", 400);
  }

  let tokenRefreshed = false;
  let refreshTokenRotated = false;
  let fieldsUpdated = false;
  let profileImageUpdated = false;
  let bannerUpdated = false;

  if (hasFields) {
    const params = new URLSearchParams();
    appendMaybe(params, "name", normalizedInput.name);
    appendMaybe(params, "description", normalizedInput.description);
    appendMaybe(params, "url", normalizedInput.url);
    appendMaybe(params, "location", normalizedInput.location);

    const result = await callWithRefresh(config, (accessToken) => postForm(accessToken, UPDATE_PROFILE_URL, params));
    tokenRefreshed = tokenRefreshed || result.tokenRefreshed;
    refreshTokenRotated = refreshTokenRotated || result.refreshTokenRotated;

    if (!result.ok) {
      throw extractXApiError(result.payload, result.status, result.raw);
    }
    fieldsUpdated = true;
  }

  if (normalizedInput.profileImageBase64) {
    const params = new URLSearchParams();
    params.set("image", normalizedInput.profileImageBase64);

    const result = await callWithRefresh(config, (accessToken) => postForm(accessToken, UPDATE_PROFILE_IMAGE_URL, params));
    tokenRefreshed = tokenRefreshed || result.tokenRefreshed;
    refreshTokenRotated = refreshTokenRotated || result.refreshTokenRotated;

    if (!result.ok) {
      throw extractXApiError(result.payload, result.status, result.raw);
    }
    profileImageUpdated = true;
  }

  if (normalizedInput.bannerBase64) {
    const params = new URLSearchParams();
    params.set("banner", normalizedInput.bannerBase64);

    const result = await callWithRefresh(config, (accessToken) => postForm(accessToken, UPDATE_PROFILE_BANNER_URL, params));
    tokenRefreshed = tokenRefreshed || result.tokenRefreshed;
    refreshTokenRotated = refreshTokenRotated || result.refreshTokenRotated;

    if (!result.ok) {
      throw extractXApiError(result.payload, result.status, result.raw);
    }
    bannerUpdated = true;
  }

  return {
    fieldsUpdated,
    profileImageUpdated,
    bannerUpdated,
    tokenRefreshed,
    refreshTokenRotated
  };
}
