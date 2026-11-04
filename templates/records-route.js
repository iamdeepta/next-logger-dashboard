/**
 * next-logger-dashboard — records endpoint (App Router).
 * GET returns the in-memory records (newest first); DELETE clears them.
 * When LOGGER_DASHBOARD_KEY is set, both require the matching
 * x-logger-key header. The dashboard UI prompts for the key when needed.
 */
import { clearRecords, getRecords } from '../../../../lib/logger-dashboard-store';
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
    return Response.json(getRecords());
}
export async function DELETE(request) {
    if (!keyOk(request)) {
        return Response.json({ error: 'Access key required' }, { status: 403 });
    }
    clearRecords();
    return Response.json({ ok: true });
}
