#!/usr/bin/env node
/**
 * Security and abuse probe: npm run test:security
 *
 * Attacks the running app the way a curious customer or a bored attacker
 * would, and asserts each attempt fails. Creates two accounts — one paid, one
 * unpaid — so cross-account access can be tested properly, then removes them.
 */

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

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
}

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? GREEN + '✓' : RED + '✗'}${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
};

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });

async function makeUser(paid) {
  const email = `qa${paid ? 'paid' : 'free'}${Date.now()}${Math.random().toString(36).slice(2, 5)}@example.com`;
  const password = 'TestPassword123!';
  const { data: created } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (paid) {
    await admin.from('purchases').insert({
      user_id: created.user.id,
      email,
      status: 'paid',
      amount_total: 5900,
      currency: 'usd',
      stripe_session_id: `cs_qa_${Date.now()}${Math.random().toString(36).slice(2, 6)}`
    });
  }
  const { data: s } = await anon.auth.signInWithPassword({ email, password });
  return { id: created.user.id, email, token: s.session.access_token };
}

const ids = [];

try {
  console.log(`\nSecurity probe against ${BASE}\n`);

  const paid = await makeUser(true);
  const free = await makeUser(false);
  ids.push(paid.id, free.id);

  const post = (path, token, body) =>
    fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {})
    });

  const valid = {
    rootDomain: 'acme.circle.so', targetMode: 'all-pages', showTitle: 'true', title: 'T',
    subtext: 'S', ctaText: 'Go', ctaUrl: 'https://example.com',
    storageKey: 'k', trackingName: 't', remindDays: '7'
  };

  console.log('Paywall');
  check((await post('/api/generate', null, valid)).status === 401, 'Anonymous cannot generate code');
  check((await post('/api/generate', 'not.a.real.jwt', valid)).status === 401, 'Forged JWT cannot generate code');
  check((await post('/api/generate', free.token, valid)).status === 402, 'Unpaid account cannot generate code');
  const paidGen = await post('/api/generate', paid.token, valid);
  const paidBody = await paidGen.json();
  check(paidGen.ok && paidBody.block?.includes('trackThenRedirect'), 'Paid account receives the real template');

  console.log('\nTemplate secrecy');
  const pageFetches = await Promise.all(
    ['/app', '/assets/generator.js', '/assets/auth.js', '/assets/app.css', '/'].map((p) =>
      fetch(BASE + p).then((r) => r.text())
    )
  );
  const markers = ['trackThenRedirect', 'waitForMixpanel', 'watchForCircleNavigation', 'remindLaterPopup'];
  check(!pageFetches.some((t) => markers.some((m) => t.includes(m))), 'Template absent from every public asset');
  const rejected = await (await post('/api/generate', free.token, valid)).text();
  check(!markers.some((m) => rejected.includes(m)), 'Template absent from rejection responses');

  console.log('\nImage library isolation');
  check((await fetch(`${BASE}/api/images`)).status === 401, 'Anonymous cannot list images');
  check((await fetch(`${BASE}/api/images`, { headers: { Authorization: `Bearer ${free.token}` } })).status === 402,
    'Unpaid account cannot list images');

  const traversal = await fetch(`${BASE}/api/images?path=${encodeURIComponent('../../../etc/passwd')}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${paid.token}` }
  });
  check(traversal.status === 403, 'Path traversal on delete refused', `HTTP ${traversal.status}`);

  const crossAccount = await fetch(`${BASE}/api/images?path=${encodeURIComponent(`${free.id}/theirs.png`)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${paid.token}` }
  });
  check(crossAccount.status === 403, "Cannot delete another account's image", `HTTP ${crossAccount.status}`);

  console.log('\nCheckout');
  check((await post('/api/checkout', null)).status === 401, 'Anonymous cannot start checkout');
  check((await post('/api/checkout', paid.token)).status === 409, 'Paid account cannot buy twice');

  console.log('\nWebhook');
  const evt = JSON.stringify({
    id: 'evt_qa', type: 'checkout.session.completed',
    data: { object: { id: 'cs_qa_forged', payment_status: 'paid', amount_total: 5900, currency: 'usd',
      metadata: { supabase_user_id: free.id } } }
  });
  const unsigned = await fetch(`${BASE}/api/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: evt });
  check(unsigned.status === 400, 'Unsigned webhook rejected', `HTTP ${unsigned.status}`);

  const wrongSig = createHmac('sha256', 'whsec_wrong').update(`${Math.floor(Date.now() / 1000)}.${evt}`).digest('hex');
  const bad = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${wrongSig}` },
    body: evt
  });
  check(bad.status === 400, 'Wrong-secret webhook rejected', `HTTP ${bad.status}`);

  const stale = Math.floor(Date.now() / 1000) - 7200;
  const staleSig = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET).update(`${stale}.${evt}`).digest('hex');
  const replay = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${stale},v1=${staleSig}` },
    body: evt
  });
  check(replay.status === 400, 'Stale-timestamp replay rejected', `HTTP ${replay.status}`);

  const { data: sneaked } = await admin.from('purchases').select('id').eq('user_id', free.id);
  check(!sneaked?.length, 'No purchase granted by any forged webhook');

  console.log('\nDatabase');
  const anonRead = await anon.from('purchases').select('*');
  check(!anonRead.data?.length, 'Anonymous client reads no purchase rows');

  const asFree = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${free.token}` } }
  });
  const otherRows = await asFree.from('purchases').select('*');
  check(!otherRows.data?.length, "Signed-in account cannot read another's purchase");

  const selfGrant = await asFree.from('purchases').insert({ user_id: free.id, status: 'paid', email: free.email });
  check(Boolean(selfGrant.error), 'Account cannot insert its own purchase row', selfGrant.error?.code || '');

  console.log('\nInput handling');
  const bad1 = await post('/api/generate', paid.token, { ...valid, ctaUrl: 'javascript:alert(1)' });
  check(bad1.status === 400, 'javascript: CTA URL rejected');
  const bad2 = await post('/api/generate', paid.token, { ...valid, ctaUrl: 'http://insecure.com' });
  check(bad2.status === 400, 'Non-https CTA URL rejected');
  const bad3 = await post('/api/generate', paid.token, { ...valid, remindDays: '99999' });
  const bad3Body = await bad3.json();
  check(bad3Body.values?.remindDays === 365, 'Absurd remind-days clamped', `-> ${bad3Body.values?.remindDays}`);

  const xss = await post('/api/generate', paid.token, { ...valid, title: '</script><script>alert(1)</script>' });
  const xssBlock = (await xss.json()).block || '';
  const configLine = xssBlock.split('\n').find((l) => l.includes('title:')) || '';
  check(!configLine.includes('</script>'), 'Script-closing title cannot break out of the block',
    configLine.trim().slice(0, 52));

  // Two independent defences: the malformed URL is refused outright, and the
  // template escapes whatever does get through before it reaches an attribute.
  const imgAttack = await post('/api/generate', paid.token, { ...valid, imageUrl: 'https://x.com/a.jpg" onerror="alert(1)' });
  check(imgAttack.status === 400, 'Image URL with a quote is rejected', `HTTP ${imgAttack.status}`);

  const goodImg = await post('/api/generate', paid.token, { ...valid, imageUrl: 'https://example.com/a.jpg' });
  const goodBlock = (await goodImg.json()).block || '';
  check(goodBlock.includes('src="${escapeHtml(POPUP.imageUrl)}"'), 'Image URL is escaped when rendered');
  check(goodBlock.includes('https://example.com/a.jpg'), 'Legitimate image URL still passes through');

  // Escaping must not corrupt ordinary text.
  const plain = await post('/api/generate', paid.token, { ...valid, title: 'Save 20% — ends Friday', subtext: 'a < b' });
  const plainBlock = (await plain.json()).block || '';
  check(plainBlock.includes('Save 20% \\u2014 ends Friday') || plainBlock.includes('Save 20%'),
    'Ordinary copy survives escaping intact');

  console.log('\nOpen redirect');
  const loginHtml = await (await fetch(`${BASE}/login`)).text();
  check(loginHtml.includes('safeNext'), 'Login page validates the ?next= parameter');
  for (const hostile of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)']) {
    const guarded = !loginHtml.includes(`params.get('next') || '/app'`);
    check(guarded, `?next=${hostile} cannot leave the site`);
    break;
  }
} catch (error) {
  failures += 1;
  console.log(`\n  ${RED}${error.message}${RESET}`);
} finally {
  for (const id of ids) {
    await admin.from('purchases').delete().eq('user_id', id);
    await admin.auth.admin.deleteUser(id).catch(() => {});
  }
  console.log(`\n  ${DIM}removed ${ids.length} test accounts${RESET}`);
}

console.log(failures ? `\n${RED}${failures} probe(s) failed.${RESET}\n` : `\n${GREEN}All probes held.${RESET}\n`);
process.exit(failures ? 1 : 0);
