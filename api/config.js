/**
 * Hands the browser the public config it needs to boot. Keeping this in an API
 * route means the static pages need no build step — env vars stay in Vercel and
 * nothing is baked into a committed file.
 */
export default function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase environment variables are not configured.' });
  }

  res.setHeader('Cache-Control', 'public, max-age=60');

  return res.status(200).json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
}
