import Stripe from 'stripe';

/**
 * The Stripe API version this code is written against.
 *
 * Pinned deliberately, and in one place. Two reasons:
 *
 * 1. Managed Payments — which this account has enabled — is rejected outright
 *    on versions older than 2025-03-31.basil. The SDK's default was older, and
 *    the only symptom was a 500 from /api/checkout.
 * 2. An unpinned client silently adopts whatever version a future `npm install`
 *    brings, which can change webhook payload shapes under you.
 *
 * Raise this deliberately, and re-run the purchase flow when you do.
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia';

export function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set.');
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: STRIPE_API_VERSION
  });
}
