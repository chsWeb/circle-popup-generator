import { POPUP_TEMPLATE } from './popup-template.js';

const CONFIG_BLOCK_PATTERN = /    const POPUP = \{[\s\S]*?\n    \};/;

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeDomain(value) {
  const raw = text(value);
  if (!raw) return '';

  try {
    return new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Coerces raw request JSON into the exact shape the template expects. Every
 * field is re-derived here rather than trusted, because this runs on a public
 * endpoint — the browser form is a convenience, not a guarantee.
 */
export function normalizeValues(input = {}) {
  const targetMode = input.targetMode === 'specific-paths' ? 'specific-paths' : 'all-pages';

  const PLACEMENTS = ['before-title', 'after-title', 'image-left', 'image-right'];
  const imagePlacement = PLACEMENTS.includes(input.imagePlacement)
    ? input.imagePlacement
    : 'before-title';

  const targetPaths = String(input.targetPaths ?? '')
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .map(normalizePath);

  const remindDaysRaw = parseInt(input.remindDays, 10);

  return {
    rootDomain: normalizeDomain(input.rootDomain),
    targetMode,
    targetPaths,
    showTitle: String(input.showTitle ?? 'true') === 'true',
    title: text(input.title),
    subtext: text(input.subtext),
    imageUrl: text(input.imageUrl),
    imagePlacement,
    ctaText: text(input.ctaText),
    ctaUrl: text(input.ctaUrl),
    storageKey: text(input.storageKey),
    trackingName: text(input.trackingName),
    remindDays: Math.min(365, Math.max(1, Number.isFinite(remindDaysRaw) ? remindDaysRaw : 7))
  };
}

/**
 * A URL we're willing to put in the generated popup.
 *
 * Escaping at render time handles hostile input, but a URL containing a quote
 * or a space was never a real URL to begin with — rejecting it gives the user
 * a clear error instead of a popup that silently misbehaves. Defence in depth:
 * both this and the escaping have to fail before anything can be injected.
 */
function isSafeHttpsUrl(value) {
  if (!value.startsWith('https://')) return false;
  if (/["'<>\s\\]/.test(value)) return false;

  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateValues(values) {
  const warnings = [];

  if (!values.rootDomain) warnings.push('Community domain is required.');
  if (values.targetMode === 'specific-paths' && !values.targetPaths.length) {
    warnings.push('At least one target path is required when using specific paths.');
  }
  if (values.showTitle && !values.title) warnings.push('Popup title is required when the title is enabled.');
  if (!values.ctaText) warnings.push('CTA button text is required.');
  if (!isSafeHttpsUrl(values.ctaUrl)) warnings.push('Button URL should be a full https:// URL.');
  if (values.imageUrl && !isSafeHttpsUrl(values.imageUrl)) {
    warnings.push('Image link should be blank or a full https:// URL.');
  }
  if (!values.storageKey) warnings.push('Storage key is required.');
  if (!values.trackingName) warnings.push('Tracking name is required.');

  return warnings;
}

/**
 * JSON for embedding inside a <script> tag.
 *
 * JSON.stringify escapes quotes and backslashes but leaves `<` alone, so a
 * value containing `</script>` would terminate the tag early once pasted into
 * Circle — the HTML parser doesn't care that it sits inside a string literal.
 * Escaping `<` as < is inert to JavaScript and invisible to the parser.
 */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildConfig(values) {
  const pathLines = values.targetPaths.map((path) => `        ${jsonForScript(path)}`).join(',\n');

  return [
    '    const POPUP = {',
    `      rootDomain: ${jsonForScript(values.rootDomain)},`,
    `      targetMode: ${jsonForScript(values.targetMode)}, // Options: "specific-paths" or "all-pages"`,
    '      targetPaths: [',
    pathLines,
    '      ],',
    // Always excluded, regardless of targeting. These are places a popup is
    // actively unwelcome: account settings, private messages, and member
    // profile pages.
    '      excludedPathPrefixes: [',
    '        "/settings",',
    '        "/messages",',
    '        "/users"',
    '      ],',
    `      showTitle: ${values.showTitle},`,
    `      title: ${jsonForScript(values.title)},`,
    `      subtext: ${jsonForScript(values.subtext)},`,
    `      imageUrl: ${jsonForScript(values.imageUrl)},`,
    `      imagePlacement: ${jsonForScript(values.imagePlacement)}, // Options: "before-title", "after-title", "image-left", "image-right"`,
    `      ctaText: ${jsonForScript(values.ctaText)},`,
    `      ctaUrl: ${jsonForScript(values.ctaUrl)},`,
    `      storageKey: ${jsonForScript(values.storageKey)},`,
    `      trackingName: ${jsonForScript(values.trackingName)},`,
    `      remindDays: ${values.remindDays}`,
    '    };'
  ].join('\n');
}

/** Produces the paste-ready Circle popup block for a given config. */
export function buildBlock(input) {
  const values = normalizeValues(input);
  const warnings = validateValues(values);
  const block = POPUP_TEMPLATE.replace(CONFIG_BLOCK_PATTERN, () => buildConfig(values));

  return { values, warnings, block };
}
