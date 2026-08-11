import { stripeClient } from '../lib/stripe.js';
import { getUserFromRequest, hasPurchased, siteUrl } from '../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Please sign in before purchasing.' });

    // Don't let someone pay twice for something they already own.
    if (await hasPurchased(user.id)) {
      return res.status(409).json({ error: 'You already have access.', alreadyPurchased: true });
    }

    const stripe = stripeClient();
    const origin = siteUrl(req);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: user.email,
      client_reference_id: user.id,
      // The webhook trusts this, not anything the browser sends back.
      metadata: { supabase_user_id: user.id },
      payment_intent_data: { metadata: { supabase_user_id: user.id } },
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app?checkout=cancelled`,
      allow_promotion_codes: true
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('checkout error', error);

    // In development, pass Stripe's own message through. A bare 500 hid a pure
    // configuration problem (wrong API version) behind "please try again",
    // which is the least useful thing it could have said.
    const detail =
      process.env.NODE_ENV === 'production'
        ? undefined
        : `${error.type || 'Error'}: ${error.message}`;

    return res.status(500).json({ error: 'Could not start checkout. Please try again.', detail });
  }
}
