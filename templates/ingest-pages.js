import { addRecord } from '../../../lib/logger-dashboard-store';
const MAX_PAYLOAD_CHARS = 262144;
function keyOk(req) {
    const expected = process.env.LOGGER_DASHBOARD_KEY;
    if (!expected)
        return true;
    const supplied = req.headers['x-logger-key'];
    const suppliedKey = Array.isArray(supplied) ? supplied[0] : supplied;
    return suppliedKey === expected;
}
export default function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    if (!keyOk(req)) {
        res.status(403).json({ error: 'Access key required' });
        return;
    }
    const body = req.body;
    if (!body || typeof body === 'string') {
        res.status(400).json({ error: 'JSON body required' });
        return;
    }
    if (JSON.stringify(body).length > MAX_PAYLOAD_CHARS) {
        res.status(413).json({ error: 'Payload too large' });
        return;
    }
    if (typeof body.endpoint !== 'string' || typeof body.httpMethod !== 'string') {
        res.status(400).json({ error: 'Record needs endpoint and httpMethod' });
        return;
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
    res.status(200).json({ ok: true, id: record.id });
}
