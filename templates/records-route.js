/**
 * next-logger-dashboard — records endpoint (App Router).
 * GET returns the in-memory records (newest first); DELETE clears them.
 * When LOGGER_DASHBOARD_KEY is set, both require the matching
 * x-logger-key header. The dashboard UI prompts for the key when needed.
 */
import { clearRecords, getRecords, getServerStatus, healFetchWrapperIfNeeded } from '../../../../lib/logger-dashboard-store';
function keyOk(request) {
    const expected = process.env.LOGGER_DASHBOARD_KEY;
    if (!expected)
        return true;
    return request.headers.get('x-logger-key') === expected;
}
export async function GET(request) {
    if (!keyOk(request)) {
        return Response.json({ error: 'Access key required' }, { status: 403 });
    }
    // Re-wrap the server fetch wrapper if it was replaced after startup,
    // before reading records or the (live) capture status.
    healFetchWrapperIfNeeded();
    const res = Response.json(getRecords());
    const status = getServerStatus();
    if (status)
        res.headers.set('x-logger-server-status', JSON.stringify(status));
    return res;
}
export async function DELETE(request) {
    if (!keyOk(request)) {
        return Response.json({ error: 'Access key required' }, { status: 403 });
    }
    clearRecords();
    return Response.json({ ok: true });
}
