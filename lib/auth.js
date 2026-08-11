import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Service-role client. Bypasses row-level security, so it never touches a
 * request path a user controls — webhook fulfilment only.
 */
export function serviceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  }

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

/**
 * Resolves the caller from their `Authorization: Bearer <access_token>` header.
 * Returns null when the token is missing, malformed, or expired.
 */
export async function getUserFromRequest(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return null;

  return data.user;
}

/** True when this account has a completed one-time purchase on file. */
export async function hasPurchased(userId) {
  const { data, error } = await serviceClient()
    .from('purchases')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'paid')
    .limit(1);

  if (error) throw error;
  return Boolean(data && data.length);
}

/**
 * The origin to build absolute Stripe redirect URLs from.
 *
 * Deliberately ignores a localhost PUBLIC_SITE_URL when the request did not
 * come from localhost. Copying .env.local into Vercel is the obvious thing to
 * do, and the failure it causes is expensive and silent: real customers pay,
 * then get redirected to http://localhost:3000, which is dead for them. The
 * request's own host is always a safer answer than a stale config value.
 */
export function siteUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
  const requestOrigin = `${proto}://${host}`;

  const configured = process.env.PUBLIC_SITE_URL?.replace(/\/+$/, '');
  if (!configured) return requestOrigin;

  const configuredIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(configured);
  const requestIsLocal = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);

  if (configuredIsLocal && !requestIsLocal) {
    console.warn(
      `PUBLIC_SITE_URL is ${configured} but this request came from ${host}. ` +
        'Ignoring it and using the request host. Remove PUBLIC_SITE_URL from your production environment.'
    );
    return requestOrigin;
  }

  return configured;
}
