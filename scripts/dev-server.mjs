#!/usr/bin/env node
/**
 * Local dev server. Run: npm run dev
 *
 * Serves public/ as static files and dispatches /api/* to the same handler
 * modules Vercel runs in production, emulating enough of Vercel's req/res to
 * keep the handlers unmodified.
 *
 * Exists so local testing doesn't require a Vercel login. `vercel dev` is the
 * higher-fidelity option once you're logged in; this is for getting the
 * purchase flow working without that dependency.
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = new URL('..', import.meta.url).pathname;
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_BEACON = join(tmpdir(), 'cpg-webhook-beacon');

/* --- environment ---------------------------------------------------------- */

const envPath = join(ROOT, '.env.local');

if (!existsSync(envPath)) {
  console.error('No .env.local found. Copy .env.example and fill it in.');
  process.exit(1);
}

let envSignature = '';

/**
 * Re-read .env.local whenever it changes on disk.
 *
 * Loading it once at boot meant editing a key — swapping a Stripe price, say —
 * left the running server silently using the old value, and the only symptom
 * was a confusing error from a third-party API. Production doesn't have this
 * problem (each Vercel invocation gets fresh env), so it was purely a local
 * trap. Cheap enough to check per request.
 */
function loadEnv() {
  const raw = readFileSync(envPath, 'utf8');
  if (raw === envSignature) return false;

  const first = envSignature !== '';
  envSignature = raw;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    process.env[key] = value;
  }

  if (first) console.log('  ↻ .env.local changed — reloaded');
  return true;
}

loadEnv();

/* --- static file serving -------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

async function resolveStatic(pathname) {
  // Mirrors vercel.json's cleanUrls: /app resolves to /app.html
  const candidates =
    pathname === '/'
      ? ['index.html']
      : [pathname.replace(/^\//, ''), `${pathname.replace(/^\//, '')}.html`];

  for (const candidate of candidates) {
    const full = join(PUBLIC_DIR, normalize(candidate));
    if (!full.startsWith(PUBLIC_DIR)) continue; // path traversal guard
    try {
      const info = await stat(full);
      if (info.isFile()) return full;
    } catch {
      /* try the next candidate */
    }
  }

  return null;
}

/* --- Vercel-shaped response helpers -------------------------------------- */

function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (body) => {
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };

  res.send = (body) => {
    res.end(typeof body === 'string' ? body : String(body));
    return res;
  };

  return res;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* --- request handling ----------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  decorate(res);

  if (pathname.startsWith('/api/')) {
    loadEnv(); // pick up .env.local edits without a restart
    const name = pathname.slice(5).replace(/[^a-z0-9-]/gi, '');

    // Record webhook arrivals so `npm run test:webhook` can tell the
    // difference between "the handler is broken" and "nothing was delivered".
    // A stale `stripe listen` session keeps its socket open but stops
    // forwarding, which looks identical to a code failure from the outside.
    if (name === 'webhook') {
      try {
        writeFileSync(WEBHOOK_BEACON, String(Date.now()));
      } catch {
        /* diagnostics only */
      }
    }
    const modulePath = join(ROOT, 'api', `${name}.js`);

    if (!existsSync(modulePath)) {
      return res.status(404).json({ error: `No API route /api/${name}` });
    }

    try {
      const mod = await import(`${modulePath}?t=${Date.now()}`); // bust cache on edit
      const bodyParserDisabled = mod.config?.api?.bodyParser === false;

      if (bodyParserDisabled) {
        // The Stripe webhook verifies a signature over the raw bytes, so the
        // handler must read the stream itself. Leave it untouched.
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        const raw = await readBody(req);
        const type = req.headers['content-type'] || '';
        req.body = type.includes('application/json') && raw.length ? JSON.parse(raw.toString()) : raw.toString();
      }

      req.query = Object.fromEntries(url.searchParams);

      await mod.default(req, res);
      if (!res.writableEnded) res.end();
    } catch (error) {
      console.error(`  ✗ /api/${name}:`, error.message);
      if (!res.writableEnded) res.status(500).json({ error: error.message });
    }

    console.log(`  ${req.method} ${pathname} → ${res.statusCode}`);
    return;
  }

  const file = await resolveStatic(pathname);

  if (!file) {
    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<h1>404</h1><p>Not found.</p>');
  }

  res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(await readFile(file));
});

server.listen(PORT, () => {
  const missing = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_PRICE_ID',
    'STRIPE_WEBHOOK_SECRET'
  ].filter((key) => !process.env[key]);

  console.log(`\n  Circle Popup Generator — local dev`);
  console.log(`  http://localhost:${PORT}\n`);

  if (missing.length) {
    console.log(`  ⚠ Missing env: ${missing.join(', ')}`);
    console.log(`    Run: npm run check\n`);
  }

  console.log(`  Webhooks need a second terminal:`);
  console.log(`  stripe listen --forward-to localhost:${PORT}/api/webhook\n`);
});
