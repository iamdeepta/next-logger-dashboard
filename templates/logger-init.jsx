'use client';
/**
 * next-logger-dashboard — client boundary for the browser logger.
 *
 * A side-effect-only import of the logger from a Server Component layout
 * would only ever run on the server, so the browser patching would never
 * install. Rendering this (empty) client component is what pulls the
 * logger module into the browser bundle, where it wraps fetch/XHR and
 * axios. It renders nothing.
 */
import './logger-dashboard';
export default function LoggerDashboardInit() {
    return null;
}
