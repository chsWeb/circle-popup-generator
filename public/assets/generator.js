/* ---------------------------------------------------------------------------
   Generator app controller.

   The live preview is built entirely in the browser, so anyone can use the tool
   for free. The paste-ready code block is not: it comes from /api/generate,
   which checks the account's purchase before returning anything. That's what
   makes the paywall real rather than a hidden button.

   The form uses progressive disclosure — target paths, image options and
   campaign identifiers stay hidden until they're relevant, so the first view
   is short and the code preview sits nearer the fold.
   --------------------------------------------------------------------------- */

import { getAccessState, apiPost, signOut, getSupabase, getSession } from '/assets/auth.js';

const IMAGE_BUCKET = 'popup-images';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const DEFAULTS = {
  rootDomain: 'your-community.example.com',
  targetMode: 'all-pages',
  targetPaths: '/feed',
  hideTitle: false,
  title: 'Your popup title',
  subtext: 'Write the popup message here. Explain what people will get when they click the button.',
  imageUrl: '',
  imagePlacement: 'before-title',
  ctaText: 'Open link',
  ctaUrl: 'https://example.com',
  enableCampaign: false,
  storageKey: '',
  trackingName: '',
  remindDays: '7'
};

const DRAFT_KEY = 'cpg.draft.v2';
const PREVIEW_COLLAPSED_KEY = 'cpg.preview.collapsed';

// Decorative filler shown blurred behind the lock. Deliberately not the real
// template — the real one only ever exists on the server.
const LOCKED_SAMPLE = `<!-- POPUP -->
<script>
  (function () {
    const POPUP = {
      rootDomain: "your-community.example.com",
      targetMode: "all-pages",
      targetPaths: [
        "/feed"
      ],
      excludedPathPrefixes: [
        "/settings",
        "/messages",
        "/users"
      ],
      showTitle: true,
      title: "Your popup title",
      subtext: "Write the popup message here.",
      imageUrl: "",
      imagePlacement: "before-title",
      ctaText: "Open link",
      ctaUrl: "https://example.com",
      storageKey: "circle-popup-example",
      trackingName: "circle-popup",
      remindDays: 7
    };

    function normalizePath(path) {
      return path.replace(/\\/+$/, "") || "/";
    }

    function isTargetPage() {
      if (window.location.hostname !== POPUP.rootDomain) return false;
      if (isExcludedPage()) return false;
      if (POPUP.targetMode === "all-pages") return true;
      return POPUP.targetPaths.some(function (path) {
        return normalizePath(window.location.pathname) === normalizePath(path);
      });
    }

    function shouldShowPopup() {
      const saved = getSavedState();
      if (!isTargetPage()) return false;
      if (saved.completed || saved.dismissed) return false;
      return true;
    }
  })();
</script>`;

/* --- element handles -------------------------------------------------------- */

const $ = (id) => document.getElementById(id);

const els = {
  form: $('popup-generator-form'),
  warnings: $('generator-warnings'),

  targetPathsField: $('target-paths-field'),
  targetPathsInput: $('targetPaths'),
  titleField: $('title-field'),
  hideTitle: $('hideTitle'),

  imageEmpty: $('image-empty'),
  imageChoose: $('image-choose'),
  imageAdded: $('image-added'),
  addImage: $('add-image'),
  cancelImage: $('cancel-image'),
  removeImage: $('remove-image'),
  imageUrl: $('imageUrl'),
  imageSources: $('image-sources'),
  imageUpload: $('image-source-upload'),
  imageFile: $('image-file'),
  imageUploadStatus: $('image-upload-status'),
  imageUrlHelp: $('image-url-help'),
  imageLibrary: $('image-library'),
  imageLibraryGrid: $('image-library-grid'),
  imageThumb: $('image-thumb'),
  imageChipUrl: $('image-chip-url'),
  imagePlacement: $('imagePlacement'),

  enableCampaign: $('enableCampaign'),
  campaignFields: $('campaign-fields'),
  storageKey: $('storageKey'),
  trackingName: $('trackingName'),

  codeCard: $('code-card'),
  code: $('generated-code'),
  codeCaption: $('code-caption'),
  codeToolbarLabel: $('code-toolbar-label'),
  copyInline: $('copy-code-inline'),
  copyMain: $('copy-generated-block'),
  actionHint: $('action-hint'),
  reset: $('reset-generator'),
  lockActions: $('lock-actions'),

  navAuth: $('nav-auth'),
  alert: $('app-alert'),
  notice: $('app-notice'),

  previewWrap: $('popup-preview-wrap'),
  previewToggle: $('preview-toggle'),
  previewPeek: $('popup-preview-peek'),
  previewCard: document.querySelector('.popup-preview-card'),
  previewTitle: $('popup-preview-title'),
  previewSubtext: $('popup-preview-subtext'),
  previewPrimary: $('popup-preview-primary'),
  previewImageSide: $('popup-preview-image-side'),
  previewImageBefore: $('popup-preview-image-before'),
  previewImageAfter: $('popup-preview-image-after')
};

let access = { signedIn: false, purchased: false };

// Generated once per draft and kept stable. The storage key is what remembers
// who dismissed a popup, so it must always have a value — even when the user
// never opens the campaign section — and it must not drift as they edit copy.
let autoIds = null;

/* --- small helpers ---------------------------------------------------------- */

function showAlert(message) {
  els.notice.classList.remove('is-visible');
  els.alert.textContent = message;
  els.alert.classList.add('is-visible');
}

function showNotice(message) {
  els.alert.classList.remove('is-visible');
  els.notice.textContent = message;
  els.notice.classList.add('is-visible');
}

function clearMessages() {
  els.alert.classList.remove('is-visible');
  els.notice.classList.remove('is-visible');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function applyBasicMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>');
}

function formatLineBreaks(value) {
  return escapeHtml(value).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
}

function formatParagraphs(value) {
  const normalized = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${applyBasicMarkdown(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function makeAutoIds() {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { storageKey: `circle-popup-${suffix}`, trackingName: 'circle-popup' };
}

async function copyToClipboard(text, button) {
  const original = button.textContent;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = original; }, 1600);
}

/* --- auto-growing textareas -------------------------------------------------- */

// CSS field-sizing does this natively where supported; this is the fallback.
const NEEDS_AUTOGROW_FALLBACK =
  !(window.CSS && CSS.supports && CSS.supports('field-sizing', 'content'));

function autoGrowAll() {
  if (!NEEDS_AUTOGROW_FALLBACK) return;
  els.form.querySelectorAll('textarea').forEach((element) => {
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 420)}px`;
  });
}

/* --- form state ------------------------------------------------------------- */

function readValues() {
  const data = new FormData(els.form);
  const text = (name) => String(data.get(name) ?? '');

  const usingCampaign = els.enableCampaign.checked;
  const storageKey = usingCampaign ? text('storageKey').trim() : '';
  const trackingName = usingCampaign ? text('trackingName').trim() : '';

  return {
    rootDomain: text('rootDomain'),
    targetMode: text('targetMode') || 'all-pages',
    targetPaths: text('targetPaths'),
    hideTitle: els.hideTitle.checked,
    showTitle: els.hideTitle.checked ? 'false' : 'true',
    title: text('title'),
    subtext: text('subtext'),
    imageUrl: text('imageUrl').trim(),
    imagePlacement: text('imagePlacement') || 'before-title',
    ctaText: text('ctaText'),
    ctaUrl: text('ctaUrl'),
    enableCampaign: usingCampaign,
    storageKey: storageKey || autoIds.storageKey,
    trackingName: trackingName || autoIds.trackingName,
    remindDays: text('remindDays')
  };
}

function writeValues(values) {
  const set = (id, value) => {
    const field = $(id);
    if (field) field.value = value;
  };

  set('rootDomain', values.rootDomain ?? DEFAULTS.rootDomain);
  set('targetPaths', values.targetPaths ?? DEFAULTS.targetPaths);
  set('title', values.title ?? DEFAULTS.title);
  set('subtext', values.subtext ?? DEFAULTS.subtext);
  set('ctaText', values.ctaText ?? DEFAULTS.ctaText);
  set('ctaUrl', values.ctaUrl ?? DEFAULTS.ctaUrl);
  set('imageUrl', values.imageUrl ?? '');
  set('imagePlacement', values.imagePlacement || DEFAULTS.imagePlacement);
  set('remindDays', values.remindDays ?? DEFAULTS.remindDays);

  const mode = values.targetMode === 'specific-paths' ? 'specific-paths' : 'all-pages';
  const radio = els.form.querySelector(`input[name="targetMode"][value="${mode}"]`);
  if (radio) radio.checked = true;

  els.hideTitle.checked = Boolean(values.hideTitle);
  els.enableCampaign.checked = Boolean(values.enableCampaign);

  if (values.enableCampaign) {
    set('storageKey', values.storageKey || autoIds.storageKey);
    set('trackingName', values.trackingName || autoIds.trackingName);
  }
}

function saveDraft(values) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...values, autoIds }));
  } catch {
    /* private browsing or a full quota — a lost draft isn't worth an error */
  }
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/* --- validation (mirrors the server, for instant feedback) ------------------ */

function validate(values) {
  const warnings = [];
  const paths = values.targetPaths.split(',').map((path) => path.trim()).filter(Boolean);

  if (!values.rootDomain.trim()) warnings.push('Community domain is required.');
  if (values.targetMode === 'specific-paths' && !paths.length) {
    warnings.push('Add at least one page, or switch to showing the popup everywhere.');
  }
  if (values.showTitle === 'true' && !values.title.trim()) {
    warnings.push('Add a popup title, or tick "Hide the popup title".');
  }
  if (!values.ctaText.trim()) warnings.push('Button text is required.');
  if (!values.ctaUrl.startsWith('https://')) warnings.push('Button URL should be a full https:// URL.');
  if (values.imageUrl && !values.imageUrl.startsWith('https://')) {
    warnings.push('Image link should be a full https:// URL.');
  }
  if (values.enableCampaign && !values.storageKey.trim()) warnings.push('Storage key is required.');
  if (values.enableCampaign && !values.trackingName.trim()) warnings.push('Tracking name is required.');

  return warnings;
}

function renderWarnings(warnings) {
  els.warnings.innerHTML = '';

  warnings.forEach((warning) => {
    const item = document.createElement('li');
    item.textContent = warning;
    els.warnings.appendChild(item);
  });

  els.warnings.classList.toggle('is-visible', warnings.length > 0);
}

/* --- progressive disclosure -------------------------------------------------- */

function renderDisclosure(values) {
  els.targetPathsField.classList.toggle('is-hidden', values.targetMode !== 'specific-paths');
  els.titleField.classList.toggle('is-hidden', values.hideTitle);
  els.campaignFields.classList.toggle('is-hidden', !values.enableCampaign);

  const hasImage = Boolean(values.imageUrl);
  const choosing = !els.imageChoose.classList.contains('is-hidden');

  els.imageEmpty.classList.toggle('is-hidden', hasImage || choosing);
  els.imageAdded.classList.toggle('is-hidden', !hasImage);

  if (hasImage) {
    els.imageThumb.src = values.imageUrl;
    els.imageChipUrl.textContent = values.imageUrl;
  }
}

/* --- live preview ----------------------------------------------------------- */

/**
 * The preview is pinned above the form on narrow screens. Collapsing it buys
 * back vertical space when a phone keyboard is up; the strip then names the
 * popup instead of going blank, so it still reports what is being edited.
 *
 * The collapsed styling lives entirely inside a max-width media query, so a
 * preview collapsed on a phone reappears by itself on a wide screen.
 */
function setPreviewCollapsed(collapsed) {
  els.previewWrap.classList.toggle('is-collapsed', collapsed);
  els.previewToggle.setAttribute('aria-expanded', String(!collapsed));
  els.previewToggle.textContent = collapsed ? 'Show' : 'Hide';

  try {
    localStorage.setItem(PREVIEW_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* private browsing — the preview just defaults to open next time */
  }
}

function loadPreviewCollapsed() {
  try {
    return localStorage.getItem(PREVIEW_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function renderPreviewPeek(values) {
  const showTitle = values.showTitle === 'true';
  const summary = (showTitle ? values.title : values.subtext) || values.subtext;

  els.previewPeek.textContent =
    String(summary).replace(/\s+/g, ' ').trim() || 'Untitled popup';
}

function renderPreview(values) {
  const showTitle = values.showTitle === 'true';

  renderPreviewPeek(values);

  els.previewTitle.innerHTML = formatLineBreaks(values.title || 'Your popup title');
  els.previewTitle.style.display = showTitle ? '' : 'none';
  els.previewSubtext.innerHTML = formatParagraphs(values.subtext || 'Write the popup message here.');
  els.previewPrimary.textContent = values.ctaText || 'Open link';

  const placement = values.imagePlacement;
  const hasImage = Boolean(values.imageUrl);
  const isSide = hasImage && (placement === 'image-left' || placement === 'image-right');

  els.previewCard.classList.toggle('is-image-side', isSide);
  els.previewCard.classList.toggle('is-image-right', hasImage && placement === 'image-right');
  els.previewCard.classList.toggle(
    'is-image-before-title',
    hasImage && placement === 'before-title'
  );

  [els.previewImageSide, els.previewImageBefore, els.previewImageAfter].forEach((image) => {
    image.removeAttribute('src');
    image.style.display = 'none';
  });

  if (!hasImage) return;

  const active = isSide
    ? els.previewImageSide
    : placement === 'after-title'
      ? els.previewImageAfter
      : els.previewImageBefore;

  active.src = values.imageUrl;
  active.style.display = 'block';
}

/** Runs on every keystroke. Cheap, and never touches the network. */
function refresh() {
  const values = readValues();

  renderDisclosure(values);
  renderPreview(values);
  renderWarnings(validate(values));
  autoGrowAll();
  saveDraft(values);

  // Any edit invalidates a previously fetched block.
  if (els.codeCard.dataset.fresh === 'true') {
    els.codeCard.dataset.fresh = 'false';
    if (access.purchased) {
      els.codeToolbarLabel.textContent = 'Settings changed — press Copy to regenerate';
    }
  }

  return values;
}

/* --- image section ----------------------------------------------------------- */

function openImageChooser() {
  els.imageChoose.classList.remove('is-hidden');
  els.imageEmpty.classList.add('is-hidden');
  if (access.purchased) loadImageLibrary();
  els.imageUrl.focus();
}

/**
 * Re-using an image you uploaded before. Circle gives community owners no easy
 * way back to an image they've already used, which is the friction this closes.
 */
async function loadImageLibrary() {
  const session = await getSession();
  if (!session) return;

  try {
    const response = await fetch('/api/images', {
      headers: { Authorization: `Bearer ${session.access_token}` }
    });
    if (!response.ok) return;

    const { images } = await response.json();
    renderImageLibrary(images || []);
  } catch (error) {
    console.warn('could not load image library', error);
  }
}

function renderImageLibrary(images) {
  els.imageLibraryGrid.replaceChildren();
  els.imageLibrary.classList.toggle('is-hidden', images.length === 0);
  if (!images.length) return;

  for (const image of images) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'image-library__item';
    item.title = 'Use this image';

    const thumb = document.createElement('img');
    thumb.src = image.url;
    thumb.alt = '';
    thumb.loading = 'lazy';
    item.appendChild(thumb);

    item.addEventListener('click', () => {
      els.imageUrl.value = image.url;
      closeImageChooser();
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'image-library__remove';
    remove.textContent = '×';
    remove.title = 'Delete this image';
    remove.setAttribute('aria-label', 'Delete this image');

    remove.addEventListener('click', async (event) => {
      // Sits inside the pick button, so stop the click selecting it too.
      event.stopPropagation();
      await deleteLibraryImage(image, item);
    });

    item.appendChild(remove);
    els.imageLibraryGrid.appendChild(item);
  }
}

async function deleteLibraryImage(image, item) {
  const session = await getSession();
  if (!session) return;

  item.disabled = true;

  try {
    const response = await fetch(`/api/images?path=${encodeURIComponent(image.path)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.access_token}` }
    });

    if (!response.ok) throw new Error('delete failed');

    item.remove();
    if (!els.imageLibraryGrid.children.length) els.imageLibrary.classList.add('is-hidden');

    // If the deleted image was the one in use, clear it rather than leaving a
    // popup pointing at a URL that now 404s.
    if (els.imageUrl.value === image.url) {
      els.imageUrl.value = '';
      refresh();
    }
  } catch (error) {
    console.warn('could not delete image', error);
    item.disabled = false;
    setUploadStatus('Could not delete that image. Try again.', true);
  }
}

function closeImageChooser() {
  els.imageChoose.classList.add('is-hidden');
  refresh();
}

function clearImage() {
  els.imageUrl.value = '';
  els.imageFile.value = '';
  els.imageChoose.classList.add('is-hidden');
  setUploadStatus('');
  refresh();
}

function setUploadStatus(message, isError = false) {
  els.imageUploadStatus.textContent = message;
  els.imageUploadStatus.classList.toggle('is-hidden', !message);
  els.imageUploadStatus.style.color = isError ? '#8a1f17' : '';
}

/**
 * Uploads to Supabase Storage straight from the browser. The bucket's policy
 * only accepts inserts from a paid account writing into a folder named after
 * its own user id, so the paywall holds even if someone calls the storage API
 * directly — hiding the button is courtesy, not the control.
 */
async function uploadImageFile(file) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    setUploadStatus('That file type is not supported. Use a JPG, PNG, WebP or GIF.', true);
    return;
  }

  if (file.size > MAX_IMAGE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    setUploadStatus(`That image is ${mb}MB. The limit is 2MB — try resizing it first.`, true);
    return;
  }

  setUploadStatus('Uploading…');
  els.imageUpload.disabled = true;

  try {
    const supabase = await getSupabase();
    const extension = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${access.user.id}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

    const { error } = await supabase.storage
      .from(IMAGE_BUCKET)
      .upload(path, file, { cacheControl: '31536000', upsert: false });

    if (error) throw error;

    const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);

    els.imageUrl.value = data.publicUrl;
    setUploadStatus('');
    closeImageChooser();
  } catch (error) {
    console.error('image upload failed', error);
    setUploadStatus(error.message || 'Upload failed. Paste an image link instead.', true);
  } finally {
    els.imageUpload.disabled = false;
    els.imageFile.value = '';
  }
}

/* --- paywall + account state ------------------------------------------------ */

function button(label, variant, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `btn btn--${variant} btn--sm`;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

function link(label, variant, href) {
  const element = document.createElement('a');
  element.className = `btn btn--${variant} btn--sm`;
  element.href = href;
  element.textContent = label;
  return element;
}

async function startCheckout(trigger) {
  clearMessages();

  if (!access.signedIn) {
    window.location.href = '/login?mode=signup&next=/app';
    return;
  }

  const originalLabel = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = 'Opening checkout…';

  const result = await apiPost('/api/checkout');

  if (result.alreadyPurchased) {
    showNotice('You already have access — reloading.');
    window.location.reload();
    return;
  }

  if (!result.ok || !result.url) {
    showAlert(result.error || 'Could not start checkout. Please try again.');
    trigger.disabled = false;
    trigger.textContent = originalLabel;
    return;
  }

  window.location.href = result.url;
}

/**
 * Keeps the primary button honest. Its label always states what the next click
 * really does, so nobody presses "Copy" and lands somewhere they didn't expect.
 */
function renderPrimaryAction() {
  // Upload is a paid feature; free accounts paste a link instead. Set before
  // the early return below, or paid accounts would never see the button.
  els.imageSources.classList.toggle('is-hidden', !access.purchased);
  els.imageUrlHelp.textContent = access.purchased
    ? 'Or paste a link to an image that is already online.'
    : 'Paste a link to an image that is already online. Uploading from your computer unlocks with purchase.';

  if (access.purchased) {
    els.copyMain.textContent = 'Copy generated code';
    els.actionHint.classList.remove('is-visible');
    return;
  }

  els.copyMain.textContent = access.signedIn ? 'Unlock code — $59' : 'Create account to unlock code';
  els.actionHint.textContent = access.signedIn
    ? 'One payment of $59 unlocks unlimited popups for this account, forever. Your settings are kept while you check out.'
    : 'Building and previewing is free. Getting the code to paste into Circle is a one-time $59 — your settings are kept while you sign up.';
  els.actionHint.classList.add('is-visible');
}

function setNavSignOut() {
  els.navAuth.textContent = 'Sign out';
  els.navAuth.href = '#';
  els.navAuth.onclick = (event) => { event.preventDefault(); signOut(); };
}

/**
 * Account state is communicated by the primary button and the code lock alone.
 * There is deliberately no status banner above the form — it restated what
 * those already say, and pushed the tool itself further down the page.
 */
function renderAccessState() {
  els.lockActions.replaceChildren();
  renderPrimaryAction();

  if (access.purchased) {
    els.codeCard.classList.remove('is-locked');
    els.codeCaption.textContent = 'Copy this block and paste it into your Circle custom code area.';
    setNavSignOut();
    return;
  }

  els.codeCard.classList.add('is-locked');

  if (access.signedIn) {
    els.lockActions.append(button('Unlock for $59', 'primary', (event) => startCheckout(event.currentTarget)));
    setNavSignOut();
  } else {
    els.lockActions.append(
      link('Create account and unlock', 'primary', '/login?mode=signup&next=/app'),
      link('I already have an account', 'secondary', '/login?next=/app')
    );
    els.navAuth.textContent = 'Sign in';
    els.navAuth.href = '/login?next=/app';
  }
}

/* --- generating the real block ---------------------------------------------- */

async function fetchAndCopy(trigger) {
  clearMessages();

  const values = refresh();
  const warnings = validate(values);

  if (warnings.length) {
    showAlert('Fix the highlighted fields before copying.');
    return;
  }

  if (!access.purchased) {
    await startCheckout(trigger);
    return;
  }

  const originalLabel = trigger.textContent;
  trigger.disabled = true;
  trigger.textContent = 'Generating…';

  const result = await apiPost('/api/generate', values);

  trigger.disabled = false;
  trigger.textContent = originalLabel;

  if (result.needsAuth) {
    window.location.href = '/login?next=/app';
    return;
  }

  if (result.needsPurchase) {
    access.purchased = false;
    renderAccessState();
    showAlert('This account has not purchased access yet.');
    return;
  }

  if (!result.ok || !result.block) {
    if (result.warnings?.length) renderWarnings(result.warnings);
    showAlert(result.error || 'Could not generate the code block.');
    return;
  }

  els.code.textContent = result.block;
  els.codeCard.dataset.fresh = 'true';
  els.codeToolbarLabel.textContent = 'Generated block';

  await copyToClipboard(result.block, trigger);
  showNotice('Copied. Paste it into your Circle custom code area and save.');
}

/* --- boot -------------------------------------------------------------------- */

function handleReturnFromCheckout() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('checkout') === 'cancelled') {
    showAlert('Checkout was cancelled. Your settings are still here whenever you want to finish.');
    window.history.replaceState({}, '', '/app');
  }

  if (params.get('purchased') === '1') {
    showNotice('Payment received — your code is unlocked. Press Copy to generate your block.');
    window.history.replaceState({}, '', '/app');
  }
}

async function init() {
  els.code.textContent = LOCKED_SAMPLE;
  $('year').textContent = new Date().getFullYear();

  const draft = loadDraft();
  autoIds = draft?.autoIds || makeAutoIds();
  if (draft) writeValues(draft);

  els.form.addEventListener('input', refresh);
  els.form.addEventListener('change', refresh);
  els.form.addEventListener('submit', (event) => event.preventDefault());

  setPreviewCollapsed(loadPreviewCollapsed());
  els.previewToggle.addEventListener('click', () => {
    setPreviewCollapsed(!els.previewWrap.classList.contains('is-collapsed'));
  });

  els.addImage.addEventListener('click', openImageChooser);
  els.cancelImage.addEventListener('click', clearImage);
  els.removeImage.addEventListener('click', clearImage);
  els.imageUpload.addEventListener('click', () => els.imageFile.click());
  els.imageFile.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) uploadImageFile(file);
  });
  els.imageUrl.addEventListener('blur', () => {
    if (els.imageUrl.value.trim()) closeImageChooser();
  });

  // Prefill the campaign inputs the first time they're revealed, so the values
  // shown match the ones the generated code will actually carry.
  els.enableCampaign.addEventListener('change', () => {
    if (!els.enableCampaign.checked) return;
    if (!els.storageKey.value.trim()) els.storageKey.value = autoIds.storageKey;
    if (!els.trackingName.value.trim()) els.trackingName.value = autoIds.trackingName;
    refresh();
  });

  els.copyMain.addEventListener('click', (event) => fetchAndCopy(event.currentTarget));
  els.copyInline.addEventListener('click', (event) => fetchAndCopy(event.currentTarget));

  els.reset.addEventListener('click', () => {
    autoIds = makeAutoIds();
    writeValues(DEFAULTS);
    els.storageKey.value = '';
    els.trackingName.value = '';
    els.imageChoose.classList.add('is-hidden');
    els.code.textContent = LOCKED_SAMPLE;
    els.codeCard.dataset.fresh = 'false';
    clearMessages();
    refresh();
  });

  refresh();
  handleReturnFromCheckout();

  try {
    access = await getAccessState();
  } catch (error) {
    console.warn('could not resolve account state', error);
    access = { signedIn: false, purchased: false };
  }

  renderAccessState();
}

init();
