# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS/JS in `public/`, deployed on Vercel. Serverless functions in `api/`
(Node, ESM) for Stripe checkout, the Stripe webhook, gated code generation, and
public config. Supabase for auth and the `purchases` table. No build step, no
framework — pages are served as-is and boot their JS as ES modules.

## Users

Primary user: the **solo Circle community owner**. They run one community
themselves, wear every hat, and have no developer to ask. Non-technical in the
sense that they don't write JavaScript, but comfortable pasting a block of code
into a settings box because Circle already asks them to do that. They buy tools
out of their own pocket, so price is felt personally and a subscription for a
small job is a real objection.

Secondary, not the copy's target: community managers on a team, and agencies
running Circle for multiple clients. The product serves them (the licence is
per-account and covers every community they run) but the page speaks to the solo
owner first.

## Product Purpose

Turn a form into a paste-ready popup for a Circle community. The owner fills in
targeting, headline, message, and CTA; watches a live preview; copies one
self-contained block of code; pastes it into Circle's custom code area. Success
is a working, measured popup live on their community in roughly two minutes,
with no developer involved at any point.

## Positioning

**Circle has no native popup feature.** This is not a better version of
something Circle ships — it fills a gap the platform genuinely doesn't cover.
The honest alternative for the target user is "hire a developer or don't do it."
That is the claim a neighbouring product cannot truthfully copy, because it's a
statement about the platform, not about our implementation.

Supporting mechanisms, real but secondary in the messaging hierarchy:

- Mixpanel events on view, CTA click, remind-later, and dismissal ship by
  default. Hand-rolled popups almost always ship with no measurement.
- The failure modes a naive script gets wrong are handled: per-member dismissal
  state, remind-me-later with an expiry, Circle's client-side route changes, and
  permanent exclusion of `/settings` and `/messages`.
- One payment, not a subscription.

## Operating Context

- The user works inside Circle's admin settings, in the custom code area that
  injects into the page body. Getting code in is copy and paste, not a deploy.
- Their community is at a domain like `their-community.circle.so` or a custom
  domain. The generated block verifies that hostname before doing anything.
- Campaigns are episodic: a survey, an event push, a launch. Changing campaign
  means generating a new block and pasting over the old one. The storage key is
  what makes a new campaign visible to members who dismissed the last one.
- Mixpanel may or may not be installed on their community. The popup must work
  identically either way.
- Members hit the popup mid-scroll on `/feed` or another targeted path, often on
  mobile.

## Capabilities and Constraints

Confirmed functionality:

- Targeting by community domain, plus either a list of specific paths or the
  whole community. `/settings` and `/messages` are always excluded.
- Optional headline (with preserved line breaks), body text with single-asterisk
  italic and double-asterisk bold, optional image placed before or after the
  headline, CTA label and destination URL.
- Per-member state in `localStorage`: completed, dismissed, or remind-until.
  Remind-later duration is configurable in days.
- Four Mixpanel events with campaign, path, and URL properties. Tracking never
  blocks the CTA redirect — it times out and redirects anyway.
- Survives Circle's `pushState`/`replaceState` navigation.

Commercial and technical constraints:

- $59 one-time, per account, unlimited popups and unlimited communities. No
  subscription, no per-popup fee, no expiry.
- Free tier is the full generator and live preview; only copying the generated
  code requires purchase. The paywall is enforced server-side — the popup
  template lives in `lib/popup-template.js` and never reaches the browser until
  `/api/generate` confirms a paid account.
- Accounts are email + password via Supabase. Row-level security means a user
  can only ever read their own purchase row, and only the Stripe webhook (using
  the service-role key) can write one.
- Support is a single email address: jono@wepiphany.com.
- **Image hosting is included, and is a deliberate selling point.** Paid
  accounts upload images to a public Supabase bucket; the popup references them
  by public URL, which resolves from inside a Circle community (verified: 200
  anonymously, `access-control-allow-origin: *`). Nothing needs to live in
  Circle. Paid accounts also get a library of their previous uploads. This
  closes a real Circle gap — getting a public image URL out of Circle currently
  needs a customization.
- **Bandwidth cost was modelled before committing.** At 200KB per image, a
  20,000-member community running monthly campaigns for ten years costs under
  $5 in CDN egress. Storage is negligible. The economics comfortably support
  including hosting in a one-time price.
- **Deliberately not tiered.** A premium image-hosting tier was considered and
  rejected: with no customers yet there is no basis for segmentation, a $20 gap
  does not justify two Stripe prices and permanent feature-gating, and a
  subscription tier would contradict the loudest claim on the landing page.
  Chose a single higher price instead. Revisit segmentation with real data at
  roughly 50 customers, and expect the answer to be something with ongoing
  value (multi-community management, campaign analytics) rather than storage,
  which is a cost centre rather than a value proposition.
- **Bunny CDN is a possible future backend swap**, not a product change. It
  would improve delivery and use infrastructure already paid for, but customers
  perceive no difference, so it is only worth doing if Supabase egress becomes
  material.
- **The product is independent of Circle and is not supported by Circle's
  support team.** It uses Circle's custom code area, which is a Circle feature,
  but Circle staff have no visibility into the generated block and cannot
  troubleshoot it. Every surface must say so plainly rather than letting a buyer
  discover it by opening a ticket that goes nowhere. Stated in the FAQ, beside
  pricing, in the generator next to the code block, on the success page, and in
  the footer.
- No refund policy has been established. Earlier copy promised a fix-or-refund;
  it was removed at the user's direction. Do not reintroduce a refund,
  guarantee, or trial claim without a decision.

## Brand Commitments

- Working name: **Circle Popup Generator**. Not confirmed as final.
- Support and contact identity is jono@wepiphany.com. Whether this ships under
  the Wepiphany brand or standalone is **undecided**.
- The palette and type carried over from the original generator tool — ink
  `#142033`, blue `#1f6feb`, popup brand blue `#0637f1`, Inter — because the
  marketing page and the tool should read as one product. Not yet ratified as a
  deliberate brand decision.
- Voice: plain and concrete. The product's appeal is that it removes a technical
  chore, so the writing should never reintroduce one.

## Evidence on Hand

- **The user has real screenshots and campaign results** from running popups in
  their own community, and is processing them before supply. They are not yet in
  the repository. The landing page reserves three clearly-marked placeholder
  slots for them in the `#results` section; when the real images land they are
  the strongest proof the page can carry.
- **A detailed video walkthrough is planned** but not recorded. The `#walkthrough`
  section holds a marked 16:9 placeholder for it.
- The working generator itself is evidence: the free live preview shows the real
  popup before anyone pays.
- **No customer testimonials, no named customers, no logos, no usage numbers,
  and no revenue or conversion benchmarks exist.** Future work must not
  fabricate any of these, and must not imply an install base the product does
  not have.
- Source of truth for the popup behaviour is the original pair of files, kept in
  the repository root: `generic-circle-popup-creator-head-code.html` and
  `generic-circle-popup-creator-body-code.html`.

## Product Principles

1. **The gap is the pitch.** Lead with what Circle can't do, not with a feature
   list. Everything else is support for that one claim.
2. **Prove it before charging for it.** The generator and preview stay free and
   fully functional. The purchase buys the copy button, so nobody pays on faith.
3. **Never reintroduce the chore.** Every decision — defaults, copy, error
   messages, the Circle paste instructions — is judged by whether a
   non-technical owner can get through it without asking anyone for help.
4. **Claim only what is true.** With no customers yet, the page sells on the
   mechanism and the live demo. No invented proof, ever.
5. **One payment means one payment.** No upsell path, no metering, no feature
   that quietly becomes a subscription later.

## Accessibility & Inclusion

No product-specific standard has been established. The generated popup is a
`role="dialog"` with `aria-modal` and a labelled close control, and the site
should hold an ordinary WCAG AA bar — visible focus, real labels, sufficient
contrast, and a mobile layout that works at 375px, since members frequently see
the popup on a phone.
