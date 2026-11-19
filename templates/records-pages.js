import { clearRecords, getRecords, getServerStatus } from '../../../lib/logger-dashboard-store';
function keyOk(req) {
    const expected = process.env.LOGGER_DASHBOARD_KEY;
    if (!expected)
        return true;
    const supplied = req.headers['x-logger-key'];
    const suppliedKey = Array.isArray(supplied) ? supplied[0] : supplied;
    return suppliedKey === expected;
}
export default function handler(req, res) {
    if (!keyOk(req)) {
        res.status(403).json({ error: 'Access key required' });
        return;
    }
    if (req.method === 'GET') {
        const status = getServerStatus();
        if (status)
            res.setHeader('x-logger-server-status', JSON.stringify(status));
        res.status(200).json(getRecords());
        return;
    }
    if (req.method === 'DELETE') {
        clearRecords();
        res.status(200).json({ ok: true });
        return;
    }
    res.setHeader('Allow', 'GET, DELETE');
    res.status(405).json({ error: 'Method not allowed' });
}
