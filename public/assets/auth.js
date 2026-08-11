/* ---------------------------------------------------------------------------
   Shared Supabase auth helpers, used by both /login and /app.
   Loaded as an ES module: <script type="module">.
   --------------------------------------------------------------------------- */

// Pinned deliberately. Keep in step with the version in package.json so the
// browser and the API routes behave identically — notably around the newer
// sb_publishable_ / sb_secret_ API key format.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.112.1';

let clientPromise = null;

/** Boots the Supabase client from /api/config. Cached for the page's lifetime. */
export function getSupabase() {
  if (!clientPromise) {
    clientPromise = fetch('/api/config')
      .then((response) => {
        if (!response.ok) throw new Error('Could not load site configuration.');
        return response.json();
      })
      .then((config) =>
        createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        })
      );
  }

  return clientPromise;
}

export async function getSession() {
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

/**
 * Resolves the account's access state in one call.
 * Reads the purchases table directly — row-level security guarantees a user can
 * only ever see their own row, so this is safe to do from the browser.
 */
export async function getAccessState() {
  const session = await getSession();
  if (!session) return { signedIn: false, purchased: false, user: null };

  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('purchases')
    .select('id')
    .eq('status', 'paid')
    .limit(1);

  if (error) console.warn('purchase lookup failed', error.message);

  return {
    signedIn: true,
    purchased: Boolean(data && data.length),
    user: session.user,
    accessToken: session.access_token
  };
}

/** Calls one of our API routes with the caller's access token attached. */
export async function apiPost(path, body) {
  const session = await getSession();

  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {})
    },
    body: JSON.stringify(body || {})
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    /* empty or non-JSON body — the status code is enough */
  }

  return { ok: response.ok, status: response.status, ...payload };
}

export async function signOut() {
  const supabase = await getSupabase();
  await supabase.auth.signOut();
  window.location.href = '/';
}
