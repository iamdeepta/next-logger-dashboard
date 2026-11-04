#!/usr/bin/env node
/**
 * next-logger-dashboard — setup / uninstall CLI.
 *
 *   npx next-logger-dashboard setup            # ask (automatic / manual)
 *   npx next-logger-dashboard setup --auto     # scaffold without asking
 *   npx next-logger-dashboard setup --manual   # print manual instructions only
 *   npx next-logger-dashboard setup --dry-run  # show what would change
 *   npx next-logger-dashboard uninstall        # remove scaffolded files
 *
 * The postinstall hook only prints a hint: npm lifecycle scripts never get
 * terminal input, so install-time prompting cannot work. The uninstall
 * hook is best-effort for the same reason npm does not run uninstall
 * hooks — `npx next-logger-dashboard uninstall` is the cleanup path.
 *
 * Safety rules (carried over from real-world use):
 * - Never overwrite an existing file. Conflicts prompt (interactive) or
 *   keep the existing file (non-interactive).
 * - Uninstall removes a file only when its contents still match the
 *   template (line endings normalised); edited files are kept + reported.
 * - The layout file itself is always kept; only the logger import line
 *   is stripped from it.
 * - Nothing is written when run inside this package's own repo.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'next-logger-dashboard';
const STORE_FILE = 'logger-dashboard-store';
const LOGGER_FILE = 'logger-dashboard';

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the host project root: INIT_CWD (npm/pnpm) first, then the parent of node_modules. */
function resolveProjectRoot(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const initCwd = process.env.INIT_CWD;
  if (initCwd) return path.resolve(initCwd);
  // dist/cli.js -> package dir -> node_modules -> project root
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const parts = dir.split(path.sep);
  const nmIndex = parts.lastIndexOf('node_modules');
  if (nmIndex > 0) return parts.slice(0, nmIndex).join(path.sep) || path.sep;
  return process.cwd();
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

interface ProjectShape {
  root: string;
  base: string; // root, or root/src when a src/ folder exists
  isTypeScript: boolean;
  router: 'app' | 'pages';
}

async function detectShape(root: string): Promise<ProjectShape> {
  const hasSrc = await exists(path.join(root, 'src'));
  const base = hasSrc ? path.join(root, 'src') : root;
  const hasApp = await exists(path.join(base, 'app'));
  const hasPages = await exists(path.join(base, 'pages'));
  const isTypeScript = await exists(path.join(root, 'tsconfig.json'));
  return { root, base, isTypeScript, router: hasApp ? 'app' : hasPages ? 'pages' : 'app' };
}

function extFor(shape: ProjectShape, kind: 'code' | 'component'): string {
  if (!shape.isTypeScript) return kind === 'component' ? 'jsx' : 'js';
  return kind === 'component' ? 'tsx' : 'ts';
}

interface FilePlan {
  template: string;
  target: string;
  description: string;
}

function planFiles(shape: ProjectShape): FilePlan[] {
  const code = extFor(shape, 'code');
  const comp = extFor(shape, 'component');
  const lib = path.join(shape.base, 'lib');
  const plans: FilePlan[] = [
    {
      template: `${STORE_FILE}.${code}`,
      target: path.join(lib, `${STORE_FILE}.${code}`),
      description: `lib/${STORE_FILE}.${code} (in-memory record store, server only)`,
    },
    {
      template: `instrumentation.${code}`,
      target: path.join(shape.base, `instrumentation.${code}`),
      description: `instrumentation.${code} (server fetch + axios capture)`,
    },
    {
      template: `${LOGGER_FILE}.${code}`,
      target: path.join(lib, `${LOGGER_FILE}.${code}`),
      description: `lib/${LOGGER_FILE}.${code} (browser fetch/XHR/axios capture)`,
    },
  ];
  if (shape.router === 'app') {
    plans.push(
      {
        template: `records-route.${code}`,
        target: path.join(shape.base, 'app', 'api', 'logger-dashboard', 'records', `route.${code}`),
        description: `app/api/logger-dashboard/records/route.${code} (list + clear)`,
      },
      {
        template: `ingest-route.${code}`,
        target: path.join(shape.base, 'app', 'api', 'logger-dashboard', 'ingest', `route.${code}`),
        description: `app/api/logger-dashboard/ingest/route.${code} (browser record intake)`,
      },
      {
        template: `dashboard-page.${comp}`,
        target: path.join(shape.base, 'app', 'logger-dashboard', `page.${comp}`),
        description: `app/logger-dashboard/page.${comp} (dashboard UI)`,
      },
      {
        template: `logger-init.${comp}`,
        target: path.join(lib, `logger-dashboard-init.${comp}`),
        description: `lib/logger-dashboard-init.${comp} (client boundary for the browser logger)`,
      },
    );
  } else {
    plans.push(
      {
        template: `records-pages.${code}`,
        target: path.join(shape.base, 'pages', 'api', 'logger-dashboard', `records.${code}`),
        description: `pages/api/logger-dashboard/records.${code} (list + clear)`,
      },
      {
        template: `ingest-pages.${code}`,
        target: path.join(shape.base, 'pages', 'api', 'logger-dashboard', `ingest.${code}`),
        description: `pages/api/logger-dashboard/ingest.${code} (browser record intake)`,
      },
      {
        template: `dashboard-page.${comp}`,
        target: path.join(shape.base, 'pages', `logger-dashboard.${comp}`),
        description: `pages/logger-dashboard.${comp} (dashboard UI)`,
      },
    );
  }
  return plans;
}

function templatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');
}

async function readTemplate(name: string): Promise<string> {
  return fs.readFile(path.join(templatesDir(), name), 'utf8');
}

type Choice = 'auto' | 'manual';

/** Ask the user to choose. Resolves 'manual' on timeout, EOF or any unclear answer. */
function askChoice(timeoutMs: number | null): Promise<Choice> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return Promise.resolve('manual');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<Choice>((resolve) => {
    let settled = false;
    const settle = (choice: Choice): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(choice);
    };
    const timer =
      timeoutMs === null ? undefined : setTimeout(() => settle('manual'), timeoutMs);
    rl.question(
      `\n${PACKAGE_NAME}: how do you want to set up the logger dashboard?\n` +
        '  1) Automatic — create the route files, dashboard page and logger import\n' +
        '  2) Manual — print the steps and add the files yourself (default)\n' +
        'Choose 1 or 2 (default 2): ',
      (answer) => {
        const a = answer.trim().toLowerCase();
        settle(a === '1' || a === 'auto' || a === 'automatic' || a === 'y' || a === 'yes' ? 'auto' : 'manual');
      },
    );
    rl.on('close', () => settle('manual'));
  });
}

/**
 * Insert an import line after leading 'use client' / 'use server'
 * directives and comments, so directives keep working.
 */
function insertImportAfterDirectives(source: string, importLine: string): string {
  const lines = source.split('\n');
  let i = 0;
  let inBlockComment = false;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      i += 1;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      i += 1;
      continue;
    }
    if (
      trimmed === '' ||
      trimmed.startsWith('//') ||
      /^['"]use (client|server)['"];?$/.test(trimmed)
    ) {
      i += 1;
      continue;
    }
    break;
  }
  lines.splice(i, 0, importLine);
  return lines.join('\n');
}

const LAYOUT_CANDIDATES = [
  ['app', 'layout'],
  ['pages', '_app'],
];

async function findLayout(shape: ProjectShape): Promise<string | null> {
  for (const [dir, name] of LAYOUT_CANDIDATES) {
    for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
      const candidate = path.join(shape.base, dir, `${name}.${ext}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

function loggerImportFor(layoutFile: string, loggerFile: string): string {
  const rel = path
    .relative(path.dirname(layoutFile), loggerFile)
    .split(path.sep)
    .join('/')
    .replace(/\.(ts|tsx|js|jsx)$/, '');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  return `import '${spec}';`;
}

function initImportFor(layoutFile: string, initFile: string): string {
  const rel = path
    .relative(path.dirname(layoutFile), initFile)
    .split(path.sep)
    .join('/')
    .replace(/\.(ts|tsx|js|jsx)$/, '');
  const spec = rel.startsWith('.') ? rel : `./${rel}`;
  return `import LoggerDashboardInit from '${spec}';`;
}

/**
 * Insert `<LoggerDashboardInit />` right after the opening <body> tag.
 * Returns null when no <body> tag is found.
 */
function insertInitElement(source: string): string | null {
  const match = /<body(\s[^>]*)?>/.exec(source);
  if (!match) return null;
  const insertAt = match.index + match[0].length;
  const indent = '  ';
  return source.slice(0, insertAt) + `\n${indent}<LoggerDashboardInit />` + source.slice(insertAt);
}

function manualStepsText(shape: ProjectShape, layoutFile: string | null): string {
  const plans = planFiles(shape);
  const lines = [
    `${PACKAGE_NAME} — manual setup (no files were written):`,
    '',
    '1. Copy these template files from node_modules/next-logger-dashboard/templates/ into your project:',
  ];
  for (const plan of plans) {
    lines.push(`   - ${plan.template} -> ${path.relative(shape.root, plan.target)}`);
  }
  lines.push(
    '',
    shape.router === 'pages'
      ? '2. Import the browser logger once, for its side effects, in pages/_app:'
      : '2. Render the logger init component inside <body> in your root layout',
    shape.router === 'pages'
      ? `   (${layoutFile ? path.relative(shape.root, layoutFile) : 'pages/_app.tsx'}):`
      : `   (${layoutFile ? path.relative(shape.root, layoutFile) : 'app/layout.tsx'}):`,
  );
  if (shape.router === 'pages') {
    lines.push(
      `   ${loggerImportFor(
        layoutFile ?? path.join(shape.base, 'pages', '_app.tsx'),
        path.join(shape.base, 'lib', `${LOGGER_FILE}.${extFor(shape, 'code')}`),
      )}`,
    );
  } else {
    lines.push(
      `   ${initImportFor(
        layoutFile ?? path.join(shape.base, 'app', 'layout.tsx'),
        path.join(shape.base, 'lib', `logger-dashboard-init.${extFor(shape, 'component')}`),
      )}`,
      '   and add <LoggerDashboardInit /> inside the <body> tag.',
    );
  }
  lines.push(
    '3. Start the dev server and open /logger-dashboard.',
    '',
    'Optional: set LOGGER_DASHBOARD_KEY in .env.local to protect the records',
    'endpoint (browsers send NEXT_PUBLIC_LOGGER_DASHBOARD_KEY with the same value).',
  );
  return lines.join('\n');
}

interface ScaffoldReport {
  created: string[];
  skipped: string[];
  notes: string[];
}

async function scaffold(
  shape: ProjectShape,
  opts: { dryRun: boolean; promptConflicts: boolean },
): Promise<ScaffoldReport> {
  const report: ScaffoldReport = { created: [], skipped: [], notes: [] };
  const rel = (p: string): string => path.relative(shape.root, p).split(path.sep).join('/');

  for (const plan of planFiles(shape)) {
    const content = await readTemplate(plan.template);
    if (await exists(plan.target)) {
      if (opts.promptConflicts && !opts.dryRun) {
        const choice = await askFileConflict(rel(plan.target));
        if (choice === 'keep') {
          report.skipped.push(`${rel(plan.target)} (already exists, kept)`);
          continue;
        }
        if (choice === 'custom') {
          const custom = await askCustomName(rel(plan.target));
          const customTarget = path.join(path.dirname(plan.target), custom);
          if (!opts.dryRun) {
            await fs.mkdir(path.dirname(customTarget), { recursive: true });
            await fs.writeFile(customTarget, content, 'utf8');
          }
          report.created.push(rel(customTarget));
          continue;
        }
        // overwrite
      } else {
        report.skipped.push(`${rel(plan.target)} (already exists, kept)`);
        continue;
      }
    }
    if (!opts.dryRun) {
      await fs.mkdir(path.dirname(plan.target), { recursive: true });
      await fs.writeFile(plan.target, content, 'utf8');
    }
    report.created.push(rel(plan.target));
  }

  // Logger wiring in the root layout.
  // App Router: render <LoggerDashboardInit /> (a client component) so
  // the browser logger actually runs in the browser — a side-effect-only
  // import from a Server Component layout would only run on the server.
  // Pages Router: _app runs in the browser, so a side-effect import is
  // enough there.
  const layoutFile = await findLayout(shape);
  const loggerFile = path.join(shape.base, 'lib', `${LOGGER_FILE}.${extFor(shape, 'code')}`);
  const initFile = path.join(
    shape.base,
    'lib',
    `logger-dashboard-init.${extFor(shape, 'component')}`,
  );
  const isPagesLayout =
    layoutFile !== null &&
    layoutFile.split(path.sep).includes('pages') &&
    path.basename(layoutFile).startsWith('_app');
  if (!layoutFile) {
    report.notes.push(
      'No root layout found — add this import once in your root layout: ' +
        loggerImportFor(path.join(shape.base, 'app', 'layout.tsx'), loggerFile),
    );
  } else if (isPagesLayout) {
    const source = await fs.readFile(layoutFile, 'utf8');
    if (source.includes(LOGGER_FILE)) {
      report.skipped.push(`${rel(layoutFile)} (logger import already present)`);
    } else {
      const importLine = loggerImportFor(layoutFile, loggerFile);
      if (!opts.dryRun) {
        await fs.writeFile(layoutFile, insertImportAfterDirectives(source, importLine), 'utf8');
      }
      report.created.push(`${rel(layoutFile)} (logger import added)`);
    }
  } else {
    const source = await fs.readFile(layoutFile, 'utf8');
    // Import and element are checked separately: an earlier uninstall
    // strips the import while leaving the element (or vice versa), and
    // re-running setup must repair whichever half is missing instead of
    // assuming the wiring is complete.
    const hasImport = source.includes('logger-dashboard-init');
    const hasElement = source.includes('<LoggerDashboardInit');
    if (hasImport && hasElement) {
      report.skipped.push(`${rel(layoutFile)} (LoggerDashboardInit already present)`);
    } else {
      let updated = source;
      if (!hasImport) {
        updated = insertImportAfterDirectives(updated, initImportFor(layoutFile, initFile));
      }
      if (!hasElement) {
        const withElement = insertInitElement(updated);
        if (withElement === null) {
          // No <body> tag to attach to — fall back to the side-effect
          // import and tell the user to render the component manually.
          report.notes.push(
            'No <body> tag found in the root layout — the logger import was added, but browser capture needs <LoggerDashboardInit /> rendered; add it manually.',
          );
          if (!hasImport) {
            updated = insertImportAfterDirectives(
              source,
              loggerImportFor(layoutFile, loggerFile),
            );
          }
        } else {
          updated = withElement;
        }
      }
      if (!opts.dryRun) await fs.writeFile(layoutFile, updated, 'utf8');
      report.created.push(`${rel(layoutFile)} (LoggerDashboardInit added)`);
    }
  }

  report.notes.push('Run the dev server and open /logger-dashboard to see the dashboard.');
  report.notes.push(
    `To remove the dashboard later, run \`npx ${PACKAGE_NAME} uninstall\` before \`npm uninstall\` — npm does not run uninstall hooks, so a plain 'npm uninstall' leaves the scaffolded files behind.`,
  );
  return report;
}

async function askFileConflict(relTarget: string): Promise<'keep' | 'overwrite' | 'custom'> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'keep';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      `File already exists: ${relTarget}\n  [1] Keep existing (skip)  [2] Overwrite  [3] Custom name (default 1): `,
      (a) => {
        rl.close();
        resolve(a.trim());
      },
    );
  });
  if (answer === '2') return 'overwrite';
  if (answer === '3') return 'custom';
  return 'keep';
}

async function askCustomName(relTarget: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return path.basename(relTarget);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`  New file name for ${relTarget}: `, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
  return answer || path.basename(relTarget);
}

function printReport(report: ScaffoldReport, dryRun: boolean): void {
  for (const line of report.created) {
    console.log(`${dryRun ? 'Would create' : 'Created'}: ${line}`);
  }
  for (const line of report.skipped) {
    console.log(`Skipped: ${line}`);
  }
  for (const line of report.notes) {
    console.log(line);
  }
}

async function runSetup(args: string[]): Promise<number> {
  const rootIndex = args.indexOf('--root');
  const rootArg = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const root = resolveProjectRoot(rootArg);
  const pkg = await readJson(path.join(root, 'package.json'));
  if (!pkg) {
    console.log('No package.json found — run this command from a Next.js project directory.');
    return 0;
  }
  if (pkg.name === PACKAGE_NAME) return 0; // own repo guard
  const shape = await detectShape(root);
  const dryRun = args.includes('--dry-run');
  const envChoice = process.env.LOGGER_DASHBOARD_SETUP;
  let mode: 'auto' | 'manual' = 'manual';
  if (args.includes('--auto') || envChoice === 'auto') mode = 'auto';
  else if (args.includes('--manual') || envChoice === 'manual') mode = 'manual';
  else if (envChoice === 'skip') {
    console.log('Setup skipped (LOGGER_DASHBOARD_SETUP=skip).');
    return 0;
  } else {
    mode = await askChoice(30_000);
  }

  if (mode === 'manual') {
    const layoutFile = await findLayout(shape);
    console.log(manualStepsText(shape, layoutFile));
    return 0;
  }
  const promptConflicts = !args.includes('--auto') && envChoice !== 'auto';
  const report = await scaffold(shape, { dryRun, promptConflicts });
  printReport(report, dryRun);
  return 0;
}

/* ------------------------------------------------------------------ */
/* Uninstall: remove only what the scaffolder wrote                    */
/* ------------------------------------------------------------------ */

async function checkScaffolded(
  file: string,
  template: string,
): Promise<'removed' | 'kept-modified' | 'absent'> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return 'absent';
  }
  const same =
    normalizeLineEndings(content).trim() === normalizeLineEndings(template).trim();
  return same ? 'removed' : 'kept-modified';
}

async function removeIfScaffolded(
  file: string,
  template: string,
): Promise<'removed' | 'kept-modified' | 'absent'> {
  const outcome = await checkScaffolded(file, template);
  if (outcome === 'removed') await fs.unlink(file);
  return outcome;
}

/** Remove a directory, but only if it is empty (never deletes other files). */
async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: false });
  } catch {
    // Non-empty, missing or otherwise busy — leave it alone.
  }
}

const LOGGER_IMPORT_LINE =
  /^\s*import\s+(?:[\w{}, *]+\s+from\s+)?['"][^'"]*logger-dashboard(-init)?(\.(ts|tsx|js|jsx))?['"]\s*;?\s*$/;
const INIT_ELEMENT_LINE = /^\s*<LoggerDashboardInit\s*\/>\s*$/;

/**
 * Remove the logger import line (and the <LoggerDashboardInit /> element
 * line, if present) from a layout/_app file. The file itself is always
 * kept — only those lines go. The file's line endings are preserved.
 */
async function stripLoggerImport(
  file: string,
  dryRun: boolean,
): Promise<'stripped' | 'unchanged' | 'absent'> {
  let content: string;
  try {
    content = await fs.readFile(file, 'utf8');
  } catch {
    return 'absent';
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (LOGGER_IMPORT_LINE.test(line)) continue;
    if (INIT_ELEMENT_LINE.test(line)) continue;
    // The element may share its line with other JSX (e.g. {children}),
    // so remove just the element token and keep the rest of the line.
    kept.push(line.replace(/<LoggerDashboardInit\s*\/>/g, ''));
  }
  if (kept.length === lines.length && kept.every((line, i) => line === lines[i])) {
    return 'unchanged';
  }
  if (!dryRun) await fs.writeFile(file, kept.join(eol), 'utf8');
  return 'stripped';
}

async function runUninstall(args: string[]): Promise<number> {
  const dryRun = args.includes('--dry-run');
  const rootIndex = args.indexOf('--root');
  const rootArg = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const root = resolveProjectRoot(rootArg);
  const rel = (p: string): string => path.relative(root, p).split(path.sep).join('/');

  const pkg = await readJson(path.join(root, 'package.json'));
  if (!pkg || pkg.name === PACKAGE_NAME) return 0;

  const removed: string[] = [];
  const kept: string[] = [];
  const bases = [root, path.join(root, 'src')];

  // Every location a scaffolded file could live: both routers, both
  // extension styles, src/ and root.
  const candidates: { template: string; target: string }[] = [];
  for (const base of bases) {
    for (const code of ['ts', 'js']) {
      candidates.push(
        { template: `${STORE_FILE}.${code}`, target: path.join(base, 'lib', `${STORE_FILE}.${code}`) },
        { template: `${LOGGER_FILE}.${code}`, target: path.join(base, 'lib', `${LOGGER_FILE}.${code}`) },
        { template: `instrumentation.${code}`, target: path.join(base, `instrumentation.${code}`) },
        {
          template: `records-route.${code}`,
          target: path.join(base, 'app', 'api', 'logger-dashboard', 'records', `route.${code}`),
        },
        {
          template: `ingest-route.${code}`,
          target: path.join(base, 'app', 'api', 'logger-dashboard', 'ingest', `route.${code}`),
        },
        {
          template: `records-pages.${code}`,
          target: path.join(base, 'pages', 'api', 'logger-dashboard', `records.${code}`),
        },
        {
          template: `ingest-pages.${code}`,
          target: path.join(base, 'pages', 'api', 'logger-dashboard', `ingest.${code}`),
        },
      );
      for (const comp of ['tsx', 'jsx']) {
        candidates.push(
          {
            template: `dashboard-page.${comp}`,
            target: path.join(base, 'app', 'logger-dashboard', `page.${comp}`),
          },
          {
            template: `dashboard-page.${comp}`,
            target: path.join(base, 'pages', `logger-dashboard.${comp}`),
          },
          {
            template: `logger-init.${comp}`,
            target: path.join(base, 'lib', `logger-dashboard-init.${comp}`),
          },
        );
      }
    }
  }

  const seen = new Set<string>();
  for (const { template, target } of candidates) {
    if (seen.has(target)) continue;
    seen.add(target);
    const templateText = await readTemplate(template);
    const outcome = dryRun
      ? await checkScaffolded(target, templateText)
      : await removeIfScaffolded(target, templateText);
    if (outcome === 'removed') {
      removed.push(rel(target));
      if (!dryRun) {
        // Prune directories left empty, deepest first.
        let dir = path.dirname(target);
        while (dir !== root && dir.startsWith(root)) {
          await removeDirIfEmpty(dir);
          const parent = path.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      }
    } else if (outcome === 'kept-modified') {
      kept.push(`${rel(target)} (modified, left untouched)`);
    }
  }

  // Strip the logger import from layouts / _app files.
  for (const base of bases) {
    for (const [dir, name] of LAYOUT_CANDIDATES) {
      for (const ext of ['tsx', 'jsx', 'ts', 'js']) {
        const layout = path.join(base, dir, `${name}.${ext}`);
        const outcome = await stripLoggerImport(layout, dryRun);
        if (outcome === 'stripped') {
          removed.push(`${rel(layout)} (logger import line removed, file kept)`);
        }
      }
    }
  }

  for (const line of removed) {
    console.log(`${dryRun ? 'Would remove' : 'Removed'}: ${line}`);
  }
  for (const line of kept) {
    console.log(`Kept: ${line}`);
  }
  if (removed.length === 0 && kept.length === 0) {
    console.log('Nothing to remove — no scaffolded dashboard files were found.');
  }
  return 0;
}

function printHelp(): void {
  console.log(
    `${PACKAGE_NAME} — API logger dashboard for Next.js\n\n` +
      'Usage:\n' +
      `  npx ${PACKAGE_NAME} setup [--auto|--manual|--dry-run] [--root <dir>]\n` +
      `  npx ${PACKAGE_NAME} uninstall [--dry-run] [--root <dir>]\n\n` +
      '  setup          Ask whether to set up automatically or manually.\n' +
      '  setup --auto   Create the API routes, dashboard page and logger import.\n' +
      '  setup --manual Print the manual wiring steps; add no files.\n' +
      '  setup --dry-run Show what --auto would change, without writing.\n' +
      '  uninstall      Remove scaffolded files (edited files are kept).\n\n' +
      'After setup, open /logger-dashboard in the dev server. Run\n' +
      `  npx ${PACKAGE_NAME} uninstall\n` +
      'before `npm uninstall` — npm does not run uninstall hooks.\n',
  );
}

async function ownVersion(): Promise<string> {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'setup' || command === 'init') return runSetup(rest);
  if (command === 'uninstall' || command === 'remove') return runUninstall(rest);
  if (command === 'postinstall') {
    // Install-time hint only: npm scripts never get terminal input, so
    // prompting here cannot work. Never write files, never fail install.
    if (process.env.LOGGER_DASHBOARD_SETUP !== 'skip') {
      console.log(
        `\n${PACKAGE_NAME} installed. Run \`npx ${PACKAGE_NAME} setup\` to choose automatic setup, or:\n` +
          `  npx ${PACKAGE_NAME} setup --auto    (scaffold now)\n` +
          `  npx ${PACKAGE_NAME} setup --manual  (print the manual steps)\n`,
      );
    }
    return 0;
  }
  if (command === 'preuninstall') {
    // Best-effort only: npm does not run uninstall hooks.
    try {
      return await runUninstall(rest);
    } catch {
      return 0;
    }
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return 0;
  }
  if (command === '--version' || command === '-v') {
    console.log(await ownVersion());
    return 0;
  }
  printHelp();
  return 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
