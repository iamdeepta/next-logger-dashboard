'use client';
/**
 * next-logger-dashboard — browser logger.
 *
 * Imported once for its side effects from the root layout, through the
 * LoggerDashboardInit client component. The 'use client' directive above
 * is required: without it, an import from a Server Component layout
 * would only ever run on the server and the browser patching below
 * would never install. Runs only in the browser: it wraps window.fetch
 * and XMLHttpRequest. Axios calls need no separate interceptor — axios
 * uses the XHR/fetch adapters in the browser, so its calls are captured
 * by the same patching (adding interceptors too would record each axios
 * call twice). Completed calls are POSTed as finished records to
 * /api/logger-dashboard/ingest — the request itself is never
 * re-executed server-side, so mutating calls run exactly once.
 * All failures are swallowed: logging must never break the app.
 *
 * The ingest endpoint is same-origin, so no CORS setup is needed. When an
 * access key is configured, the browser sends the public key variable
 * NEXT_PUBLIC_LOGGER_DASHBOARD_KEY (same value as LOGGER_DASHBOARD_KEY).
 */
const INGEST_PATH = '/api/logger-dashboard/ingest';
const MAX_BODY_CHARS = 20000;
function isOwnEndpoint(url) {
    if (!url)
        return true;
    const text = String(url);
    return text.includes('/api/logger-dashboard');
}
function truncateBody(body) {
    if (body === null || body === undefined)
        return null;
    const text = String(body);
    if (text.length <= MAX_BODY_CHARS)
        return text;
    return text.slice(0, MAX_BODY_CHARS) + '\n[truncated]';
}
function maskToken(raw) {
    if (!raw)
        return null;
    const parts = raw.split(' ');
    const secret = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const scheme = parts.length > 1 ? parts[0] + ' ' : '';
    return scheme + '...' + secret.slice(-4);
}
function readCookieNames(rawCookie) {
    if (!rawCookie)
        return [];
    return rawCookie
        .split(';')
        .map((pair) => pair.split('=')[0].trim())
        .filter(Boolean);
}
function getKeyHeader() {
    try {
        const key = typeof process !== 'undefined'
            ? process.env?.NEXT_PUBLIC_LOGGER_DASHBOARD_KEY
            : undefined;
        return key ? { 'x-logger-key': String(key) } : {};
    }
    catch {
        return {};
    }
}
function sendRecord(record) {
    try {
        if (typeof fetch !== 'function')
            return;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), 3000) : null;
        fetch(INGEST_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getKeyHeader() },
            body: JSON.stringify(record),
            keepalive: true,
            signal: controller ? controller.signal : undefined,
        })
            .catch(() => { })
            .finally(() => {
            if (timer)
                clearTimeout(timer);
        });
    }
    catch {
        // logging must never throw
    }
}
function headersToObject(headersIn) {
    const out = {};
    try {
        if (!headersIn)
            return out;
        if (typeof Headers !== 'undefined' && headersIn instanceof Headers) {
            headersIn.forEach((value, key) => {
                out[key] = value;
            });
        }
        else if (Array.isArray(headersIn)) {
            for (const [k, v] of headersIn)
                out[String(k)] = String(v);
        }
        else if (typeof headersIn === 'object') {
            for (const k of Object.keys(headersIn))
                out[k] = String(headersIn[k]);
        }
    }
    catch {
        // ignore unreadable headers
    }
    return out;
}
function initBrowserLogging() {
    if (typeof window === 'undefined')
        return;
    const w = window;
    if (w.__LOGGER_DASHBOARD_BROWSER_PATCHED__)
        return;
    w.__LOGGER_DASHBOARD_BROWSER_PATCHED__ = true;
    // ---- fetch ----
    if (typeof window.fetch === 'function' &&
        !window.fetch.__LOGGER_DASHBOARD_WRAPPED__) {
        const originalFetch = window.fetch.bind(window);
        const wrappedFetch = async (...args) => {
            const input = args[0];
            const init = args[1];
            let url = '';
            try {
                url =
                    typeof input === 'string'
                        ? input
                        : input instanceof URL
                            ? input.toString()
                            : input && typeof input === 'object' && 'url' in input
                                ? String(input.url || '')
                                : String(input);
            }
            catch {
                return originalFetch(...args);
            }
            if (isOwnEndpoint(url))
                return originalFetch(...args);
            const method = String(init?.method ||
                (input && typeof input === 'object' && 'method' in input
                    ? input.method
                    : 'GET')).toUpperCase();
            const headerObj = headersToObject(init?.headers || input?.headers);
            const splitAt = url.indexOf('?');
            const startedAt = Date.now();
            let requestPayload = null;
            try {
                if (typeof init?.body === 'string')
                    requestPayload = init.body;
                else if (init?.body)
                    requestPayload = '[non-text body]';
            }
            catch {
                requestPayload = null;
            }
            try {
                const response = await originalFetch(...args);
                let responseBody = null;
                try {
                    responseBody = truncateBody(await response.clone().text());
                }
                catch {
                    responseBody = '[unreadable body]';
                }
                sendRecord({
                    source: 'client',
                    httpMethod: method,
                    endpoint: splitAt >= 0 ? url.slice(0, splitAt) : url,
                    queryString: splitAt >= 0 ? url.slice(splitAt + 1) : null,
                    statusCode: response.status,
                    elapsedMs: Date.now() - startedAt,
                    requestPayload,
                    responseBody,
                    accessTokenMasked: maskToken(headerObj.authorization || headerObj.Authorization || null),
                    cookieNames: readCookieNames(headerObj.cookie || headerObj.Cookie || null),
                    errorMessage: null,
                });
                return response;
            }
            catch (failure) {
                sendRecord({
                    source: 'client',
                    httpMethod: method,
                    endpoint: splitAt >= 0 ? url.slice(0, splitAt) : url,
                    queryString: splitAt >= 0 ? url.slice(splitAt + 1) : null,
                    statusCode: 'NETWORK_FAILURE',
                    elapsedMs: Date.now() - startedAt,
                    requestPayload,
                    responseBody: null,
                    accessTokenMasked: null,
                    cookieNames: [],
                    errorMessage: failure instanceof Error ? failure.message : String(failure),
                });
                throw failure;
            }
        };
        wrappedFetch.__LOGGER_DASHBOARD_WRAPPED__ = true;
        window.fetch = wrappedFetch;
    }
    // ---- XMLHttpRequest ----
    try {
        const proto = XMLHttpRequest.prototype;
        if (!proto.__LOGGER_DASHBOARD_WRAPPED__) {
            const origOpen = proto.open;
            const origSend = proto.send;
            const origSetHeader = proto.setRequestHeader;
            proto.open = function (method, url, ...rest) {
                this.__loggerDashboardMethod = String(method || 'GET').toUpperCase();
                this.__loggerDashboardUrl = String(url || '');
                this.__loggerDashboardHeaders = {};
                this.__loggerDashboardStartedAt = Date.now();
                return origOpen.apply(this, [method, url, ...rest]);
            };
            proto.setRequestHeader = function (key, value) {
                try {
                    this.__loggerDashboardHeaders[String(key)] = String(value);
                }
                catch {
                    // ignore
                }
                return origSetHeader.apply(this, [key, value]);
            };
            proto.send = function (body) {
                const xhr = this;
                const url = xhr.__loggerDashboardUrl || '';
                if (!isOwnEndpoint(url)) {
                    const onDone = () => {
                        try {
                            let responseBody = null;
                            try {
                                responseBody = truncateBody(typeof xhr.responseText === 'string' ? xhr.responseText : '[non-text body]');
                            }
                            catch {
                                responseBody = '[unreadable body]';
                            }
                            const headerObj = xhr.__loggerDashboardHeaders || {};
                            const splitAt = url.indexOf('?');
                            sendRecord({
                                source: 'client',
                                httpMethod: xhr.__loggerDashboardMethod || 'GET',
                                endpoint: splitAt >= 0 ? url.slice(0, splitAt) : url,
                                queryString: splitAt >= 0 ? url.slice(splitAt + 1) : null,
                                statusCode: xhr.status || 'NETWORK_FAILURE',
                                elapsedMs: Date.now() - (xhr.__loggerDashboardStartedAt || Date.now()),
                                requestPayload: typeof body === 'string' ? body : body ? '[non-text body]' : null,
                                responseBody,
                                accessTokenMasked: maskToken(headerObj.authorization || headerObj.Authorization || null),
                                cookieNames: readCookieNames(headerObj.cookie || headerObj.Cookie || null),
                                errorMessage: xhr.status === 0 ? 'Network error' : null,
                            });
                        }
                        catch {
                            // ignore recorder errors
                        }
                    };
                    try {
                        xhr.addEventListener('loadend', onDone);
                    }
                    catch {
                        // ignore
                    }
                }
                return origSend.apply(this, [body]);
            };
            proto.__LOGGER_DASHBOARD_WRAPPED__ = true;
        }
    }
    catch {
        // XHR patching is best-effort
    }
    // NOTE: no axios interceptor here on purpose. In the browser axios
    // uses the XHR adapter (or the fetch adapter when configured), so its
    // calls are already captured — with full URL, status and body — by the
    // fetch/XHR patching above. Adding axios interceptors as well would
    // record every axios call twice. Server-side axios is covered by the
    // interceptors in instrumentation.ts instead.
}
initBrowserLogging();
export default {};
