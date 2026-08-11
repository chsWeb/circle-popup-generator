import { getUserFromRequest, hasPurchased, serviceClient } from '../lib/auth.js';

const BUCKET = 'popup-images';

/**
 * The image library: lists and deletes the caller's own uploads.
 *
 * Listing runs server-side with the service role rather than via a storage RLS
 * policy, deliberately. The bucket has to stay publicly readable so member
 * browsers can load images from inside a Circle community, and a policy broad
 * enough to allow that would also let any signed-in account enumerate every
 * other account's files. Scoping the prefix here keeps public reads working
 * while keeping the listing private.
 */
export default async function handler(req, res) {
  if (!['GET', 'DELETE'].includes(req.method)) {
    res.setHeader('Allow', 'GET, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Sign in first.', needsAuth: true });

    if (!(await hasPurchased(user.id))) {
      return res.status(402).json({ error: 'Image hosting is part of the paid plan.', needsPurchase: true });
    }

    const supabase = serviceClient();
    const storage = supabase.storage.from(BUCKET);

    if (req.method === 'DELETE') {
      const path = String(req.query?.path || '');

      // Never trust the caller's path: it must sit inside their own folder.
      if (!path.startsWith(`${user.id}/`) || path.includes('..')) {
        return res.status(403).json({ error: 'That image does not belong to this account.' });
      }

      const { error } = await storage.remove([path]);
      if (error) throw error;
      return res.status(200).json({ deleted: path });
    }

    const { data, error } = await storage.list(user.id, {
      limit: 60,
      sortBy: { column: 'created_at', order: 'desc' }
    });

    if (error) throw error;

    const images = (data || [])
      .filter((file) => file.id) // storage returns folder placeholders without an id
      .map((file) => {
        const path = `${user.id}/${file.name}`;
        return {
          path,
          url: storage.getPublicUrl(path).data.publicUrl,
          size: file.metadata?.size ?? null,
          createdAt: file.created_at
        };
      });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ images });
  } catch (error) {
    console.error('images error', error);
    return res.status(500).json({ error: 'Could not load your images.' });
  }
}
