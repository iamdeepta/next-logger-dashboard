/**
 * next-logger-dashboard — server instrumentation.
 *
 * Next.js calls register() once at server startup. It wraps the global
 * fetch so every server-side call is recorded (method, URL, status,
 * duration, request/response bodies) without editing application code.
 * Server-side axios calls are covered too, when axios is installed.
 * Recording never breaks the application call: any failure inside the
 * recorder is swallowed and the original call proceeds or throws as usual.
 */
import {
  addRecord,
  maskToken,
  readCookieNames,
  truncateBody,
} from './lib/logger-dashboard-store';

function isOwnEndpoint(url: string): boolean {
  return url.includes('/api/logger-dashboard');
}

/**
 * Copy the marker properties Next.js attaches to its patched fetch, so
 * framework behaviour (caching, static-store tracking) keeps working
 * through the wrapper.
 */
function preserveFetchMarkers(wrapper: any, original: any): void {
  for (const key of ['__nextPatched', '__nextGetStaticStore', '_nextOriginalFetch']) {
    try {
      if (key in original) wrapper[key] = original[key];
    } catch {
      // ignore non-writable markers
    }
  }
}

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const g = globalThis as any;
  if (g.__LOGGER_DASHBOARD_PATCHED__) return;
  g.__LOGGER_DASHBOARD_PATCHED__ = true;

  const nativeFetch = g.fetch as typeof fetch;
  if (typeof nativeFetch !== 'function') return;

  const wrappedFetch = async (...fetchArgs: Parameters<typeof fetch>): Promise<Response> => {
    const requestTarget = fetchArgs[0];
    const requestOptions = fetchArgs[1] as RequestInit | undefined;

    let fullUrl: string;
    try {
      fullUrl =
        requestTarget instanceof Request ? requestTarget.url : String(requestTarget);
    } catch {
      return nativeFetch(...fetchArgs);
    }
    if (isOwnEndpoint(fullUrl)) return nativeFetch(...fetchArgs);

    const splitAt = fullUrl.indexOf('?');
    const endpoint = splitAt >= 0 ? fullUrl.slice(0, splitAt) : fullUrl;
    const queryString = splitAt >= 0 ? fullUrl.slice(splitAt + 1) : null;
    const httpMethod =
      requestOptions?.method ??
      (requestTarget instanceof Request ? requestTarget.method : 'GET');

    let accessTokenMasked: string | null = null;
    let cookieNames: string[] = [];
    try {
      const headerBag =
        requestTarget instanceof Request
          ? requestTarget.headers
          : new Headers(requestOptions?.headers ?? {});
      accessTokenMasked = maskToken(headerBag.get('authorization'));
      cookieNames = readCookieNames(headerBag.get('cookie'));
    } catch {
      // headers unreadable — record without them
    }

    let requestPayload: string | null = null;
    try {
      if (typeof requestOptions?.body === 'string') requestPayload = requestOptions.body;
      else if (requestOptions?.body) requestPayload = '[non-text body]';
    } catch {
      requestPayload = null;
    }

    const startedAt = Date.now();
    try {
      const upstreamResponse = await nativeFetch(...fetchArgs);
      let responseBody: string | null = null;
      try {
        responseBody = truncateBody(await upstreamResponse.clone().text());
      } catch {
        responseBody = '[unreadable body]';
      }
      try {
        addRecord({
          source: 'server',
          httpMethod,
          endpoint,
          queryString,
          statusCode: upstreamResponse.status,
          elapsedMs: Date.now() - startedAt,
          requestPayload,
          responseBody,
          accessTokenMasked,
          cookieNames,
          errorMessage: null,
        });
      } catch {
        // recording must never break the response
      }
      return upstreamResponse;
    } catch (failure) {
      try {
        addRecord({
          source: 'server',
          httpMethod,
          endpoint,
          queryString,
          statusCode: 'NETWORK_FAILURE',
          elapsedMs: Date.now() - startedAt,
          requestPayload,
          responseBody: null,
          accessTokenMasked,
          cookieNames,
          errorMessage: failure instanceof Error ? failure.message : String(failure),
        });
      } catch {
        // ignore recorder errors
      }
      throw failure;
    }
  };

  preserveFetchMarkers(wrappedFetch, nativeFetch);
  (wrappedFetch as any).__LOGGER_DASHBOARD_WRAPPED__ = true;
  g.fetch = wrappedFetch;

  // Server-side axios (optional): record completed calls directly into the
  // same store. Silently skipped when axios is not installed.
  try {
    // @ts-ignore — axios is optional; the import fails when it is not installed.
    const axiosModule = await import('axios').catch(() => null);
    const axios = (axiosModule as any)?.default as any;
    if (axios?.interceptors && !axios.__LOGGER_DASHBOARD_AXIOS_WRAPPED__) {
      axios.__LOGGER_DASHBOARD_AXIOS_WRAPPED__ = true;
      axios.interceptors.request.use((config: any) => {
        config.__loggerDashboardStartedAt = Date.now();
        return config;
      });
      axios.interceptors.response.use(
        (response: any) => {
          try {
            const config = response?.config || {};
            const fullUrl = String(config.url || '');
            if (!isOwnEndpoint(fullUrl)) {
              const splitAt = fullUrl.indexOf('?');
              addRecord({
                source: 'server',
                httpMethod: String(config.method || 'GET'),
                endpoint: splitAt >= 0 ? fullUrl.slice(0, splitAt) : fullUrl,
                queryString: splitAt >= 0 ? fullUrl.slice(splitAt + 1) : null,
                statusCode: response.status,
                elapsedMs: Date.now() - (config.__loggerDashboardStartedAt || Date.now()),
                requestPayload:
                  typeof config.data === 'string'
                    ? config.data
                    : config.data
                      ? truncateBody(JSON.stringify(config.data))
                      : null,
                responseBody: truncateBody(
                  typeof response.data === 'string'
                    ? response.data
                    : JSON.stringify(response.data),
                ),
                accessTokenMasked: null,
                cookieNames: [],
                errorMessage: null,
              });
            }
          } catch {
            // ignore recorder errors
          }
          return response;
        },
        (error: any) => {
          try {
            const config = error?.config || {};
            const fullUrl = String(config.url || '');
            if (fullUrl && !isOwnEndpoint(fullUrl)) {
              addRecord({
                source: 'server',
                httpMethod: String(config.method || 'GET'),
                endpoint: fullUrl,
                queryString: null,
                statusCode: 'NETWORK_FAILURE',
                elapsedMs: Date.now() - (config.__loggerDashboardStartedAt || Date.now()),
                requestPayload: null,
                responseBody: null,
                accessTokenMasked: null,
                cookieNames: [],
                errorMessage: error instanceof Error ? error.message : String(error),
              });
            }
          } catch {
            // ignore recorder errors
          }
          return Promise.reject(error);
        },
      );
    }
  } catch {
    // axios interception is best-effort
  }
}
