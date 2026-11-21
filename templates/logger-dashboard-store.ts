/**
 * next-logger-dashboard — shared in-memory record store (server only).
 *
 * Used by instrumentation.ts, the records route and the ingest route. The
 * array lives on globalThis so every server bundle in the same process
 * shares one list. Never import this module from a client component —
 * dashboard data flows through /api/logger-dashboard/records instead.
 */

export interface LoggerRecord {
  /** Unique id. */
  id: string;
  /** ISO timestamp of when the call finished. */
  recordedAt: string;
  /** Where the call was observed. */
  source: 'server' | 'client';
  httpMethod: string;
  /** URL without the query string. */
  endpoint: string;
  /** The ?query part, kept separately. */
  queryString: string | null;
  statusCode: number | 'NETWORK_FAILURE';
  elapsedMs: number;
  requestPayload: string | null;
  responseBody: string | null;
  /** e.g. "Bearer ...1234" — never the full token. */
  accessTokenMasked: string | null;
  /** Cookie names only, never values. */
  cookieNames: string[];
  /** Set only when the call threw. */
  errorMessage: string | null;
}

/** Maximum records kept in memory (newest first). */
export const MAX_RECORDS = 200;
/** Maximum response/request body characters stored per record. */
export const MAX_BODY_CHARS = 20000;

const STORE_KEY = '__LOGGER_DASHBOARD_RECORDS__';

function getStore(): LoggerRecord[] {
  const g = globalThis as any;
  if (!Array.isArray(g[STORE_KEY])) g[STORE_KEY] = [];
  return g[STORE_KEY] as LoggerRecord[];
}

/** Keep only the tail of a token: "Bearer abc123" -> "Bearer ...c123". */
export function maskToken(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split(' ');
  const secret = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  const scheme = parts.length > 1 ? parts[0] + ' ' : '';
  return scheme + '...' + secret.slice(-4);
}

/** "session=abc; csrf=xyz" -> ["session", "csrf"]. Values are dropped. */
export function readCookieNames(rawCookie: string | null): string[] {
  if (!rawCookie) return [];
  return rawCookie
    .split(';')
    .map((pair) => pair.split('=')[0].trim())
    .filter(Boolean);
}

/** Truncate long bodies so one huge download cannot fill the store. */
export function truncateBody(body: string | null): string | null {
  if (body === null || body === undefined) return null;
  const text = String(body);
  if (text.length <= MAX_BODY_CHARS) return text;
  return text.slice(0, MAX_BODY_CHARS) + '\n[truncated — first ' + MAX_BODY_CHARS + ' characters kept]';
}

/** Newest first. */
export function getRecords(): LoggerRecord[] {
  return [...getStore()];
}

/** Store a record. Missing fields are filled with safe defaults. */
export function addRecord(
  partial: Partial<LoggerRecord> & { httpMethod: string; endpoint: string },
): LoggerRecord {
  // Any recorded request (e.g. an axios call via the http layer) is a
  // chance to re-wrap the server fetch wrapper if it was replaced.
  healFetchWrapperIfNeeded();
  const record: LoggerRecord = {
    id:
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
    recordedAt: new Date().toISOString(),
    source: partial.source === 'client' ? 'client' : 'server',
    httpMethod: String(partial.httpMethod || 'GET').toUpperCase(),
    endpoint: String(partial.endpoint || ''),
    queryString: partial.queryString ?? null,
    statusCode: partial.statusCode ?? 'NETWORK_FAILURE',
    elapsedMs: typeof partial.elapsedMs === 'number' ? partial.elapsedMs : 0,
    requestPayload: truncateBody(partial.requestPayload ?? null),
    responseBody: truncateBody(partial.responseBody ?? null),
    accessTokenMasked: partial.accessTokenMasked ?? null,
    cookieNames: Array.isArray(partial.cookieNames) ? partial.cookieNames : [],
    errorMessage: partial.errorMessage ?? null,
  };
  const store = getStore();
  store.unshift(record);
  if (store.length > MAX_RECORDS) store.length = MAX_RECORDS;
  return record;
}

export function clearRecords(): void {
  getStore().length = 0;
}

/**
 * Next.js framework requests — never real API calls. The browser logger
 * sees them as client fetches (RSC payloads on navigation carry the
 * page URL), and the server fetch wrapper can see them too. Recording
 * them drowns the real API calls in page URLs.
 *
 * - `?_rsc=` — App Router RSC payload requests (client navigation,
 *   prefetch). The page URL is the endpoint, which is exactly the
 *   "only page URLs" noise users report.
 * - `/_next/` — framework assets and data (static chunks, data JSON).
 */
export function isFrameworkRequest(url: string): boolean {
  try {
    const text = String(url || '');
    if (!text) return false;
    if (text.includes('_rsc=')) return true;
    const path = new URL(text, 'http://localhost').pathname;
    return path === '/_next' || path.startsWith('/_next/');
  } catch {
    return false;
  }
}

/** Server capture state, set by instrumentation.ts register(). */
export interface ServerCaptureStatus {
  /** process.env.NEXT_RUNTIME when register() ran ('nodejs', 'edge', or null). */
  runtime: string | null;
  /** True once the server fetch wrapper is installed. */
  fetchWrapped: boolean;
  /** 'active' once the http layer (axios/raw http) is patched. */
  httpLayer: 'active' | 'unavailable' | 'not-started';
  /** Why the http layer is unavailable, when it is. */
  httpLayerReason: string | null;
  /** process.version, e.g. "v22.14.0". */
  nodeVersion: string | null;
}

const STATUS_KEY = '__LOGGER_DASHBOARD_SERVER_STATUS__';

/**
 * Re-wrap the server fetch wrapper if something replaced it after
 * register() (see instrumentation.ts healFetchWrapper). No-op in the
 * browser and when instrumentation never ran.
 */
export function healFetchWrapperIfNeeded(): void {
  try {
    const heal = (globalThis as any).__LOGGER_DASHBOARD_HEAL_FETCH__;
    if (typeof heal === 'function') heal();
  } catch {
    // ignore
  }
}

/** Null when instrumentation.ts never ran in this process. */
export function getServerStatus(): ServerCaptureStatus | null {
  const g = globalThis as any;
  const status = g[STATUS_KEY] as ServerCaptureStatus | undefined;
  if (!status) return null;
  // fetchWrapped was set when register() ran; report the LIVE state —
  // the wrapper can be replaced afterwards, and the dashboard must not
  // claim "on" while no server fetch is being recorded.
  return {
    ...status,
    fetchWrapped: (g.fetch as any)?.__LOGGER_DASHBOARD_WRAPPED__ === true,
  };
}
