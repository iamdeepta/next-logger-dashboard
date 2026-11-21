/**
 * next-logger-dashboard — records endpoint (Pages Router).
 * GET returns the in-memory records (newest first); DELETE clears them.
 * When LOGGER_DASHBOARD_KEY is set, both require the matching
 * x-logger-key header.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { clearRecords, getRecords, getServerStatus, healFetchWrapperIfNeeded } from '../../../lib/logger-dashboard-store';

function keyOk(req: NextApiRequest): boolean {
  const expected = process.env.LOGGER_DASHBOARD_KEY;
  if (!expected) return true;
  const supplied = req.headers['x-logger-key'];
  const suppliedKey = Array.isArray(supplied) ? supplied[0] : supplied;
  return suppliedKey === expected;
}

export default function handler(req: NextApiRequest, res: NextApiResponse): void {
  if (!keyOk(req)) {
    res.status(403).json({ error: 'Access key required' });
    return;
  }
  if (req.method === 'GET') {
    // Re-wrap the server fetch wrapper if it was replaced after startup,
    // before reading records or the (live) capture status.
    healFetchWrapperIfNeeded();
    const status = getServerStatus();
    if (status) res.setHeader('x-logger-server-status', JSON.stringify(status));
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
