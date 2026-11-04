/**
 * next-logger-dashboard — ingest endpoint (App Router).
 * Accepts one finished record from the browser logger and stores it.
 * It never executes the described request — it only stores the record,
 * so client calls cannot run twice and arbitrary URLs cannot be fetched.
 * When LOGGER_DASHBOARD_KEY is set, the matching x-logger-key header is
 * required (browsers send NEXT_PUBLIC_LOGGER_DASHBOARD_KEY).
 */
import { addRecord } from '../../../../lib/logger-dashboard-store';
const MAX_PAYLOAD_CHARS = 262144;
function keyOk(request) {
    const expected = process.env.LOGGER_DASHBOARD_KEY;
    if (!expected)
        return true;
    return request.headers.get('x-logger-key') === expected;
}
export async function POST(request) {
    if (!keyOk(request)) {
        return Response.json({ error: 'Access key required' }, { status: 403 });
    }
    let text;
    try {
        text = await request.text();
    }
    catch {
        return Response.json({ error: 'Unreadable body' }, { status: 400 });
    }
    if (text.length > MAX_PAYLOAD_CHARS) {
        return Response.json({ error: 'Payload too large' }, { status: 413 });
    }
    let body;
    try {
        body = JSON.parse(text || '{}');
    }
    catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!body || typeof body.endpoint !== 'string' || typeof body.httpMethod !== 'string') {
        return Response.json({ error: 'Record needs endpoint and httpMethod' }, { status: 400 });
    }
    const record = addRecord({
        source: 'client',
        httpMethod: body.httpMethod,
        endpoint: body.endpoint,
        queryString: typeof body.queryString === 'string' ? body.queryString : null,
        statusCode: body.statusCode ?? 'NETWORK_FAILURE',
        elapsedMs: typeof body.elapsedMs === 'number' ? body.elapsedMs : 0,
        requestPayload: typeof body.requestPayload === 'string' ? body.requestPayload : null,
        responseBody: typeof body.responseBody === 'string' ? body.responseBody : null,
        accessTokenMasked: typeof body.accessTokenMasked === 'string' ? body.accessTokenMasked : null,
        cookieNames: Array.isArray(body.cookieNames) ? body.cookieNames : [],
        errorMessage: typeof body.errorMessage === 'string' ? body.errorMessage : null,
    });
    return Response.json({ ok: true, id: record.id });
}
