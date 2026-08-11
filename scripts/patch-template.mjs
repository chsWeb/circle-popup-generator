/**
 * One-off migration: adds image-left / image-right layout support to the
 * generated popup. Kept in the repo as the record of how the template was
 * changed, since the template itself ships as an escaped string.
 *
 * Safe to re-run: every substitution is checked, and a step that no longer
 * matches is reported rather than silently skipped.
 *
 * Note the \${ escapes below — those braces belong to the generated script's
 * own template literals, not to this file's.
 */

import { POPUP_TEMPLATE } from '../lib/popup-template.js';
import { writeFileSync } from 'node:fs';

let t = POPUP_TEMPLATE;
const steps = [];

function sub(name, find, replace) {
  if (t.includes(replace)) return steps.push([name, 'already applied']);
  if (!t.includes(find)) return steps.push([name, 'NOT FOUND']);
  t = t.replace(find, replace);
  steps.push([name, 'ok']);
}

/* 1 — side-layout helper, and a guard that understands it */
sub(
  'guard',
  `    function getImageMarkup(position) {
      if (!POPUP.imageUrl || POPUP.imagePlacement !== position) return "";`,
  `    function isSideLayout() {
      return Boolean(POPUP.imageUrl) &&
        (POPUP.imagePlacement === "image-left" || POPUP.imagePlacement === "image-right");
    }

    function getImageMarkup(position) {
      if (!POPUP.imageUrl) return "";

      if (position === "side") {
        if (!isSideLayout()) return "";
      } else if (isSideLayout() || POPUP.imagePlacement !== position) {
        return "";
      }`
);

/* 2 — wrap the body so the image can sit beside the text */
sub(
  'markup',
  `        <button id="circle-popup-close" type="button" aria-label="Close popup">&times;</button>
        \${getImageMarkup("before-title")}
        \${getTitleMarkup()}
        \${getImageMarkup("after-title")}
        \${getSubtextMarkup()}
        <div id="circle-popup-actions">
          <button id="circle-popup-primary" type="button">\${escapeHtml(POPUP.ctaText)}</button>
          <button id="circle-popup-secondary" type="button">Remind me later</button>
        </div>`,
  `        <button id="circle-popup-close" type="button" aria-label="Close popup">&times;</button>
        <div id="circle-popup-layout">
          \${getImageMarkup("side")}
          <div id="circle-popup-column">
            \${getImageMarkup("before-title")}
            \${getTitleMarkup()}
            \${getImageMarkup("after-title")}
            \${getSubtextMarkup()}
            <div id="circle-popup-actions">
              <button id="circle-popup-primary" type="button">\${escapeHtml(POPUP.ctaText)}</button>
              <button id="circle-popup-secondary" type="button">Remind me later</button>
            </div>
          </div>
        </div>`
);

/* 3 — layout classes on the card */
sub(
  'classes',
  `      if (POPUP.imageUrl && POPUP.imagePlacement === "before-title") {
        popup.querySelector("#circle-popup-card").classList.add("circle-popup-card--image-before-title");
      }`,
  `      const card = popup.querySelector("#circle-popup-card");

      if (POPUP.imageUrl && POPUP.imagePlacement === "before-title") {
        card.classList.add("circle-popup-card--image-before-title");
      }

      if (isSideLayout()) {
        card.classList.add("circle-popup-card--image-side");
        if (POPUP.imagePlacement === "image-right") {
          card.classList.add("circle-popup-card--image-right");
        }
      }`
);

/* 4 — desktop CSS for the side layouts */
sub(
  'css',
  `      #circle-popup h2 {
        margin: 0 32px 8px 0;`,
  `      #circle-popup-column {
        min-width: 0;
      }

      #circle-popup-card.circle-popup-card--image-side {
        width: min(100%, 620px);
      }

      #circle-popup-card.circle-popup-card--image-side #circle-popup-layout {
        display: flex;
        align-items: center;
        gap: 20px;
      }

      #circle-popup-card.circle-popup-card--image-right #circle-popup-layout {
        flex-direction: row-reverse;
      }

      #circle-popup-card.circle-popup-card--image-side #circle-popup-image {
        width: 40%;
        flex: 0 0 auto;
        max-height: none;
        align-self: stretch;
        margin-bottom: 0;
      }

      #circle-popup h2 {
        margin: 0 32px 8px 0;`
);

/* 5 — stack side layouts on phones */
sub(
  'mobile',
  `      @media (max-width: 480px) {
        #circle-popup-card {
          padding: 22px;
        }`,
  `      @media (max-width: 480px) {
        #circle-popup-card {
          padding: 22px;
        }

        #circle-popup-card.circle-popup-card--image-side #circle-popup-layout {
          display: block;
        }

        #circle-popup-card.circle-popup-card--image-side #circle-popup-image {
          width: 100%;
          margin-bottom: 18px;
        }`
);

/* 6 — escape the image URL before it lands in an HTML attribute.
       Unescaped, a URL containing a double quote closes the src attribute and
       everything after it becomes live markup. Every other interpolated value
       already goes through escapeHtml; this one was missed. */
sub(
  'image url escaping',
  `        src="\${POPUP.imageUrl}"`,
  `        src="\${escapeHtml(POPUP.imageUrl)}"`
);

/* 7 — defer route detection to a community's own route observer when one
       exists, instead of patching the History API a second time.

       Deliberately additive rather than a replacement. A community running a
       shared observer (Internal Audit Collective dispatches `iac:routechange`)
       gets a single owner of navigation. Every other community has no such
       observer, and removing the fallback would leave their popup evaluating
       once on load and never again as members navigate — a silent regression
       in the behaviour the product is sold on. */
sub(
  'route observer',
  `    function watchForCircleNavigation() {
      const originalPushState = history.pushState;`,
  `    function watchForCircleNavigation() {
      // Preferred path: the community's head code owns SPA route detection and
      // announces each navigation. Harmless when nothing ever dispatches it.
      window.addEventListener("iac:routechange", function () {
        setTimeout(showPopup, 250);
      });

      // An observer is already watching navigation — don't wrap the History
      // API on top of it. One owner is enough.
      if (window.__iacRouteObserverInstalled || window.__circleRouteObserverInstalled) return;

      const originalPushState = history.pushState;`
);

/* 8 — survive a slow-loading Mixpanel instead of silently discarding events.

       Found in production: a community whose head code initialised Mixpanel
       before the library had loaded. The popup rendered for thousands of
       members, but `window.mixpanel` appeared later than the old five-second
       window, so almost every view event was dropped without a trace. Two
       members in a month happened to win the race.

       The wait is now long enough to cover a slow third-party load, and a
       give-up is announced rather than swallowed, so the next person to hit
       this can see it in the console instead of inferring it from missing
       data. */
sub(
  'mixpanel wait',
  `        if (Date.now() - startedAt >= timeoutMs) return;
        setTimeout(check, 100);
      })();
    }

    function trackPopupEvent(eventName, extraProperties) {
      waitForMixpanel(function (tracker) {
        tracker.track(eventName, getTrackingProperties(extraProperties));
      }, 5000);
    }`,
  `        if (Date.now() - startedAt >= timeoutMs) {
          if (typeof onTimeout === "function") onTimeout();
          return;
        }

        setTimeout(check, 100);
      })();
    }

    function trackPopupEvent(eventName, extraProperties) {
      waitForMixpanel(function (tracker) {
        tracker.track(eventName, getTrackingProperties(extraProperties));
      }, 20000, function () {
        console.warn(
          "[circle-popup] Mixpanel never became available; dropped event: " + eventName +
          ". The popup still works, but this view is missing from your analytics."
        );
      });
    }`
);

sub(
  'mixpanel wait signature',
  `    function waitForMixpanel(callback, timeoutMs) {`,
  `    function waitForMixpanel(callback, timeoutMs, onTimeout) {`
);

for (const [name, status] of steps) {
  console.log(`  ${status === 'ok' ? 'ok  ' : status === 'already applied' ? 'skip' : 'FAIL'}  ${name}`);
}

if (steps.some(([, status]) => status === 'NOT FOUND')) process.exit(1);

writeFileSync(
  new URL('../lib/popup-template.js', import.meta.url),
  '// The paid artifact. Lives server-side only so the paywall is enforced,\n' +
    '// not merely hidden. Extracted from the original head-code file, then\n' +
    '// extended to support image-left / image-right layouts.\n' +
    '// See scripts/patch-template.mjs for how the extension was applied.\n' +
    'export const POPUP_TEMPLATE = ' +
    JSON.stringify(t) +
    ';\n'
);

console.log(`\n  template written (${t.length} chars)`);
