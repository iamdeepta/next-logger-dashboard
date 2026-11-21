/**
 * next-logger-dashboard — server instrumentation.
 *
 * Next.js calls register() once at server startup. It wraps the global
 * fetch so every server-side call is recorded (method, URL, status,
 * duration, request/response bodies) without editing application code.
 * Server-side axios calls (any instance) and raw http/https calls are
 * captured at the Node.js http layer instead — see patchHttpLayer below.
 * Recording never breaks the application call: any failure inside the
 * recorder is swallowed and the original call proceeds or throws as usual.
 *
 * NOTE: this file must NOT statically import Node builtins
 * (node:http / node:https / node:zlib). Next.js compiles it for the Edge
 * runtime too, and webpack has no plugin for the "node:" scheme — the
 * build fails with UnhandledSchemeError (Turbopack only warns, which is
 * why the failure only shows up in webpack apps). The builtins are
 * loaded lazily at runtime, inside register(), only when the Node.js
 * runtime is confirmed — see loadNodeBuiltins below.
 */
import { addRecord, isFrameworkRequest, maskToken, MAX_BODY_CHARS, readCookieNames, truncateBody, } from './lib/logger-dashboard-store';
function isOwnEndpoint(url) {
    return url.includes('/api/logger-dashboard');
}
/**
 * Copy the marker properties Next.js attaches to its patched fetch, so
 * framework behaviour (caching, static-store tracking) keeps working
 * through the wrapper.
 */
function preserveFetchMarkers(wrapper, original) {
    for (const key of ['__nextPatched', '__nextGetStaticStore', '_nextOriginalFetch']) {
        try {
            if (key in original)
                wrapper[key] = original[key];
        }
        catch {
            // ignore non-writable markers
        }
    }
}
/**
 * Server-side HTTP capture (axios, raw http/https) at the Node.js http
 * layer — NOT via axios interceptors.
 *
 * Why: bundlers (Turbopack/webpack) give the instrumentation module and
 * the app's route modules DIFFERENT copies of the axios module, so
 * interceptors attached to the copy imported inside register() never see
 * the app's calls. Verified live: register() imported axios fine and
 * attached interceptors, yet the route handler's axios instance showed
 * no marker and recorded nothing. Every axios call — default instance,
 * created instances, any version — and every raw http/https call goes
 * through http.ClientRequest, so patching its prototype catches them
 * all, regardless of load order or bundling. fetch is NOT affected: it
 * runs on undici, not ClientRequest, so the fetch wrapper above stays
 * the only recorder for fetch calls (no double-recording).
 *
 * Two patches work together (see patchHttpLayer): http.request /
 * https.request are wrapped so the response callback snapshots the
 * content-encoding BEFORE axios's http adapter deletes that header from
 * the shared response object (verified live: the tapped bytes were gzip
 * while res.headers showed no content-encoding at all), and the
 * ClientRequest prototype is patched for everything else (http.get,
 * direct ClientRequest use). A magic-byte fallback decodes gzip/zlib
 * even when no encoding was captured.
 *
 * The Node builtins (http/https/zlib) are NOT imported at the top of
 * this file: they are loaded lazily by loadNodeBuiltins() inside
 * register(), after the Node.js runtime check. A static node: import
 * breaks webpack builds (UnhandledSchemeError) because Next.js also
 * compiles this file for the Edge runtime.
 */
const HTTP_BODY_KEY = '__loggerDashboardReqBody__';
const HTTP_TRACKED_KEY = '__loggerDashboardHttpTracked__';
const HTTP_ENCODING_KEY = '__loggerDashboardContentEncoding__';
const HTTP_PATCHED_KEY = '__LOGGER_DASHBOARD_HTTP_PATCHED__';
const HTTP_REQUEST_PATCHED_KEY = '__LOGGER_DASHBOARD_HTTP_REQUEST_PATCHED__';
// Lazily loaded Node builtins (see loadNodeBuiltins). Null until
// register() loads them; patchHttpLayer/decodeResponseBody only run
// after a successful load.
let nodeHttp = null;
let nodeHttps = null;
let nodeGunzipSync = null;
let nodeInflateSync = null;
let nodeBrotliDecompressSync = null;
function httpRequestUrl(req) {
    try {
        const protocol = String(req.protocol || 'http:');
        // The Host header carries the port the caller actually used
        // ("127.0.0.1:3000"); req.host alone is just the hostname.
        const hostHeader = req.getHeader?.('host');
        const host = hostHeader
            ? String(hostHeader)
            : String(req.host || 'localhost') +
                (req.port ? `:${req.port}` : '');
        const path = String(req.path || '/');
        return `${protocol}//${host}${path}`;
    }
    catch {
        return '';
    }
}
function headerValue(req, name) {
    try {
        const value = req.getHeader?.(name);
        if (value == null)
            return null;
        return Array.isArray(value) ? value.join(', ') : String(value);
    }
    catch {
        return null;
    }
}
/** Decode a response body per its content-encoding (gzip/deflate/br). */
function decodeResponseBody(encoding, buffers) {
    try {
        const raw = Buffer.concat(buffers);
        const enc = (encoding || '').toLowerCase();
        // Magic-byte fallback: axios deletes the content-encoding header
        // from the shared response object before a late 'response' listener
        // can read it, so a stored snapshot is preferred — but when none
        // exists, the bytes themselves say gzip (1f 8b) or zlib (78 01/9c/da).
        if (enc.includes('gzip') ||
            (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b)) {
            return nodeGunzipSync ? nodeGunzipSync(raw).toString('utf8') : raw.toString('utf8');
        }
        if (enc.includes('deflate') ||
            (raw.length >= 2 &&
                raw[0] === 0x78 &&
                (raw[1] === 0x01 || raw[1] === 0x9c || raw[1] === 0xda))) {
            return nodeInflateSync ? nodeInflateSync(raw).toString('utf8') : raw.toString('utf8');
        }
        if (enc.includes('br')) {
            return nodeBrotliDecompressSync
                ? nodeBrotliDecompressSync(raw).toString('utf8')
                : raw.toString('utf8');
        }
        return raw.toString('utf8');
    }
    catch {
        return '[unreadable body]';
    }
}
/**
 * Attach recording to one outgoing http/https request. Idempotent: the
 * first caller (http.request wrapper or the prototype end() wrapper)
 * wins, the other skips. Records once, on response end or request error.
 */
function trackRequest(req) {
    if (!req || req[HTTP_TRACKED_KEY])
        return;
    req[HTTP_TRACKED_KEY] = true;
    const fullUrl = httpRequestUrl(req);
    if (isOwnEndpoint(fullUrl) || isFrameworkRequest(fullUrl))
        return;
    const startedAt = Date.now();
    const splitAt = fullUrl.indexOf('?');
    const endpoint = splitAt >= 0 ? fullUrl.slice(0, splitAt) : fullUrl;
    const queryString = splitAt >= 0 ? fullUrl.slice(splitAt + 1) : null;
    const httpMethod = String(req.method || 'GET').toUpperCase();
    let done = false;
    const recordOnce = (record) => {
        if (done)
            return;
        done = true;
        try {
            record();
        }
        catch {
            // ignore recorder errors
        }
    };
    const requestPayload = () => truncateBody(req[HTTP_BODY_KEY] ?? null);
    const accessTokenMasked = () => maskToken(headerValue(req, 'authorization'));
    const cookieNames = () => readCookieNames(headerValue(req, 'cookie'));
    const recordFailure = (errorMessage) => {
        recordOnce(() => {
            addRecord({
                source: 'server',
                httpMethod,
                endpoint,
                queryString,
                statusCode: 'NETWORK_FAILURE',
                elapsedMs: Date.now() - startedAt,
                requestPayload: requestPayload(),
                responseBody: null,
                accessTokenMasked: accessTokenMasked(),
                cookieNames: cookieNames(),
                errorMessage,
            });
        });
    };
    try {
        req.once('response', (res) => {
            // The encoding snapshot (if any) was taken by the http.request
            // wrapper before axios could delete the header; otherwise read the
            // header now — plain http clients leave it alone.
            const encoding = req[HTTP_ENCODING_KEY] ??
                (() => {
                    try {
                        return String(res.headers?.['content-encoding'] || '') || null;
                    }
                    catch {
                        return null;
                    }
                })();
            // Accumulate raw bytes: callers like axios ask for gzip / deflate /
            // brotli, so the bytes on the wire are compressed and must be
            // decoded before they are stored.
            const buffers = [];
            let keptBytes = 0;
            try {
                res.on('data', (piece) => {
                    try {
                        if (keptBytes > MAX_BODY_CHARS + 1024)
                            return;
                        const buf = typeof piece === 'string'
                            ? Buffer.from(piece, 'utf8')
                            : Buffer.isBuffer(piece) || piece instanceof Uint8Array
                                ? Buffer.from(piece)
                                : Buffer.from(String(piece), 'utf8');
                        keptBytes += buf.length;
                        buffers.push(buf);
                    }
                    catch {
                        // ignore unreadable chunk
                    }
                });
            }
            catch {
                // ignore
            }
            res.on('end', () => {
                recordOnce(() => {
                    addRecord({
                        source: 'server',
                        httpMethod,
                        endpoint,
                        queryString,
                        statusCode: res.statusCode,
                        elapsedMs: Date.now() - startedAt,
                        requestPayload: requestPayload(),
                        responseBody: truncateBody(decodeResponseBody(encoding, buffers)),
                        accessTokenMasked: accessTokenMasked(),
                        cookieNames: cookieNames(),
                        errorMessage: null,
                    });
                });
            });
            res.on('error', (err) => {
                recordFailure(err instanceof Error ? err.message : String(err));
            });
        });
    }
    catch {
        // ignore
    }
    try {
        req.once('error', (err) => {
            recordFailure(err instanceof Error ? err.message : String(err));
        });
    }
    catch {
        // ignore
    }
}
/**
 * Wrap http.request / https.request so the response callback runs our
 * code FIRST. follow-redirects (used by axios) calls
 * `nativeProtocol.request(options, callback)` — a property lookup on the
 * shared module object at call time — so this patch applies no matter
 * when axios was loaded. The wrapped callback snapshots the response
 * content-encoding before the original callback runs: axios's http
 * adapter deletes that header from the shared response object (it
 * decompresses the stream itself), so reading it later sees nothing
 * while the tapped bytes are still compressed.
 */
function wrapHttpRequest(originalRequest) {
    return function (...args) {
        const lastIndex = args.length - 1;
        let req;
        if (typeof args[lastIndex] === 'function') {
            const originalCallback = args[lastIndex];
            args[lastIndex] = function (res) {
                try {
                    if (req) {
                        try {
                            req[HTTP_ENCODING_KEY] =
                                String(res.headers?.['content-encoding'] || '') || null;
                        }
                        catch {
                            // ignore
                        }
                    }
                }
                catch {
                    // ignore
                }
                return originalCallback.call(this, res);
            };
        }
        req = originalRequest.apply(this, args);
        try {
            trackRequest(req);
        }
        catch {
            // ignore
        }
        return req;
    };
}
/**
 * Load the Node builtins used by the http-layer capture — lazily, at
 * runtime, only after register() confirmed the Node.js runtime.
 *
 * Why lazy: a static node:http import in this file breaks
 * webpack builds — Next.js compiles instrumentation.ts for the Edge
 * runtime too, and webpack has no plugin for the "node:" scheme
 * (UnhandledSchemeError; verified live with `next dev --webpack`).
 * Turbopack only warns about the same imports, so the failure is
 * invisible in Turbopack apps. Loading here keeps the static module
 * graph free of node: specifiers, so every bundler compiles it.
 *
 * Primary path: process.getBuiltinModule (Node >= 20.16 / >= 22.3).
 * Fallback for older Node: a dynamic import whose specifier lives
 * inside new Function, so bundlers cannot see it at build time — a
 * plain import('node:http') written in source would be statically
 * analysed and fail the Edge compilation the same way. Returns false
 * when neither works; the caller then skips http-layer capture (server
 * fetch is still recorded).
 */
async function loadNodeBuiltins() {
    if (nodeHttp && nodeHttps)
        return true;
    try {
        const getBuiltin = process.getBuiltinModule;
        if (typeof getBuiltin === 'function') {
            const httpMod = process.getBuiltinModule('node:http');
            const httpsMod = process.getBuiltinModule('node:https');
            const zlibMod = process.getBuiltinModule('node:zlib');
            nodeHttp = httpMod;
            nodeHttps = httpsMod;
            nodeGunzipSync = zlibMod.gunzipSync;
            nodeInflateSync = zlibMod.inflateSync;
            nodeBrotliDecompressSync = zlibMod.brotliDecompressSync;
            return true;
        }
    }
    catch {
        // fall through to the dynamic-import fallback
    }
    try {
        const dynImport = new Function('specifier', 'return import(specifier)');
        const [httpMod, httpsMod, zlibMod] = await Promise.all([
            dynImport('node:http'),
            dynImport('node:https'),
            dynImport('node:zlib'),
        ]);
        nodeHttp = httpMod;
        nodeHttps = httpsMod;
        nodeGunzipSync = zlibMod.gunzipSync;
        nodeInflateSync = zlibMod.inflateSync;
        nodeBrotliDecompressSync = zlibMod.brotliDecompressSync;
        return true;
    }
    catch {
        return false;
    }
}
function patchHttpLayer() {
    // (a) http.request / https.request — callback wrapping snapshots the
    // response content-encoding before axios deletes it, and trackRequest
    // marks the request so the prototype patch below skips it.
    for (const mod of [nodeHttp, nodeHttps]) {
        try {
            const m = mod;
            if (m && typeof m.request === 'function' && !m.request[HTTP_REQUEST_PATCHED_KEY]) {
                const wrapped = wrapHttpRequest(m.request);
                wrapped[HTTP_REQUEST_PATCHED_KEY] = true;
                m.request = wrapped;
            }
        }
        catch {
            // ignore
        }
    }
    // (b) ClientRequest prototype — covers http.get/https.get (which call
    // the internal request function, not the patched property), direct
    // ClientRequest use, and anything else that ends a request.
    const proto = nodeHttp.ClientRequest?.prototype;
    if (!proto || proto[HTTP_PATCHED_KEY])
        return;
    proto[HTTP_PATCHED_KEY] = true;
    const originalWrite = proto.write;
    const originalEnd = proto.end;
    function appendBody(req, chunk) {
        try {
            if (chunk == null)
                return;
            if (typeof chunk === 'string') {
                req[HTTP_BODY_KEY] = (req[HTTP_BODY_KEY] || '') + chunk;
            }
            else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
                req[HTTP_BODY_KEY] =
                    (req[HTTP_BODY_KEY] || '') + Buffer.from(chunk).toString('utf8');
            }
            // functions (callbacks) and other end() args are not bodies
        }
        catch {
            // ignore
        }
    }
    proto.write = function (chunk, ...rest) {
        try {
            appendBody(this, chunk);
        }
        catch {
            // ignore
        }
        return originalWrite.apply(this, [chunk, ...rest]);
    };
    proto.end = function (chunk, ...rest) {
        try {
            appendBody(this, chunk);
            // If http.request already tracked this request, this is a no-op.
            trackRequest(this);
        }
        catch {
            // recording must never break the request
        }
        return originalEnd.apply(this, chunk === undefined ? [] : [chunk, ...rest]);
    };
}
/**
 * Install the server fetch wrapper. Kept separate from register() so a
 * missing fetch cannot block the http-layer capture below — axios and
 * raw http calls do not go through fetch.
 */
/**
 * Build the recording wrapper around whichever fetch is current.
 * The wrapper is transparent: it calls the underlying fetch and only
 * clones the response to read its body for the record.
 */
function createWrappedFetch(nativeFetch) {
    const wrappedFetch = async (...fetchArgs) => {
        const requestTarget = fetchArgs[0];
        const requestOptions = fetchArgs[1];
        let fullUrl;
        try {
            fullUrl =
                requestTarget instanceof Request ? requestTarget.url : String(requestTarget);
        }
        catch {
            return nativeFetch(...fetchArgs);
        }
        if (isOwnEndpoint(fullUrl) || isFrameworkRequest(fullUrl))
            return nativeFetch(...fetchArgs);
        const splitAt = fullUrl.indexOf('?');
        const endpoint = splitAt >= 0 ? fullUrl.slice(0, splitAt) : fullUrl;
        const queryString = splitAt >= 0 ? fullUrl.slice(splitAt + 1) : null;
        const httpMethod = requestOptions?.method ??
            (requestTarget instanceof Request ? requestTarget.method : 'GET');
        let accessTokenMasked = null;
        let cookieNames = [];
        try {
            const headerBag = requestTarget instanceof Request
                ? requestTarget.headers
                : new Headers(requestOptions?.headers ?? {});
            accessTokenMasked = maskToken(headerBag.get('authorization'));
            cookieNames = readCookieNames(headerBag.get('cookie'));
        }
        catch {
            // headers unreadable — record without them
        }
        let requestPayload = null;
        try {
            if (typeof requestOptions?.body === 'string')
                requestPayload = requestOptions.body;
            else if (requestOptions?.body)
                requestPayload = '[non-text body]';
        }
        catch {
            requestPayload = null;
        }
        const startedAt = Date.now();
        try {
            const upstreamResponse = await nativeFetch(...fetchArgs);
            let responseBody = null;
            try {
                responseBody = truncateBody(await upstreamResponse.clone().text());
            }
            catch {
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
            }
            catch {
                // recording must never break the response
            }
            return upstreamResponse;
        }
        catch (failure) {
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
            }
            catch {
                // ignore recorder errors
            }
            throw failure;
        }
    };
    preserveFetchMarkers(wrappedFetch, nativeFetch);
    wrappedFetch.__LOGGER_DASHBOARD_WRAPPED__ = true;
    return wrappedFetch;
}
function installFetchWrapper(nativeFetch) {
    const g = globalThis;
    const wrapped = createWrappedFetch(nativeFetch);
    g.__LOGGER_DASHBOARD_NATIVE_FETCH__ = nativeFetch;
    g.__LOGGER_DASHBOARD_WRAPPED_FETCH__ = wrapped;
    g.fetch = wrapped;
}
/**
 * Re-wrap the global fetch if something replaced our wrapper after
 * register() ran. Next.js patches global fetch at server startup, and
 * depending on version/bundler that patch can land AFTER register(),
 * silently dropping the wrapper — the dashboard then still shows
 * "fetch wrapped" (set at register time) while NO server fetch is ever
 * recorded. Healing re-wraps the CURRENT fetch, so Next's own patch
 * underneath keeps working (caching, static-store tracking).
 */
function healFetchWrapper() {
    const g = globalThis;
    try {
        const current = g.fetch;
        if (typeof current !== 'function')
            return false;
        if (current.__LOGGER_DASHBOARD_WRAPPED__)
            return true;
        const wrapped = createWrappedFetch(current);
        g.__LOGGER_DASHBOARD_WRAPPED_FETCH__ = wrapped;
        g.fetch = wrapped;
        const status = g.__LOGGER_DASHBOARD_SERVER_STATUS__;
        if (status)
            status.fetchWrapped = true;
        return true;
    }
    catch {
        return false;
    }
}
export async function register() {
    const g = globalThis;
    // Capture state for the dashboard (and the dev terminal): if this
    // never appears, instrumentation.ts is not loading in this app at
    // all — e.g. Pages Router (no instrumentation hook) or Next 15
    // without experimental.instrumentationHook.
    const status = {
        runtime: process.env.NEXT_RUNTIME ?? null,
        fetchWrapped: false,
        httpLayer: 'not-started',
        httpLayerReason: null,
        nodeVersion: typeof process !== 'undefined' ? process.version : null,
    };
    g.__LOGGER_DASHBOARD_SERVER_STATUS__ = status;
    // Only skip when the runtime is EXPLICITLY not Node.js (Edge).
    // NEXT_RUNTIME can be unset in older setups; an unset value in a
    // Node process must not disable capture.
    if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') {
        try {
            console.log('[next-logger-dashboard] server capture off: runtime is ' +
                process.env.NEXT_RUNTIME +
                ' (capture runs in the Node.js runtime only)');
        }
        catch {
            // ignore
        }
        return;
    }
    if (g.__LOGGER_DASHBOARD_PATCHED__)
        return;
    g.__LOGGER_DASHBOARD_PATCHED__ = true;
    const nativeFetch = g.fetch;
    if (typeof nativeFetch === 'function') {
        try {
            installFetchWrapper(nativeFetch);
            status.fetchWrapped = true;
        }
        catch {
            // ignore — fetch stays unwrapped, http layer still runs
        }
    }
    // The wrapper can be replaced after register() (see healFetchWrapper).
    // Re-wrap whenever that happens: on a short unref'd timer so app
    // fetches are captured even before the dashboard is ever opened, and
    // on demand from the records route / any recorded request.
    try {
        g.__LOGGER_DASHBOARD_HEAL_FETCH__ = healFetchWrapper;
        if (!g.__LOGGER_DASHBOARD_HEAL_TIMER__) {
            const timer = setInterval(() => {
                try {
                    healFetchWrapper();
                }
                catch {
                    // ignore
                }
            }, 2000);
            timer.unref?.();
            g.__LOGGER_DASHBOARD_HEAL_TIMER__ = timer;
        }
    }
    catch {
        // ignore — on-demand healing from the records route still applies
    }
    // Server-side axios / raw http(s): captured at the Node http layer.
    // The builtins load lazily (no static node: imports in this file —
    // webpack cannot compile those for the Edge runtime). If they cannot
    // be loaded, http-layer capture is skipped and server fetch is still
    // recorded.
    try {
        if (await loadNodeBuiltins()) {
            patchHttpLayer();
            status.httpLayer = 'active';
        }
        else {
            status.httpLayer = 'unavailable';
            status.httpLayerReason =
                'Node builtins could not be loaded (needs Node >= 20.16 / >= 22.3, or a working dynamic import)';
        }
    }
    catch (err) {
        status.httpLayer = 'unavailable';
        status.httpLayerReason = err instanceof Error ? err.message : String(err);
    }
    try {
        console.log('[next-logger-dashboard] server capture: fetch ' +
            (status.fetchWrapped ? 'wrapped' : 'not wrapped') +
            ', http layer ' + status.httpLayer +
            (status.httpLayerReason ? ' (' + status.httpLayerReason + ')' : '') +
            ', Node ' + (status.nodeVersion || 'unknown'));
    }
    catch {
        // ignore
    }
}
