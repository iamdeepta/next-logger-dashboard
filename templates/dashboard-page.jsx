'use client';
/**
 * next-logger-dashboard — dashboard page.
 *
 * Self-contained: all styles are inline (nld-* classes), no Tailwind or
 * other setup required. Polls /api/logger-dashboard/records every 2s.
 * The record shape is defined locally so this page never imports the
 * server-only store module into the client bundle.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
const CSS = `
.nld-wrap { font-family: ui-sans-system, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #0b0f14; color: #e6edf3; min-height: 100vh; padding: 20px; box-sizing: border-box; }
.nld-wrap * { box-sizing: border-box; }
.nld-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.nld-title { font-size: 22px; font-weight: 700; margin: 0; }
.nld-sub { color: #8b949e; font-size: 13px; margin: 0 0 16px; }
.nld-live { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #3fb950; }
.nld-dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; animation: nld-pulse 1.6s infinite; }
.nld-dot-paused { background: #8b949e; animation: none; }
@keyframes nld-pulse { 0% { opacity: 1; } 50% { opacity: 0.35; } 100% { opacity: 1; } }
.nld-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 14px; }
.nld-input, .nld-select { background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 8px 10px; font-size: 13px; outline: none; }
.nld-input:focus, .nld-select:focus { border-color: #1f6feb; }
.nld-input { min-width: 220px; flex: 1; }
.nld-btn { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 8px 12px; font-size: 13px; cursor: pointer; }
.nld-btn:hover { background: #30363d; }
.nld-btn-danger:hover { border-color: #f85149; color: #ff7b72; }
.nld-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 14px; align-items: start; }
@media (max-width: 900px) { .nld-grid { grid-template-columns: 1fr; } }
.nld-list { display: flex; flex-direction: column; gap: 8px; }
.nld-row { text-align: left; width: 100%; background: #161b22; color: #e6edf3; border: 1px solid #30363d; border-radius: 10px; padding: 10px 12px; cursor: pointer; font: inherit; }
.nld-row:hover { border-color: #1f6feb; }
.nld-row-active { border-color: #1f6feb; background: #0d2137; }
.nld-row-top { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
.nld-endpoint { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
.nld-meta { color: #8b949e; font-size: 12px; }
.nld-badge { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
.nld-badge-get { background: #12281e; color: #3fb950; }
.nld-badge-post { background: #241a08; color: #d29922; }
.nld-badge-put { background: #0d2137; color: #58a6ff; }
.nld-badge-delete { background: #2c1215; color: #ff7b72; }
.nld-badge-other { background: #21262d; color: #e6edf3; }
.nld-badge-ok { background: #12281e; color: #3fb950; }
.nld-badge-warn { background: #241a08; color: #d29922; }
.nld-badge-fail { background: #2c1215; color: #ff7b72; }
.nld-badge-src { background: #21262d; color: #8b949e; }
.nld-detail { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 14px; min-height: 200px; }
.nld-detail h3 { margin: 0 0 10px; font-size: 14px; word-break: break-all; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
.nld-kv { display: grid; grid-template-columns: 130px 1fr; gap: 6px 10px; font-size: 13px; margin-bottom: 12px; }
.nld-kv dt { color: #8b949e; }
.nld-kv dd { margin: 0; word-break: break-word; }
.nld-pre { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; max-height: 420px; overflow: auto; white-space: pre-wrap; word-break: break-word; margin: 0; }
.nld-sec { font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #8b949e; margin: 14px 0 6px; }
.nld-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.nld-table th, .nld-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #30363d; vertical-align: top; word-break: break-all; }
.nld-table th { color: #8b949e; font-weight: 600; }
.nld-empty, .nld-error { background: #161b22; border: 1px dashed #30363d; border-radius: 10px; padding: 28px; text-align: center; color: #8b949e; font-size: 14px; }
.nld-error { border-color: #f85149; color: #ff7b72; }
.nld-keyform { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; align-items: center; }
.nld-foot { color: #8b949e; font-size: 12px; margin-top: 16px; }
.nld-count { color: #8b949e; font-size: 13px; }
`;
function statusGroup(status) {
    if (status === 'NETWORK_FAILURE')
        return 'fail';
    if (status >= 200 && status < 300)
        return '2xx';
    if (status >= 300 && status < 400)
        return '3xx';
    if (status >= 400 && status < 500)
        return '4xx';
    if (status >= 500)
        return '5xx';
    return 'fail';
}
function methodBadgeClass(method) {
    const m = method.toUpperCase();
    if (m === 'GET')
        return 'nld-badge nld-badge-get';
    if (m === 'POST')
        return 'nld-badge nld-badge-post';
    if (m === 'PUT' || m === 'PATCH')
        return 'nld-badge nld-badge-put';
    if (m === 'DELETE')
        return 'nld-badge nld-badge-delete';
    return 'nld-badge nld-badge-other';
}
function statusBadgeClass(status) {
    const group = statusGroup(status);
    if (group === '2xx')
        return 'nld-badge nld-badge-ok';
    if (group === '3xx')
        return 'nld-badge nld-badge-warn';
    return 'nld-badge nld-badge-fail';
}
/** Pretty-print JSON bodies; fall back to raw text. */
function prettyBody(body) {
    if (body === null || body === undefined)
        return '';
    const text = String(body);
    try {
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed, null, 2);
    }
    catch {
        return text;
    }
}
function parseQuery(queryString) {
    const pairs = [];
    if (!queryString)
        return pairs;
    try {
        const params = new URLSearchParams(queryString);
        params.forEach((value, key) => {
            pairs.push([key, value]);
        });
    }
    catch {
        // unparseable query string — show nothing
    }
    return pairs;
}
export default function LoggerDashboardPage() {
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [fetchError, setFetchError] = useState('');
    const [query, setQuery] = useState('');
    const [methodFilter, setMethodFilter] = useState('ALL');
    const [statusFilter, setStatusFilter] = useState('ALL');
    const [sourceFilter, setSourceFilter] = useState('ALL');
    const [selected, setSelected] = useState(null);
    const [polling, setPolling] = useState(true);
    const [wrapBody, setWrapBody] = useState(true);
    const [copied, setCopied] = useState(false);
    const [keyRequired, setKeyRequired] = useState(false);
    const [keyInput, setKeyInput] = useState('');
    const keyRef = useRef('');
    useEffect(() => {
        try {
            keyRef.current = window.sessionStorage.getItem('logger-dashboard-key') || '';
        }
        catch {
            keyRef.current = '';
        }
    }, []);
    const load = useCallback(async () => {
        try {
            const headers = {};
            if (keyRef.current)
                headers['x-logger-key'] = keyRef.current;
            const res = await fetch('/api/logger-dashboard/records', { headers });
            if (res.status === 403) {
                setKeyRequired(true);
                setLoading(false);
                return;
            }
            if (!res.ok)
                throw new Error('Records request failed: ' + res.status);
            const data = (await res.json());
            setRecords(Array.isArray(data) ? data : []);
            setFetchError('');
            setKeyRequired(false);
        }
        catch (err) {
            setFetchError(err instanceof Error ? err.message : String(err));
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => {
        load();
        if (!polling)
            return undefined;
        const timer = setInterval(load, 2000);
        return () => clearInterval(timer);
    }, [load, polling]);
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return records.filter((r) => {
            if (methodFilter !== 'ALL' && r.httpMethod.toUpperCase() !== methodFilter)
                return false;
            if (statusFilter !== 'ALL' && statusGroup(r.statusCode) !== statusFilter)
                return false;
            if (sourceFilter !== 'ALL' && r.source !== sourceFilter)
                return false;
            if (!q)
                return true;
            const hay = [
                r.endpoint,
                r.queryString || '',
                r.httpMethod,
                String(r.statusCode),
                r.responseBody || '',
                r.requestPayload || '',
                r.errorMessage || '',
            ]
                .join(' ')
                .toLowerCase();
            return hay.includes(q);
        });
    }, [records, query, methodFilter, statusFilter, sourceFilter]);
    const queryPairs = useMemo(() => (selected ? parseQuery(selected.queryString) : []), [selected]);
    const onClear = async (e) => {
        e.preventDefault();
        try {
            const headers = {};
            if (keyRef.current)
                headers['x-logger-key'] = keyRef.current;
            await fetch('/api/logger-dashboard/records', { method: 'DELETE', headers });
            setSelected(null);
            load();
        }
        catch {
            // ignore — next poll refreshes the list
        }
    };
    const onKeySubmit = async (e) => {
        e.preventDefault();
        keyRef.current = keyInput.trim();
        try {
            window.sessionStorage.setItem('logger-dashboard-key', keyRef.current);
        }
        catch {
            // private mode etc. — key still works for this session
        }
        setKeyRequired(false);
        setLoading(true);
        load();
    };
    const onCopy = async () => {
        if (!selected)
            return;
        try {
            const text = JSON.stringify(selected, null, 2);
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            }
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
        catch {
            // clipboard unavailable
        }
    };
    return (<div className="nld-wrap">
      <style>{CSS}</style>
      <div className="nld-head">
        <h1 className="nld-title">API Logger Dashboard</h1>
        <span className="nld-live">
          <span className={polling ? 'nld-dot' : 'nld-dot nld-dot-paused'}/>
          {polling ? 'Live' : 'Paused'}
        </span>
        <span className="nld-count">
          {records.length} record{records.length === 1 ? '' : 's'} (in-memory, newest first, max 200)
        </span>
      </div>
      <p className="nld-sub">
        Server fetch, browser fetch/XHR and axios calls, as they happen. Tokens are masked and cookie values are never stored.
      </p>

      {keyRequired && (<form className="nld-keyform" onSubmit={onKeySubmit}>
          <span>This dashboard is protected by an access key.</span>
          <input className="nld-input" type="password" placeholder="Access key (LOGGER_DASHBOARD_KEY)" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}/>
          <button className="nld-btn" type="submit">
            Unlock
          </button>
        </form>)}

      <div className="nld-toolbar">
        <input className="nld-input" type="search" placeholder="Search endpoint, status, body, error…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search records"/>
        <select className="nld-select" value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)} aria-label="Filter by method">
          <option value="ALL">All methods</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
        <select className="nld-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
          <option value="ALL">All statuses</option>
          <option value="2xx">2xx</option>
          <option value="3xx">3xx</option>
          <option value="4xx">4xx</option>
          <option value="5xx">5xx</option>
          <option value="fail">Failures</option>
        </select>
        <select className="nld-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="Filter by source">
          <option value="ALL">Server + client</option>
          <option value="server">Server only</option>
          <option value="client">Client only</option>
        </select>
        <button className="nld-btn" type="button" onClick={() => setPolling((p) => !p)}>
          {polling ? 'Pause' : 'Resume'}
        </button>
        <button className="nld-btn" type="button" onClick={() => load()}>
          Refresh
        </button>
        <button className="nld-btn nld-btn-danger" type="button" onClick={onClear}>
          Clear logs
        </button>
      </div>

      {fetchError && !keyRequired && <div className="nld-error">{fetchError}</div>}

      {!fetchError && !keyRequired && loading && records.length === 0 && (<div className="nld-empty">Loading records…</div>)}

      {!fetchError && !keyRequired && !loading && filtered.length === 0 && (<div className="nld-empty">
          {records.length === 0
                ? 'No API calls recorded yet. Use the app — server fetches, browser calls and axios requests will appear here.'
                : 'No records match the current filters.'}
        </div>)}

      {!keyRequired && filtered.length > 0 && (<div className="nld-grid">
          <div className="nld-list">
            {filtered.map((r) => (<button key={r.id} type="button" className={selected && selected.id === r.id ? 'nld-row nld-row-active' : 'nld-row'} onClick={() => setSelected(r)}>
                <span className="nld-row-top">
                  <span className={methodBadgeClass(r.httpMethod)}>{r.httpMethod}</span>
                  <span className={statusBadgeClass(r.statusCode)}>{String(r.statusCode)}</span>
                  <span className="nld-badge nld-badge-src">{r.source}</span>
                  <span className="nld-meta">{r.elapsedMs} ms</span>
                </span>
                <span className="nld-endpoint">{r.endpoint}</span>
                <br />
                <span className="nld-meta">{new Date(r.recordedAt).toLocaleTimeString()}</span>
              </button>))}
          </div>

          <div className="nld-detail">
            {selected ? (<>
                <h3>
                  {selected.httpMethod} {selected.endpoint}
                </h3>
                <dl className="nld-kv">
                  <dt>Status</dt>
                  <dd>{String(selected.statusCode)}</dd>
                  <dt>Duration</dt>
                  <dd>{selected.elapsedMs} ms</dd>
                  <dt>Source</dt>
                  <dd>{selected.source}</dd>
                  <dt>Recorded</dt>
                  <dd>{new Date(selected.recordedAt).toLocaleString()}</dd>
                  {selected.accessTokenMasked && (<>
                      <dt>Authorization</dt>
                      <dd>{selected.accessTokenMasked}</dd>
                    </>)}
                  {selected.cookieNames.length > 0 && (<>
                      <dt>Cookies</dt>
                      <dd>{selected.cookieNames.join(', ')} (names only)</dd>
                    </>)}
                  {selected.errorMessage && (<>
                      <dt>Error</dt>
                      <dd>{selected.errorMessage}</dd>
                    </>)}
                </dl>

                {queryPairs.length > 0 && (<>
                    <div className="nld-sec">Query parameters</div>
                    <table className="nld-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {queryPairs.map(([k, v]) => (<tr key={k + '=' + v}>
                            <td>{k}</td>
                            <td>{v}</td>
                          </tr>))}
                      </tbody>
                    </table>
                  </>)}

                {selected.requestPayload && (<>
                    <div className="nld-sec">Request payload</div>
                    <pre className="nld-pre">{prettyBody(selected.requestPayload)}</pre>
                  </>)}

                <div className="nld-sec">Response body</div>
                <pre className="nld-pre" style={wrapBody ? undefined : { whiteSpace: 'pre', overflowX: 'auto' }}>
                  {selected.responseBody ? prettyBody(selected.responseBody) : '(empty)'}
                </pre>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button className="nld-btn" type="button" onClick={() => setWrapBody((v) => !v)}>
                    {wrapBody ? 'No wrap' : 'Wrap'}
                  </button>
                  <button className="nld-btn" type="button" onClick={onCopy}>
                    {copied ? 'Copied!' : 'Copy record JSON'}
                  </button>
                </div>
              </>) : (<div className="nld-empty">Select a record to inspect it.</div>)}
          </div>
        </div>)}

      <p className="nld-foot">
        Records live in server memory only and reset on restart. Nothing leaves the
        server except through this same-origin dashboard.
      </p>
    </div>);
}
