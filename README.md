# next-logger-dashboard

Zero-config API logger dashboard for **Next.js** (App Router & Pages Router).

See every API call your app makes — server-side `fetch`, browser `fetch` /
`XMLHttpRequest`, and axios — in one dashboard: method, URL, query
parameters, status, duration, request/response bodies. Tokens are masked
and cookie values are never stored. Next.js internal requests (page
navigation RSC payloads, `/_next/*`) are not recorded — only real API
calls appear.

## What it captures

- **Server-side `fetch`** via `instrumentation.ts` (Node.js runtime): every
  server call is recorded with timing and bodies, without editing app code.
- **Server-side axios** (any instance, including `axios.create()`) and
  raw `http`/`https` calls, captured at the Node.js http layer by the
  same instrumentation file — no extra HTTP round-trip, and no axios
  interceptors (bundlers give the instrumentation module and the app
  different copies of the axios module, so interceptors attached in
  instrumentation never see the app's calls).
- **Browser `fetch` / `XMLHttpRequest`** via the logger imported in the
  root layout. Completed calls are POSTed as finished records to an
  ingest endpoint — the request itself is **never re-executed**, so a
  POST/PUT/DELETE from the browser runs exactly once. Axios calls are
  captured by the same patching (axios uses the XHR/fetch adapters in
  the browser), so they are recorded once, not twice.

Records live in server memory only (newest first, max 200) and reset on
restart. Nothing leaves the server except through the same-origin
dashboard.

## Setup: automatic or manual — your choice

```bash
npm install next-logger-dashboard
```

Installing only prints a hint (npm install scripts cannot ask questions).
Then choose:

```bash
npx next-logger-dashboard setup            # ask: automatic or manual
npx next-logger-dashboard setup --auto     # scaffold without asking
npx next-logger-dashboard setup --manual   # print the steps, write nothing
npx next-logger-dashboard setup --dry-run  # preview what --auto would do
```

Automatic setup creates, **without ever overwriting an existing file**:

- `app/api/logger-dashboard/records/route.ts` — list (GET) + clear (DELETE)
- `app/api/logger-dashboard/ingest/route.ts` — browser record intake (POST)
- `app/logger-dashboard/page.tsx` — the dashboard UI (self-contained styles,
  no Tailwind needed)
- `instrumentation.ts` — server fetch + axios capture
- `lib/logger-dashboard.ts` — browser capture
- `lib/logger-dashboard-init.tsx` — client component that renders nothing;
  rendering it in the layout is what runs the browser logger in the
  browser (a side-effect-only import from a Server Component would only
  run on the server)
- `lib/logger-dashboard-store.ts` — the in-memory store (server only)

(Pages Router projects get `pages/api/logger-dashboard/*` and
`pages/logger-dashboard.tsx` instead. `src/` layouts, TypeScript and
JavaScript projects are all detected. The logger import is inserted after
`'use client'` / `'use server'` directives so they keep working.)

Then start the dev server and open:

```
http://localhost:3000/logger-dashboard
```

Upgrading to 0.1.3: the dashboard, browser logger, record store,
instrumentation and records route changed. After
`npm install next-logger-dashboard@latest`, delete the scaffolded
copies that changed — `instrumentation.ts` (project root or `src/`),
`lib/logger-dashboard.ts`, `lib/logger-dashboard-store.ts`, the
`logger-dashboard` page, and the `records` route — and run
`npx next-logger-dashboard setup --auto` again; it recreates them from
the new templates. Your other scaffolded files are unchanged and are
kept as-is.

The dashboard loads once and refreshes only when Refresh is clicked
(no live polling). It offers method/status/source filters, text search,
a detail view (query table, payloads, masked token, cookie names),
copy-as-JSON, and one-click clear. The left (list) and right (detail)
panes scroll independently. A status line shows whether server capture
is active.

If the dashboard shows "Server capture: not detected", the
instrumentation file is not loading in the app: check that
`instrumentation.ts` is at the project root (or `src/`) and that the
app uses the App Router — the Pages Router has no instrumentation
hook, so server capture cannot run there. Next 15 needs
`experimental.instrumentationHook: true` in `next.config`.

## Access key (optional)

By default the records endpoint is open in development. To protect it in
preview/staging, set the same value in both variables:

```env
LOGGER_DASHBOARD_KEY=your_secret_passphrase
NEXT_PUBLIC_LOGGER_DASHBOARD_KEY=your_secret_passphrase
```

With the key set, the records/ingest endpoints require the matching
`x-logger-key` header. The dashboard prompts for the key (kept in
session storage) and the browser logger sends the public variable.

## Uninstall

`npm uninstall` alone does **not** remove the scaffolded files — npm does
not run uninstall hooks. Run the cleanup command (it works before or
after uninstalling; afterwards `npx` fetches the package to run it):

```bash
npx next-logger-dashboard uninstall            # remove scaffolded files
npx next-logger-dashboard uninstall --dry-run  # preview what would go
```

It deletes only files whose contents still match the installed templates
(line-ending differences don't count). A file you edited is left untouched
and reported, and the layout file itself is always kept — only the logger
import line is removed.

## How it differs from a proxy design

An earlier generation of tools forwarded browser calls through a server
proxy that re-executed them — doubling mutating requests and letting the
server fetch arbitrary URLs. This package does the opposite: the browser
records the finished call (status + body included) and the ingest
endpoint only validates and stores it. No CORS configuration is needed
(everything is same-origin) and `next.config` is never touched.

## License

MIT
