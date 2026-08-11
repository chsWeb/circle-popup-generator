import { buildBlock } from '../lib/build-block.js';
import { getUserFromRequest, hasPurchased } from '../lib/auth.js';

/**
 * The paywall. The popup template never reaches the browser until this route
 * has confirmed a signed-in, paid account — which is why the free preview can
 * be fully interactive without giving the product away.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Sign in to generate your popup code.', needsAuth: true });
    }

    if (!(await hasPurchased(user.id))) {
      return res.status(402).json({ error: 'This account has not purchased access yet.', needsPurchase: true });
    }

    const { values, warnings, block } = buildBlock(req.body || {});

    if (warnings.length) {
      return res.status(400).json({ error: 'Fix these before generating.', warnings });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ block, values });
  } catch (error) {
    console.error('generate error', error);
    return res.status(500).json({ error: 'Could not generate the code block.' });
  }
}
