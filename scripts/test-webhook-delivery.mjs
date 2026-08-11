#!/usr/bin/env node
/**
 * Webhook delivery test: npm run test:webhook
 *
 * Fires a real event through Stripe and checks it actually arrives.
 *
 * This covers the one gap the other suites cannot: they sign their own webhook
 * payloads and POST them directly, so they prove the handler works while
 * telling you nothing about whether `stripe listen` is delivering. A CLI
 * session that has gone stale keeps its TCP socket open and reports no error —
 * events simply stop arriving. From the browser that is indistinguishable from
 * a broken paywall: the customer pays, and nothing happens.
 *
 * Run this before any manual purchase test.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const BEACON = join(tmpdir(), 'cpg-webhook-beacon');
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3000;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('\nWebhook delivery test\n');

let failed = false;
const ok = (m, d = '') => console.log(`  ${GREEN}✓${RESET} ${m}${d ? ` ${DIM}${d}${RESET}` : ''}`);
const bad = (m, d = '') => { failed = true; console.log(`  ${RED}✗${RESET} ${m}${d ? `\n      ${DIM}${d}${RESET}` : ''}`); };

/* 1 — is the dev server up? */
try {
  await fetch(`http://localhost:${PORT}/api/config`);
  ok('Dev server responding', `port ${PORT}`);
} catch {
  bad('Dev server is not running', `Start it: npm run dev`);
  process.exit(1);
}

/* 2 — is a listener running at all, and how old is it? */
try {
  const { stdout } = await run('/bin/sh', ['-c', "pgrep -f 'stripe listen' | head -1"]);
  const pid = stdout.trim();

  if (!pid) {
    bad('No `stripe listen` process found',
      `Start it: stripe listen --forward-to localhost:${PORT}/api/webhook`);
  } else {
    const { stdout: age } = await run('/bin/sh', ['-c', `ps -o etime= -p ${pid}`]);
    const elapsed = age.trim();
    const days = elapsed.includes('-') ? Number(elapsed.split('-')[0]) : 0;

    if (days >= 1) {
      console.log(`  ${YELLOW}!${RESET} Listener has been running ${elapsed} ${DIM}(pid ${pid})${RESET}`);
      console.log(`      ${DIM}Long-lived sessions can stop forwarding silently. The delivery check below is what matters.${RESET}`);
    } else {
      ok('Listener running', `pid ${pid}, up ${elapsed}`);
    }
  }
} catch {
  console.log(`  ${YELLOW}!${RESET} Could not inspect listener processes`);
}

/* 3 — the real test: fire an event and see whether it lands */
rmSync(BEACON, { force: true });
const firedAt = Date.now();

try {
  await run('stripe', ['trigger', 'checkout.session.completed'], { timeout: 60000 });
  ok('Test event fired through Stripe');
} catch (error) {
  bad('Could not fire a test event', error.message.split('\n')[0]);
}

process.stdout.write('  … waiting for delivery ');
let delivered = false;

for (let i = 0; i < 20; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  process.stdout.write('.');
  if (existsSync(BEACON) && Number(readFileSync(BEACON, 'utf8')) >= firedAt) {
    delivered = true;
    break;
  }
}

console.log('');

if (delivered) {
  ok('Event was delivered to /api/webhook', 'the listener is live');
} else {
  bad('No event arrived within 10 seconds',
    'The listener is stale or pointed elsewhere. Stop it (Ctrl+C) and start a fresh one:\n' +
      `      stripe listen --forward-to localhost:${PORT}/api/webhook\n` +
      '      Then confirm the whsec_ it prints matches STRIPE_WEBHOOK_SECRET in .env.local.');
}

rmSync(BEACON, { force: true });

console.log(
  failed
    ? `\n${RED}Webhook delivery is NOT working — a real purchase would not unlock.${RESET}\n`
    : `\n${GREEN}Webhook delivery confirmed.${RESET}\n`
);

process.exit(failed ? 1 : 0);
