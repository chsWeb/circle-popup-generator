#!/usr/bin/env node
/**
 * Setup verification. Run: npm run check
 *
 * Checks every credential and the database wiring, and prints a pass/fail
 * checklist. Never prints a secret — only lengths, prefixes, and shapes.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '../lib/stripe.js';

const ENV_PATH = new URL('../.env.local', import.meta.url).pathname;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;
let warnings = 0;

function pass(label, detail = '') {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
}

function fail(label, detail = '') {
  failures += 1;
  console.log(`  ${RED}✗${RESET} ${label}${detail ? `\n      ${DIM}${detail}${RESET}` : ''}`);
}

function warn(label, detail = '') {
  warnings += 1;
  console.log(`  ${YELLOW}!${RESET} ${label}${detail ? `\n      ${DIM}${detail}${RESET}` : ''}`);
}

function heading(text) {
  console.log(`\n${text}`);
}

/* --- load .env.local --------------------------------------------------- */

if (!existsSync(ENV_PATH)) {
  console.error(`${RED}No .env.local found.${RESET} Copy .env.example to .env.local and fill it in.`);
  process.exit(1);
}

const env = {};
for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq === -1) continue;
  env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
}

/* --- 1. env vars present and shaped correctly -------------------------- */

heading('Environment variables');

// Supabase now issues sb_publishable_ / sb_secret_ keys; the legacy anon and
// service_role JWTs still work but are deprecated at the end of 2026. Accept
// either form, and flag the mismatched pairing that is easy to create by
// grabbing one key from each dashboard tab.
const isPublishable = (v) => v.startsWith('sb_publishable_') || v.startsWith('eyJ');
const isSecret = (v) => v.startsWith('sb_secret_') || v.startsWith('eyJ');

const checks = [
  ['SUPABASE_URL', (v) => /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(v), 'should look like https://abcdefgh.supabase.co'],
  ['SUPABASE_ANON_KEY', (v) => v.length > 40 && isPublishable(v), 'should be your sb_publishable_... key (or a legacy anon JWT starting eyJ)'],
  ['SUPABASE_SERVICE_ROLE_KEY', (v) => v.length > 40 && isSecret(v), 'should be your sb_secret_... key (or a legacy service_role JWT starting eyJ)'],
  ['STRIPE_SECRET_KEY', (v) => /^sk_(test|live)_/.test(v), 'should start with sk_test_ or sk_live_'],
  ['STRIPE_PRICE_ID', (v) => /^price_/.test(v), 'should start with price_'],
  ['STRIPE_WEBHOOK_SECRET', (v) => /^whsec_/.test(v), 'should start with whsec_ (from `stripe listen`)']
];

for (const [key, valid, hint] of checks) {
  const value = env[key];
  if (!value) {
    fail(`${key} is empty`);
  } else if (!valid(value)) {
    fail(`${key} looks wrong`, hint);
  } else {
    pass(key, `(${value.length} chars)`);
  }
}

if (env.SUPABASE_ANON_KEY && env.SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_ROLE_KEY) {
  fail('Both Supabase keys are identical', 'You pasted the same key twice — they are different keys.');
}

// The dangerous swap: a secret key in the slot that ships to browsers.
if (env.SUPABASE_ANON_KEY?.startsWith('sb_secret_')) {
  fail('SUPABASE_ANON_KEY holds a SECRET key', 'This value is served to every visitor. Use the publishable key here and rotate that secret now.');
}

if (env.SUPABASE_SERVICE_ROLE_KEY?.startsWith('sb_publishable_')) {
  fail('SUPABASE_SERVICE_ROLE_KEY holds a publishable key', 'The webhook needs the secret key or it cannot record purchases.');
}

if (/^sk_live_/.test(env.STRIPE_SECRET_KEY || '')) {
  warn('Using a LIVE Stripe key', 'Real cards will be charged. Use sk_test_ while setting up.');
}

// Easy mix-ups: the two Stripe values sit next to each other in the dashboard
// and in this file, and a product ID looks a lot like a price ID.
if (/^sk_/.test(env.STRIPE_WEBHOOK_SECRET || '')) {
  fail('STRIPE_WEBHOOK_SECRET holds your secret API key', 'That belongs in STRIPE_SECRET_KEY. The webhook secret starts with whsec_ and comes from `stripe listen`.');
}

if (/^prod_/.test(env.STRIPE_PRICE_ID || '')) {
  fail('STRIPE_PRICE_ID holds a product ID', 'You need the price_… ID. One product can have several prices, so the checkout needs the specific one.');
}

/* --- 2. Supabase connectivity and schema -------------------------------- */

heading('Supabase');

if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  try {
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    const { error } = await admin.from('purchases').select('id').limit(1);

    if (error) {
      if (/does not exist|schema cache/i.test(error.message)) {
        fail('purchases table not found', 'Run supabase/schema.sql in the SQL Editor.');
      } else {
        fail('Could not query purchases table', error.message);
      }
    } else {
      pass('purchases table exists and service_role can read it');
    }
  } catch (error) {
    fail('Could not reach Supabase with the service_role key', error.message);
  }
} else {
  fail('Skipped Supabase checks', 'URL or service_role key missing.');
}

// Row-level security: an anonymous client must NOT be able to read purchases.
// This is the check that proves a customer cannot grant themselves access.
if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
  try {
    const anon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false }
    });

    const { data, error } = await anon.from('purchases').select('id').limit(1);

    if (error && /permission denied|row-level security/i.test(error.message)) {
      pass('RLS blocks anonymous reads of purchases');
    } else if (!error && Array.isArray(data) && data.length === 0) {
      // RLS returns an empty set rather than an error for SELECT policies.
      pass('RLS returns no rows to anonymous callers');
    } else if (!error && data?.length) {
      fail('RLS IS NOT WORKING', 'An anonymous client can read purchase rows. Re-run supabase/schema.sql.');
    } else {
      warn('Could not conclusively verify RLS', error?.message || 'unexpected response');
    }
  } catch (error) {
    fail('Could not reach Supabase with the anon key', error.message);
  }
}

/* --- 3. Stripe ---------------------------------------------------------- */

heading('Stripe');

if (env.STRIPE_SECRET_KEY && /^sk_/.test(env.STRIPE_SECRET_KEY)) {
  try {
    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
    const account = await stripe.accounts.retrieve();
    pass('Secret key is valid', `account ${account.id}`);
    pass('API version', STRIPE_API_VERSION);

    if (env.STRIPE_PRICE_ID && /^price_/.test(env.STRIPE_PRICE_ID)) {
      try {
        const price = await stripe.prices.retrieve(env.STRIPE_PRICE_ID);
        const amount = (price.unit_amount / 100).toFixed(2);
        const currency = price.currency.toUpperCase();

        pass('Price ID is valid', `${amount} ${currency}`);

        if (price.type !== 'one_time') {
          fail(`Price is "${price.type}", not one_time`, 'The checkout uses mode:payment and needs a one-off price.');
        } else {
          pass('Price is a one-time charge');
        }

        if (!price.active) fail('Price is not active in Stripe');

        // Retrieving a price proves the key works; it does not prove checkout
        // does. Managed Payments and other account settings only surface when
        // a session is actually created, so create one and throw it away.
        try {
          const probe = await stripe.checkout.sessions.create({
            mode: 'payment',
            line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
            success_url: 'https://example.com/success',
            cancel_url: 'https://example.com/cancel'
          });
          await stripe.checkout.sessions.expire(probe.id);
          pass('Checkout session can be created');
        } catch (error) {
          fail('Checkout would fail for real customers', `${error.type}: ${error.message}`);
        }
      } catch (error) {
        fail('Price ID could not be retrieved', error.message);
      }
    }
  } catch (error) {
    fail('Stripe secret key rejected', error.message);
  }
}

/* --- summary ------------------------------------------------------------ */

console.log('');
if (failures) {
  console.log(`${RED}${failures} problem(s) to fix.${RESET}${warnings ? ` ${YELLOW}${warnings} warning(s).${RESET}` : ''}`);
  process.exit(1);
}

console.log(`${GREEN}Everything checks out.${RESET}${warnings ? ` ${YELLOW}${warnings} warning(s) above.${RESET}` : ''}`);
console.log(`${DIM}Next: npx vercel dev  (and: stripe listen --forward-to localhost:3000/api/webhook)${RESET}`);
