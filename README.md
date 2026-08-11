# Circle Popup Generator

**Turn a form into a paste-ready popup for your Circle community.** Fill in
the fields, watch it render live, copy the code, paste it into Circle. No
developer, no CSS, no support ticket.

🔗 **[Live site](#)** · $59 one-time · Not affiliated with Circle

![The generator](public/images/tn-popup-geenrator@2x.png)

Circle communities can run custom code, but writing a popup that behaves
properly — dismissal state that persists, mobile layout, not firing on every
page load — is a real front-end job. Most community managers don't have one
on staff. This gives them the artifact without the engineer.

**Built with:** vanilla HTML/CSS/JS (no build step), Vercel serverless
functions, Supabase for auth and purchase records, Stripe Checkout.

**Why it's interesting technically:** the paywall is architectural rather than
cosmetic — the popup template never reaches the browser until the server has
verified payment. See [How the paywall actually works](#how-the-paywall-actually-works)
below. Test coverage includes 28 security probes and a live webhook-delivery
check written after a stale CLI listener silently broke the purchase flow.

---

## How the paywall actually works

This is the part worth understanding before you change anything.

The popup script template lives in `lib/popup-template.js`, which is **server
code only**. It is never sent to the browser. When a paid user presses Copy, the
browser posts the form values to `/api/generate`, that route verifies the
Supabase access token and checks the `purchases` table, and only then does it
build and return the block.

So the free tier can be a fully working preview without giving the product
away — hiding the button isn't the mechanism, the server is. The blurred code
behind the lock overlay is decorative filler defined in `public/assets/generator.js`.

Corollary: don't move block generation into client-side JS to save a round trip.
That would hand the product to anyone who opens devtools.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Supabase

**On the Create-a-new-project screen:**

| Setting | Value | Why |
|---|---|---|
| Enable Data API | **on** | The browser reads `purchases` through it. Off breaks the app. |
| Automatically expose new tables | **off** | Supabase's own recommendation. `schema.sql` grants explicitly, so this is safe. |
| Enable automatic RLS | **on** | Belt and braces. `schema.sql` enables RLS anyway; this protects future tables. |
| Region | closest to your users | **Cannot be changed later** without a migration. |
| Database password | save it in a password manager | Unused by this app (we use API keys), but you can't recover it. |

**Then:**

1. In your Supabase project, open **SQL Editor → New query**, paste the contents
   of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the
   `purchases` table with row-level security, and the `popup-images` storage
   bucket with its upload policies. It is idempotent — **re-run it after any
   change to that file.**
2. Go to **Authentication → Sign In / Providers** (left sidebar, under
   CONFIGURATION) and confirm **Email** is enabled. Inside that panel, set
   **Minimum password length** to **8** — `public/login.html` tells users
   "at least 8 characters" and enforces it client-side, so leaving Supabase on
   its default of 6 means the server is laxer than the promise the UI makes.
3. On that same screen, expand the **Email** provider and decide on
   **Confirm email**. With it **on**, new users must click a link before they
   can sign in — the login page already handles that and tells them so. With it
   **off**, signup signs them straight in, which is the smoother purchase flow.

   > ⚠️ **Before launch: set up custom SMTP.** Supabase's built-in email service
   > is capped at **2 messages per hour** and carries no delivery SLA — it is
   > explicitly not for production. That cap applies to confirmation emails *and
   > password resets*, so even with confirmation off, a handful of customers
   > resetting passwords on the same afternoon will silently stop receiving
   > mail. Authentication → Emails → SMTP Settings. Resend's free tier is ample
   > and takes about ten minutes to wire up.
4. Under **Authentication → URL Configuration**, add your production URL and
   `http://localhost:3000` to the redirect allow list.
5. Copy three values into `.env.local`. **Settings** is the gear icon at the
   bottom of the left sidebar:

   | Value | Where | Goes into |
   |---|---|---|
   | Project URL | Settings → **Data API** | `SUPABASE_URL` |
   | Publishable key (`sb_publishable_…`) | Settings → **API Keys** | `SUPABASE_ANON_KEY` |
   | Secret key (`sb_secret_…`) | Settings → **API Keys** | `SUPABASE_SERVICE_ROLE_KEY` |

   Supabase replaced the old `anon` / `service_role` JWTs with these in 2025;
   the legacy pair still works but is deprecated at the end of 2026, so a new
   project should use the new format. Our env var names kept the old spelling —
   they're just internal labels and don't need to match Supabase's.

Supabase renames these screens periodically. As of August 2026 the ones this
project touches are:

| What you want | Where it lives |
|---|---|
| Enable email auth, "Confirm email" toggle | Authentication → **Sign In / Providers** |
| Redirect allow list, Site URL | Authentication → **URL Configuration** |
| Custom SMTP (Resend) | Authentication → **Emails** |
| Project URL, anon key, service_role key | Project Settings → **API** |
| Run the schema | **SQL Editor** → New query |

### 3. Stripe

Stripe replaced the old test-mode toggle with **sandboxes** — isolated test
environments inside an account. Open the account picker (top left) and use
**Switch to sandbox**. All setup below happens inside the sandbox.

1. Create a **one-time** product priced at $59 and copy its **price** ID
   (`price_…`, not the `prod_…` product ID). A recurring price will be rejected:
   the checkout uses `mode: payment`.

   Tax category: **Digital products → Software as a service (SaaS) → business
   use** (`txcd_10103001`). The generator is hosted and nothing is installed, so
   it is SaaS rather than downloadable software, and buyers use it to run their
   communities. Use the same code when you recreate the product in live mode —
   that is the one that actually drives tax collection. Confirm with an
   accountant before taking live payments.
2. Copy your secret key (`sk_test_…`) from **Developers → API keys**.
3. Leave `STRIPE_WEBHOOK_SECRET` empty until step 6 — `stripe listen` prints a
   local one.

> **Sandbox data does not migrate to live.** Products and prices created in a
> sandbox exist only there. When you go live you create the product a second
> time in the live account and swap `STRIPE_PRICE_ID` and `STRIPE_SECRET_KEY`.
> Nothing else changes.

### 4. Environment variables

Copy `.env.example` to `.env.local` and fill it in. Add the same variables in
the Vercel dashboard under **Settings → Environment Variables** before your
first production deploy.

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security. It is only used by the
webhook and the purchase lookup. Never expose it to the browser and never commit
it.

### 5. Verify the setup

```bash
npm run check
```

Confirms every key is present and correctly shaped, that the `purchases` table
exists, that row-level security actually blocks anonymous reads, and that your
Stripe key and price ID are valid and one-time. It never prints a secret — only
lengths and prefixes. Fix anything it flags before moving on.

### 6. Run it

```bash
npm run dev
```

A small Node server (`scripts/dev-server.mjs`) that serves `public/` and
dispatches `/api/*` to the same handler modules Vercel runs in production. It
needs no Vercel account, which makes it the fastest way to get the purchase
flow working.

`npm run dev:vercel` runs `vercel dev` instead — higher fidelity to production
routing, but it requires `vercel login` first.

To exercise a real purchase locally, forward webhooks in a second terminal and
use the `whsec_` value it prints as your local `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:3000/api/webhook
```

> **Restart `stripe listen` before any manual purchase test, and run
> `npm run test:webhook` first.**
>
> A long-lived listener session can stop forwarding while keeping its socket
> open and reporting no error. Events simply stop arriving. From the browser
> this is indistinguishable from a broken paywall — the customer pays and
> nothing unlocks — and it cost several rounds of debugging code that was fine.
>
> `npm run test:purchase` cannot catch it: that suite signs its own webhook
> payloads and POSTs them directly, so it proves the handler works while saying
> nothing about delivery. `npm run test:webhook` fires a real event through
> Stripe and confirms it lands.

Stripe's test card is `4242 4242 4242 4242` with any future expiry and any CVC.

### 7. Deploy

```bash
npx vercel --prod
```

Then update the Stripe webhook endpoint and the Supabase redirect URLs to your
production domain.

**Activate the Stripe account after this, not before.** Activation asks for a
business website that must be publicly viewable, and until you deploy you don't
have one. Sandbox testing needs no activation at all, so the natural order is:
build → test in sandbox → deploy → activate with the real URL → switch to live
keys.

---

## Tests

```bash
npm test
```

Runs all four suites in about ten seconds. Each creates and deletes its own
Supabase accounts, so it's safe to run repeatedly. Run it before every deploy.

| Command | What it proves |
|---|---|
| `npm run check` | Env vars present and well-formed, Supabase table + RLS, Stripe key valid, API version correct, **and a real checkout session can be created** |
| `npm run test:purchase` | The whole chain: signup → code refused → checkout → signed webhook → purchase row → code released → second purchase blocked |
| `npm run test:security` | 28 probes — paywall bypass, template leakage, cross-account image access, path traversal, forged and stale webhooks, RLS, injection, open redirect |
| `npm run test:webhook` | Fires a **real** event through Stripe and confirms it arrives |

That last one exists because the others sign their own webhook payloads and
POST them directly. They prove the handler works while saying nothing about
whether `stripe listen` is delivering — and a stale CLI session keeps its
socket open while silently forwarding nothing. That failure looks exactly like
a broken paywall from the browser and cost several rounds of debugging code
that was fine.

Two bugs these suites were written in response to, both of which passed every
earlier check:

- Stripe rejected all checkout sessions because the SDK's default API version
  predates Managed Payments. Retrieving a price succeeded, so `npm run check`
  reported green while no customer could pay. It now creates and expires a
  real session.
- `PUBLIC_SITE_URL=http://localhost:3000` copied into production would have
  redirected paying customers to a dead address. `siteUrl()` now ignores a
  localhost value when the request isn't from localhost.

## Before launch

Ordered by consequence. The first two are not optional.

1. **Supabase Pro ($25/mo).** The free tier pauses a project after 7 days of
   low activity. That would break customer sign-in *and* every hosted popup
   image at once, inside communities you don't control, with no warning.
2. **Custom SMTP via Resend.** Supabase's built-in email is capped at
   **2 messages per hour** with no delivery SLA. That ceiling covers password
   resets, so it strands real customers even with email confirmation off.
3. **Do not set `PUBLIC_SITE_URL` in Vercel.** The guard in `lib/auth.js`
   protects you, but omitting it is cleaner.
4. **Clear the test accounts** from Supabase Auth so real signups aren't mixed
   in with `test05@`, `test8@` and friends.
5. **Swap in real screenshots** — seven placeholder slots, six in the feature
   tour and one for the video. Search `class="placeholder"`.
6. **Confirm the tax category** with an accountant before taking live payments.
   Currently `txcd_10103001` (SaaS, business use).

## Project layout

```
public/                     Static site — no build step
  index.html                Landing page
  app.html                  The generator
  login.html                Sign in / create account
  success.html              Post-checkout, polls until the webhook lands
  assets/
    site.css                Shared shell: palette, buttons, header, footer
    landing.css             Landing page only
    app.css                 Generator, preview, and paywall states
    auth.js                 Supabase client, session, access state
    generator.js            Form, live preview, paywall, checkout

api/
  config.js                 Serves the public Supabase URL + anon key
  checkout.js               Creates the Stripe Checkout session
  webhook.js                Records the purchase (idempotent)
  generate.js               THE PAYWALL — verifies payment, returns the block

lib/
  auth.js                   Token verification, purchase lookup
  build-block.js            Validates input and builds the block
  popup-template.js         The paid artifact. Server-side only.

supabase/schema.sql         Table + row-level security policies
PRODUCT.md                  Durable product context (users, positioning, evidence)
```

The two original files are kept at the repo root as the source of truth for the
popup's behaviour:

- `generic-circle-popup-creator-head-code.html`
- `generic-circle-popup-creator-body-code.html`

`lib/popup-template.js` was extracted verbatim from the head-code file. If you
change the popup's behaviour, change it there and re-extract, so the two don't
drift.

---

## Changing the price

Three places, and they must agree:

1. The Stripe price object (`STRIPE_PRICE_ID`) — this is the only one that
   charges money.
2. `public/index.html` — the pricing card.
3. `public/assets/generator.js` — the `$59` strings in `renderAccessState` and
   the lock overlay copy in `public/app.html`.

---

## Placeholders waiting on your assets

Both are marked with a dashed hatched box so they can't be mistaken for finished
content. Neither uses an `<img>` tag, so nothing ships as a broken-image icon if
you deploy before swapping them.

**Screenshots** — `public/index.html`, the `#results` section. Three 4:3 slots.
Replace each `<div class="placeholder">` with a real `<img>`, keep the
surrounding `<figure>`/`<figcaption>`, and rewrite the captions to describe what
you actually captured. My caption guesses are: the popup over your real feed, the
mobile view, and the Mixpanel results.

**Video walkthrough** — `public/index.html`, the `#walkthrough` section. One 16:9
slot. Drop in your embed or `<video>` and delete the placeholder div. The caption
below it currently says the tutorial is being recorded; update or remove that line
when it goes live.

Search for `class="placeholder"` to find every slot.

## Open decision: image hosting

Upload is built and works — paid accounts only, files land in the public
`popup-images` Supabase bucket, and the generated popup references them by
public URL. That URL resolves from inside a Circle community exactly like any
other external image; nothing needs to live in Circle itself.

**The unresolved question is whether hosting customer images is a business you
want to be in.** Two costs come with it:

- **Bandwidth is yours, traffic is theirs.** Every popup view pulls the image
  from your Supabase egress. A 200KB image shown to 10,000 members is 2GB
  against a 5GB free-tier month — recurring cost against one-time revenue.
- **You become a permanent dependency.** If the project pauses (the free tier
  pauses after 7 days of inactivity) or the product ever shuts down, every
  customer's popup image breaks at once, in communities you don't control.

Options when you revisit:

1. **Paste-a-link only.** Zero cost, zero dependency. Pushes the "getting a URL
   out of Circle is painful" problem back onto the customer.
2. **Keep upload, add limits.** Cap total storage per account, and monitor
   egress. Still a permanent dependency.
3. **Upload as a convenience with an explicit warning** that images are hosted
   by this tool and they may prefer their own CDN for anything long-lived.
4. **Solve the real problem** — document or automate getting an image URL out
   of Circle, which is the thing customers actually struggle with.

## Notes and things left open

- **No refund promise.** Removed at your direction. Nothing on the site now
  offers a refund, guarantee, or trial — don't let that creep back in without
  deciding on a policy first.
- **Circle independence is stated in five places:** the FAQ ("Is this made or
  supported by Circle?"), beside the pricing card, in the generator next to the
  code block, on the success page, and in both footers. If you reword it, keep
  the key point intact — buyers must not open a ticket with Circle expecting
  help.
- **No proof on the page yet.** There is deliberately no testimonial, logo, or
  usage number anywhere, because none exist. Your screenshots will be the first
  real proof.
- **Double purchase.** Guarded in two places: `/api/checkout` refuses if the
  account already owns it, and a partial unique index in the schema stops a
  second paid row.
- **Webhook redelivery.** `upsert` on `stripe_session_id` makes replays
  harmless.
