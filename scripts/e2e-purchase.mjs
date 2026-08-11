#!/usr/bin/env node
/**
 * End-to-end purchase test: npm run test:purchase
 *
 * Exercises the full chain without a browser or a card form —
 *   sign up -> checkout session -> signed webhook -> purchase row -> code released
 *
 * The webhook event is constructed and signed locally with the same HMAC scheme
 * Stripe uses, so signature verification is genuinely tested rather than
 * bypassed. Everything it creates is cleaned up at the end.
 *
 * Pass --port 3100 to test a server other than the default.
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { stripeClient } from '../lib/stripe.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 3000;
const BASE = `http://localhost:${PORT}`;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const env = {};
for (const line of readFileSync(`${ROOT}.env.local`, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i === -1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

let failures = 0;
const step = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? GREEN + '✓' : RED + '✗'}${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
};

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

let userId = null;

try {
  console.log(`\nEnd-to-end purchase test against ${BASE}\n`);

  /* 1 — an account, as a real signup would create */
  const email = `e2e${Date.now()}@example.com`;
  const password = 'TestPassword123!';
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });
  if (createError) throw new Error(`createUser: ${createError.message}`);
  userId = created.user.id;
  step(true, 'Account created', email);

  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  const token = signIn.session.access_token;
  step(true, 'Signed in, holding an access token');

  const authed = (extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

  /* 2 — code must be refused before payment */
  const before = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: authed({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ rootDomain: 'x.circle.so', ctaUrl: 'https://e.com', ctaText: 'Go' })
  });
  step(before.status === 402, 'Code refused before payment', `HTTP ${before.status}`);

  /* 3 — checkout session */
  const checkout = await fetch(`${BASE}/api/checkout`, { method: 'POST', headers: authed() });
  const checkoutBody = await checkout.json();
  step(checkout.ok && Boolean(checkoutBody.url), 'Checkout session created',
    checkoutBody.url ? checkoutBody.url.slice(0, 46) + '…' : JSON.stringify(checkoutBody));
  if (!checkout.ok) throw new Error('checkout failed — later steps would be meaningless');

  /* 4 — the webhook Stripe would send, signed the way Stripe signs it */
  const stripe = stripeClient();
  const sessionId = new URL(checkoutBody.url).pathname.split('/').pop();

  const event = {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_test_e2e_${Date.now()}`,
        object: 'checkout.session',
        payment_status: 'paid',
        amount_total: 5900,
        currency: 'usd',
        customer: null,
        customer_email: email,
        customer_details: { email },
        payment_intent: `pi_test_e2e_${Date.now()}`,
        client_reference_id: userId,
        metadata: { supabase_user_id: userId }
      }
    }
  };

  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  const hook = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` },
    body: payload
  });
  step(hook.status === 200, 'Signed webhook accepted', `HTTP ${hook.status}`);

  /* 4b — an unsigned one must be rejected */
  const forged = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
    body: payload
  });
  step(forged.status === 400, 'Forged webhook rejected', `HTTP ${forged.status}`);

  /* 5 — purchase recorded */
  const { data: rows } = await admin.from('purchases').select('*').eq('user_id', userId);
  step(rows?.length === 1 && rows[0].status === 'paid', 'Purchase row written',
    rows?.length ? `$${(rows[0].amount_total / 100).toFixed(2)}` : 'none');

  /* 6 — redelivery must not duplicate */
  await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${signature}` },
    body: payload
  });
  const { data: after } = await admin.from('purchases').select('id').eq('user_id', userId);
  step(after?.length === 1, 'Webhook redelivery is idempotent', `${after?.length} row(s)`);

  /* 7 — the actual product */
  const generate = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: authed({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      rootDomain: 'acme.circle.so',
      targetMode: 'all-pages',
      showTitle: 'true',
      title: 'Hello',
      subtext: 'Body copy.',
      ctaText: 'Go',
      ctaUrl: 'https://example.com',
      storageKey: 'circle-popup-e2e',
      trackingName: 'e2e',
      remindDays: '7'
    })
  });
  const generated = await generate.json();
  const block = generated.block || '';
  step(generate.ok && block.includes('acme.circle.so') && block.includes('trackThenRedirect'),
    'Real popup code released', `${block.length} chars`);

  /* 8 — second purchase blocked */
  const again = await fetch(`${BASE}/api/checkout`, { method: 'POST', headers: authed() });
  step(again.status === 409, 'Second purchase refused', `HTTP ${again.status}`);

  await stripe.checkout.sessions.expire(sessionId).catch(() => {});
} catch (error) {
  failures += 1;
  console.log(`\n  ${RED}${error.message}${RESET}`);
} finally {
  if (userId) {
    await admin.from('purchases').delete().eq('user_id', userId);
    await admin.auth.admin.deleteUser(userId);
    console.log(`\n  ${DIM}cleaned up test account and purchase row${RESET}`);
  }
}

console.log(
  failures ? `\n${RED}${failures} step(s) failed.${RESET}\n` : `\n${GREEN}Full purchase chain works.${RESET}\n`
);
process.exit(failures ? 1 : 0);
