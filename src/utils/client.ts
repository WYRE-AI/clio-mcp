import { AsyncLocalStorage } from 'node:async_hooks';
import { ClioClient, type ClioRegion } from '@wyre-technology/node-clio';
import { logger } from './logger.js';

export interface ClioCredentials {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  region?: ClioRegion;
}

const VALID_REGIONS: ClioRegion[] = ['us', 'ca', 'eu', 'au'];

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Parse gateway-injected Clio credential headers (skill 2.4, Clio-specific).
 * This vendor is OAuth-only -- there is no static API key. The gateway runs
 * its own OAuth authorize/token flow with the user and forwards the result
 * here per request:
 *   X-Clio-Access-Token   (required)
 *   X-Clio-Refresh-Token  (optional -- enables auto-refresh)
 *   X-Clio-Client-Id      (optional -- required only if a refresh token is present)
 *   X-Clio-Client-Secret  (optional -- required only if a refresh token is present)
 *   X-Clio-Region         (optional, default 'us')
 * Returns null when no access token header is present. HTTP gateway mode
 * rejects that request with 401 and does not fall back to CLIO_* env vars.
 * Env / stdio mode may still serve a request with no headers; `tools/call`
 * then fails inside getClient() when no credentials exist.
 */
export function credentialsFromHeaders(
  headers: Record<string, string | string[] | undefined>
): ClioCredentials | null {
  const get = (name: string): string | undefined => firstHeaderValue(headers[name.toLowerCase()]);

  const accessToken = get('x-clio-access-token');
  if (!accessToken) return null;

  const regionRaw = get('x-clio-region')?.toLowerCase();
  const region = VALID_REGIONS.includes(regionRaw as ClioRegion) ? (regionRaw as ClioRegion) : 'us';

  return {
    accessToken,
    refreshToken: get('x-clio-refresh-token'),
    clientId: get('x-clio-client-id'),
    clientSecret: get('x-clio-client-secret'),
    region,
  };
}

/**
 * Request-scoped credential store. In gateway mode, http.ts runs each
 * request's handling inside `runWithCredentials(creds, ...)`. This keeps
 * concurrent requests from different tenants from clobbering each other's
 * credentials the way a single mutable module-level variable would.
 */
const credentialStore = new AsyncLocalStorage<ClioCredentials>();

export function runWithCredentials<T>(creds: ClioCredentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

/**
 * Resolve credentials in priority order:
 * 1. The AsyncLocalStorage scope opened for the current request (gateway mode).
 * 2. `CLIO_*` environment variables (stdio / single-tenant mode).
 */
export function getCredentials(): ClioCredentials | null {
  const scoped = credentialStore.getStore();
  if (scoped?.accessToken) return scoped;

  const accessToken = process.env.CLIO_ACCESS_TOKEN;
  if (!accessToken) return null;

  const regionRaw = process.env.CLIO_REGION?.toLowerCase();
  const region = VALID_REGIONS.includes(regionRaw as ClioRegion) ? (regionRaw as ClioRegion) : 'us';

  return {
    accessToken,
    refreshToken: process.env.CLIO_REFRESH_TOKEN,
    clientId: process.env.CLIO_CLIENT_ID,
    clientSecret: process.env.CLIO_CLIENT_SECRET,
    region,
  };
}

/**
 * Client cache, keyed by a fingerprint of the full credential set. This gives
 * us the "invalidate/reconstruct the cached client when credentials change"
 * behavior skill 2.10 asks for, without a single shared mutable singleton
 * that two concurrent requests bearing different tokens could clobber (see
 * `credentialStore` above) -- each distinct token gets its own `ClioClient`
 * instance (and thus its own in-memory access-token-after-refresh state).
 */
const clientCache = new Map<string, ClioClient>();
const MAX_CACHE_ENTRIES = 50;

function cacheKeyFor(creds: ClioCredentials): string {
  return JSON.stringify([creds.accessToken, creds.refreshToken, creds.clientId, creds.clientSecret, creds.region]);
}

export async function getClient(): Promise<ClioClient> {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      'No Clio credentials configured. Provide the X-Clio-Access-Token header (gateway mode) or set the CLIO_ACCESS_TOKEN environment variable (stdio mode).'
    );
  }

  const key = cacheKeyFor(creds);
  const cached = clientCache.get(key);
  if (cached) return cached;

  if (clientCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = clientCache.keys().next().value;
    if (oldestKey !== undefined) clientCache.delete(oldestKey);
  }

  const client = new ClioClient({
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    region: creds.region ?? 'us',
    onTokenRefresh: (tokens) => {
      // Re-key so a later call presenting the *old* access token (a stale
      // gateway-cached header on a retried request) still resolves to this
      // same client instance rather than constructing a duplicate that would
      // immediately 401 and try to refresh again.
      clientCache.delete(key);
      clientCache.set(cacheKeyFor({ ...creds, accessToken: tokens.accessToken }), client);
      logger.debug('Clio access token refreshed');
    },
  });
  clientCache.set(key, client);
  return client;
}

/** Clears the entire client cache. Exposed for tests. */
export function resetClient(): void {
  clientCache.clear();
}
