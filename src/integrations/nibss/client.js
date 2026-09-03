'use strict';

const axios = require('axios');
const axiosRetryModule = require('axios-retry');
const axiosRetry = axiosRetryModule.default || axiosRetryModule;
const env = require('../../config/env');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');

/**
 * Thin, hardened HTTP client for the NibssByPhoenix core-banking API.
 *
 * Responsibilities:
 *  - obtain and cache the bearer token from POST /api/auth/token
 *  - transparently re-authenticate once on a 401
 *  - retry through Render cold starts and transport blips
 *  - normalise every upstream failure into an ApiError
 *
 * It knows nothing about our domain - that lives in nibss.service.js.
 */

const PUBLIC_PATHS = ['/api/auth/token', '/api/fintech/onboard'];

class NibssClient {
  constructor(options = {}) {
    this.baseURL = options.baseURL || env.NIBSS_BASE_URL;
    this.apiKey = options.apiKey !== undefined ? options.apiKey : env.NIBSS_API_KEY;
    this.apiSecret = options.apiSecret !== undefined ? options.apiSecret : env.NIBSS_API_SECRET;

    this.token = null;
    this.tokenExpiresAt = 0;
    this.inFlightAuth = null;

    this.http = axios.create({
      baseURL: this.baseURL,
      timeout: options.timeout || env.NIBSS_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      // Inspect upstream error bodies ourselves rather than letting axios throw first.
      validateStatus: () => true,
    });

    axiosRetry(this.http, {
      retries: env.NIBSS_MAX_RETRIES,
      retryDelay: axiosRetry.exponentialDelay,
      // Only retry transport-level failures, never a rejected business call.
      retryCondition: (error) =>
        axiosRetry.isNetworkError(error) || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT',
      onRetry: (count, error, config) =>
        logger.warn({ attempt: count, url: config.url, err: error.message }, 'Retrying NibssByPhoenix request'),
    });
  }

  get isConfigured() {
    return Boolean(this.apiKey && this.apiSecret);
  }

  // --- Authentication ----------------------------------------------------

  async authenticate({ force = false } = {}) {
    if (!this.isConfigured) {
      throw ApiError.unavailable(
        'NibssByPhoenix credentials are not configured. Run "npm run onboard", then set NIBSS_API_KEY and NIBSS_API_SECRET in .env.',
        { code: 'PROVIDER_NOT_CONFIGURED' }
      );
    }

    const stillValid = this.token && Date.now() < this.tokenExpiresAt;
    if (stillValid && !force) return this.token;

    // Collapse concurrent callers onto a single token request.
    if (this.inFlightAuth) return this.inFlightAuth;

    this.inFlightAuth = (async () => {
      const res = await this.http.post('/api/auth/token', {
        apiKey: this.apiKey,
        apiSecret: this.apiSecret,
      });

      if (res.status >= 400) {
        throw this.toApiError(res, 'Failed to authenticate with NibssByPhoenix');
      }

      const body = res.data || {};
      const payload = body.data && typeof body.data === 'object' ? body.data : body;
      const token = payload.token || payload.accessToken || payload.access_token || payload.jwt;

      if (!token) {
        logger.error({ body }, 'NibssByPhoenix auth response contained no token');
        throw ApiError.badGateway('NibssByPhoenix did not return an access token', {
          code: 'PROVIDER_AUTH_MALFORMED',
        });
      }

      this.token = token;
      this.tokenExpiresAt = this.deriveExpiry(token, payload);
      logger.info({ expiresAt: new Date(this.tokenExpiresAt).toISOString() }, 'NibssByPhoenix token acquired');
      return token;
    })().finally(() => {
      this.inFlightAuth = null;
    });

    return this.inFlightAuth;
  }

  /** Prefer the exp claim inside the JWT; fall back to expiresIn, then a safe default. */
  deriveExpiry(token, payload) {
    const skewMs = env.NIBSS_TOKEN_SKEW_SECONDS * 1000;
    try {
      const part = String(token).split('.')[1];
      if (part) {
        const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
        if (claims.exp) return claims.exp * 1000 - skewMs;
      }
    } catch (_err) {
      // Not a JWT, or an unreadable one - fall through to the defaults below.
    }
    const seconds = Number(payload.expiresIn || payload.expires_in);
    if (Number.isFinite(seconds) && seconds > 0) return Date.now() + seconds * 1000 - skewMs;
    return Date.now() + 45 * 60 * 1000 - skewMs;
  }

  invalidateToken() {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  // --- Request pipeline --------------------------------------------------

  async request(method, url, options = {}, isRetry = false) {
    const { data, params, auth = true, context } = options;

    const headers = {};
    if (auth && !PUBLIC_PATHS.includes(url)) {
      headers.Authorization = `Bearer ${await this.authenticate()}`;
    }

    const startedAt = Date.now();
    let res;
    try {
      res = await this.http.request({ method, url, data, params, headers });
    } catch (err) {
      logger.error({ err: err.message, method, url, context }, 'NibssByPhoenix request failed at transport level');
      throw ApiError.unavailable('Could not reach NibssByPhoenix. Please try again shortly.', {
        code: 'PROVIDER_UNREACHABLE',
        cause: err,
      });
    }

    logger.debug(
      { method, url, status: res.status, durationMs: Date.now() - startedAt, context },
      'NibssByPhoenix response'
    );

    // A cached token may have been revoked upstream - re-auth once, then give up.
    if (res.status === 401 && auth && !isRetry) {
      logger.warn({ url }, 'NibssByPhoenix returned 401 - refreshing token and retrying once');
      this.invalidateToken();
      await this.authenticate({ force: true });
      return this.request(method, url, options, true);
    }

    if (res.status >= 400) throw this.toApiError(res, `NibssByPhoenix ${context || url} failed`);

    return this.unwrap(res.data);
  }

  /**
   * Providers wrap payloads inconsistently; always hand business logic the
   * inner object.
   *
   * NibssByPhoenix is not self-consistent here: the BVN endpoints wrap in
   * `data`, the NIN endpoints wrap in `response`, and account creation nests
   * under `account`. The first two are unwrapped here; `account` is left in
   * place because nibss.service resolves it while reading fields.
   */
  unwrap(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return body;

    for (const key of ['data', 'response']) {
      const inner = body[key];
      if (inner === undefined || inner === null) continue;
      if (typeof inner === 'object' && !Array.isArray(inner)) {
        const rest = { ...body };
        delete rest[key];
        return { ...inner, _envelope: rest };
      }
      return inner;
    }
    return body;
  }

  toApiError(res, fallbackMessage) {
    const body = res.data;
    const upstreamMessage =
      (body && (body.message || body.error || body.errorMessage || body.responseMessage)) ||
      (typeof body === 'string' ? body.slice(0, 300) : null);

    // 401/403 from upstream means OUR credentials are wrong, not the caller who
    // is already authenticated with us - so never leak it back as a 401.
    let status;
    if (res.status === 401 || res.status === 403) status = 502;
    else if ([400, 404, 409, 422].includes(res.status)) status = res.status;
    else status = 502;

    return new ApiError(status, upstreamMessage || fallbackMessage, {
      code: 'PROVIDER_ERROR',
      details: { providerStatus: res.status, providerBody: truncate(body) },
    });
  }

  get(url, opts) {
    return this.request('get', url, opts);
  }

  post(url, data, opts) {
    return this.request('post', url, { ...opts, data });
  }
}

function truncate(body) {
  try {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    if (s && s.length > 1000) return `${s.slice(0, 1000)}...`;
    return body;
  } catch (_err) {
    return undefined;
  }
}

module.exports = { NibssClient, nibssClient: new NibssClient() };
