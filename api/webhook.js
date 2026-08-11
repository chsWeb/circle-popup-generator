import { stripeClient } from '../lib/stripe.js';
import { serviceClient } from '../lib/auth.js';

// Stripe signs the raw bytes, so the body must not be parsed before we verify.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = stripeClient();
  let event;

  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(
      rawBody,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    console.error('webhook signature verification failed', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const session = event.data.object;

  if (session.payment_status !== 'paid') {
    return res.status(200).json({ received: true, ignored: 'unpaid session' });
  }

  const userId = session.metadata?.supabase_user_id || session.client_reference_id;

  if (!userId) {
    console.error('checkout.session.completed with no supabase user id', session.id);
    // 200 so Stripe stops retrying something retries cannot fix.
    return res.status(200).json({ received: true, error: 'missing user id' });
  }

  try {
    // onConflict on the session id makes redelivery idempotent: Stripe retries
    // the same event and we land on the same row instead of a duplicate.
    const { error } = await serviceClient()
      .from('purchases')
      .upsert(
        {
          user_id: userId,
          email: session.customer_details?.email || session.customer_email || null,
          status: 'paid',
          amount_total: session.amount_total,
          currency: session.currency,
          stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
          stripe_session_id: session.id,
          stripe_payment_intent_id:
            typeof session.payment_intent === 'string' ? session.payment_intent : null
        },
        { onConflict: 'stripe_session_id' }
      );

    if (error) throw error;
  } catch (error) {
    // A unique-violation on purchases_user_paid_idx means they already had
    // access — nothing to fix, so acknowledge rather than making Stripe retry.
    if (error.code === '23505') {
      return res.status(200).json({ received: true, note: 'already unlocked' });
    }

    console.error('failed to record purchase', error);
    return res.status(500).json({ error: 'Could not record purchase' });
  }

  return res.status(200).json({ received: true });
}
