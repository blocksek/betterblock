// BetterBlock content script (runs at document_start, top frame only).
//
// Three tiers of blocking, cheapest first:
//   1. Baseline cosmetic CSS for unambiguous ad containers — applied
//      instantly, before first paint.
//   2. Heuristic candidate discovery: DOM elements that *might* be ads
//      (suspicious ids/classes, third-party iframes, IAB banner sizes,
//      floating overlays).
//   3. The background's local LLM classifies those candidates; elements
//      judged ads above the confidence threshold get hidden.
//
// Plus user-driven hiding: an element picker (Safari-style "hide element")
// whose selections persist as per-site rules, applied on every page load
// independently of the protection toggle.
//
// Nothing here touches the network. Candidate features sent to the
// background stay inside the extension on this machine.

(() => {
  'use strict';

  const PAGE_HOST = location.hostname;
  const MAX_PER_SCAN = 24;
  const MAX_PER_PAGE = 80;
  const SCAN_DEBOUNCE_MS = 600;

  // --- Tier 1: baseline cosmetic selectors (high precision only) ----------
  const BASELINE_SELECTORS = [
    'ins.adsbygoogle',
    'iframe[src*="doubleclick.net"]',
    'iframe[src*="googlesyndication.com"]',
    'iframe[src*="adnxs.com"]',
    'iframe[src*="amazon-adsystem.com"]',
    'iframe[id^="google_ads_iframe"]',
    'div[id^="div-gpt-ad"]',
    'div[id^="dfp-ad"]',
    '[id^="taboola-"]',
    '.OUTBRAIN',
    '.trc_related_container',
    'a[href^="https://googleads.g.doubleclick.net/"]',
    '[data-ad-slot]',
    '[data-google-query-id]',
  ];

  // --- Heuristic vocabulary ------------------------------------------------
  const STRONG_AD_RE = /(^|[^a-z])(ad|ads|advert|advertisement|adsense|adslot|ad-slot|adbox|ad-unit|adunit|dfp|gpt|doubleclick|sponsored|sponsor)([^a-z]|$)/i;
  const WEAK_AD_RE = /(banner|promo|promotion|partner-content|paid-content|commercial|marketing|mrec|leaderboard|skyscraper|taboola|outbrain|revcontent|mgid|native-ad)/i;
  const AD_HOST_RE = /(doubleclick|googlesyndication|adsystem|adserver|adservice|adnxs|adsrvr|criteo|taboola|outbrain|pubmatic|rubicon|openx|smartadserver|teads|revcontent|mgid|zedo|adform|yieldmo|adroll)/i;
  const AD_TEXT_RE = /^(sponsored|advertisement|advertising|paid partnership|paid post|promoted|ad\b|реклама|anzeige|publicité|广告)/i;
  const IAB_SIZES = new Set([
    '300x250', '336x280', '728x90', '970x90', '970x250', '160x600',
    '120x600', '300x600', '320x50', '320x100', '468x60', '250x250',
    '200x200', '234x60', '180x150', '125x125', '300x1050', '930x180',
  ]);

  // --- Cookie-consent prompt vocabulary --------------------------------------
  // Known consent-management platforms: container selector + their reject
  // button. `shadow: true` means the CMP renders inside a shadow root.
  const KNOWN_CMPS = [
    { sel: '#onetrust-banner-sdk, #onetrust-consent-sdk', reject: '#onetrust-reject-all-handler' },
    { sel: '#CybotCookiebotDialog', reject: '#CybotCookiebotDialogBodyButtonDecline' },
    { sel: '#qc-cmp2-container, .qc-cmp2-container', reject: null },
    { sel: '#didomi-host', reject: '#didomi-notice-disagree-button, .didomi-continue-without-agreeing' },
    { sel: '[id^="sp_message_container"]', reject: null },
    { sel: '#usercentrics-root', reject: '[data-testid="uc-deny-all-button"]', shadow: true },
    { sel: '.fc-consent-root', reject: '.fc-cta-do-not-consent' },
    { sel: '.osano-cm-window', reject: '.osano-cm-denyAll' },
    { sel: '.cky-consent-container', reject: '.cky-btn-reject' },
    { sel: '#cookiescript_injected', reject: '#cookiescript_reject' },
    { sel: '.cc-window', reject: '.cc-deny, .cc-btn.cc-deny' },
    { sel: '#truste-consent-track', reject: '#truste-consent-required' },
    { sel: '#cmpbox', reject: '.cmpboxbtnno' },
  ];
  const COOKIE_WORD_RE = /cookie/i;
  const CONSENT_WORD_RE = /(consent|accept|agree|privacy|gdpr|akzept|zustimm|einwillig|aceptar|consentimiento|accetta|consenso|accepteren|toestemming|akceptuj|zgod|aceitar|consentement|accepter)/i;
  const REJECT_TEXT_RE = /^\s*(reject|decline|refuse|deny|disagree|no,?\s*thanks|continue without|(use|allow)?\s*(only\s+)?(strictly\s+)?(necessary|essential)(\s+(cookies?|only))?|necessary only|essential only|(alle\s+)?ablehnen|nur (notwendige|erforderliche)|weiter ohne|tout refuser|refuser|continuer sans|rechazar|solo (necesarias|esenciales)|rifiuta( tutto)?|solo essenziali|(alles\s+)?weigeren|alleen noodzakelijk|odrzuć|recusar|apenas necessári|avvis alle|avslå|neka alla|hylkää)/i;
  const NOT_REJECT_RE = /(settings|manage|preferen|customi[sz]e|options|choices|more info|learn more|read more|policy|purposes|partners|einstellungen|verwalten|paramètres|gérer|configura|impostazioni|instellingen)/i;

  let active = false;
  let threshold = 0.7;
  let cookieMode = 'reject'; // 'reject' | 'hide' | 'off'
  let cookieClicks = 0;
  const cookieHandled = new WeakSet();
  const cookieRecords = []; // clicked-reject records (banner dismissed itself)
  let manualSelectors = [];
  let baselineStyle = null;
  let observer = null;
  let scanTimer = null;
  let candidatesSeen = 0;

  const processed = new WeakSet();       // elements already evaluated
  // Every hidden element, with why: record = { reason: 'ai'|'manual',
  // tag, idAttr, classes, width, height, text, selector?, confidence?, source? }
  const hidden = [];                     // [{el, prevDisplay, record}]
  const stats = { baselineHidden: 0, aiHidden: 0, aiChecked: 0, manualHidden: 0 };

  // --- Utilities -----------------------------------------------------------

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function hostOf(url) {
    try {
      return new URL(url, location.href).hostname;
    } catch {
      return '';
    }
  }

  function isThirdParty(host) {
    if (!host) return false;
    const page = PAGE_HOST.replace(/^www\./, '');
    const h = host.replace(/^www\./, '');
    return h !== page && !h.endsWith('.' + page) && !page.endsWith('.' + h);
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // extension reloaded / SW gone
          resolve(res);
        });
      } catch {
        resolve(undefined);
      }
    });
  }

  function describe(el) {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      idAttr: el.id || '',
      classes: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      text: (el.innerText || el.getAttribute('src') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  }

  function hideElement(el, record) {
    if (el.dataset.bbHidden) return false;
    hidden.push({ el, prevDisplay: el.style.getPropertyValue('display'), record });
    el.style.setProperty('display', 'none', 'important');
    el.dataset.bbHidden = '1';
    return true;
  }

  function unhideEntry(entry) {
    try {
      if (entry.prevDisplay) entry.el.style.setProperty('display', entry.prevDisplay);
      else entry.el.style.removeProperty('display');
      delete entry.el.dataset.bbHidden;
    } catch { /* element gone */ }
  }

  function unhideWhere(pred) {
    for (let i = hidden.length - 1; i >= 0; i--) {
      if (pred(hidden[i], i)) {
        unhideEntry(hidden[i]);
        hidden.splice(i, 1);
      }
    }
  }

  function reportStats() {
    stats.manualHidden = hidden.filter((h) => h.record.reason === 'manual').length;
    const cookieHidden = hidden.filter((h) => h.record.reason === 'cookie').length;
    stats.cookiesHandled = cookieHidden + cookieRecords.length;
    stats.cosmeticHidden =
      stats.baselineHidden + stats.aiHidden + stats.manualHidden + cookieHidden;
    send({ type: 'page-stats', host: PAGE_HOST, stats: { ...stats } });
  }

  // --- Tier 1: baseline CSS -------------------------------------------------

  function injectBaseline() {
    if (baselineStyle) return;
    baselineStyle = document.createElement('style');
    baselineStyle.id = 'betterblock-baseline';
    baselineStyle.textContent =
      BASELINE_SELECTORS.join(',\n') + ' { display: none !important; }';
    (document.head || document.documentElement).appendChild(baselineStyle);
  }

  function removeBaseline() {
    baselineStyle?.remove();
    baselineStyle = null;
  }

  function baselineHits() {
    try {
      return [...document.querySelectorAll(BASELINE_SELECTORS.join(','))];
    } catch {
      return [];
    }
  }

  // --- Manual rules (element picker persistence) -----------------------------

  function applyManualRules() {
    for (const selector of manualSelectors) {
      let nodes;
      try {
        nodes = document.querySelectorAll(selector);
      } catch {
        continue; // bad selector — ignore
      }
      for (const el of nodes) {
        if (el === document.body || el === document.documentElement) continue;
        if (hideElement(el, { reason: 'manual', selector, ...describe(el) })) {
          processed.add(el);
        }
      }
    }
  }

  function removeManualSelector(selector) {
    manualSelectors = manualSelectors.filter((s) => s !== selector);
    unhideWhere((h) => h.record.reason === 'manual' && h.record.selector === selector);
    reportStats();
  }

  // Robust-ish CSS path for a picked element: unique id anchor if possible,
  // then a unique class combo, then a structural nth-of-type path.
  function cssPath(el) {
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const classes = [...(el.classList || [])].slice(0, 3);
    if (classes.length) {
      const sel = el.tagName.toLowerCase() + classes.map((c) => '.' + CSS.escape(c)).join('');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch { /* fall through */ }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') {
        parts.unshift(tag);
        break;
      }
      if (node.id && document.querySelectorAll('#' + CSS.escape(node.id)).length === 1) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      const parent = node.parentElement;
      let part = tag;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  // --- Element picker ---------------------------------------------------------

  let picker = null;

  function startPicker() {
    if (picker) return;
    const Z = 2147483647;
    const box = document.createElement('div');
    box.setAttribute('style',
      `position:fixed;z-index:${Z};pointer-events:none;display:none;` +
      'background:rgba(79,70,229,0.22);outline:2px solid #4f46e5;border-radius:2px;');
    const tip = document.createElement('div');
    tip.setAttribute('style',
      `position:fixed;z-index:${Z};pointer-events:none;top:12px;left:50%;transform:translateX(-50%);` +
      'background:#111827;color:#f9fafb;font:12px/1.4 system-ui,sans-serif;' +
      'padding:8px 14px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
      'max-width:90vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
    document.documentElement.append(box, tip);

    let current = null;
    const stack = [];
    let lastXY = null;

    const label = (el) => {
      if (!el) return '';
      let s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      else if (typeof el.className === 'string' && el.className.trim()) {
        s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
      }
      return s;
    };

    const position = () => {
      if (!current) { box.style.display = 'none'; return; }
      const r = current.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
      tip.textContent =
        `Hide ${label(current)} — click to confirm · ↑ wider · ↓ narrower · Esc to cancel`;
    };

    const pickable = (el) =>
      el && el !== box && el !== tip && el !== document.body &&
      el !== document.documentElement && el.nodeType === 1;

    const onMove = (e) => {
      lastXY = [e.clientX, e.clientY];
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (pickable(el) && el !== current) {
        current = el;
        stack.length = 0;
      }
      position();
    };
    const onScroll = () => {
      if (!lastXY) return position();
      const el = document.elementFromPoint(lastXY[0], lastXY[1]);
      if (pickable(el) && el !== current) { current = el; stack.length = 0; }
      position();
    };
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const onClick = (e) => {
      swallow(e);
      const el = current;
      stopPicker();
      if (el) pickElement(el);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { swallow(e); stopPicker(); return; }
      if (e.key === 'ArrowUp') {
        swallow(e);
        const p = current?.parentElement;
        if (p && p !== document.body && p !== document.documentElement) {
          stack.push(current);
          current = p;
          position();
        }
      } else if (e.key === 'ArrowDown') {
        swallow(e);
        if (stack.length) { current = stack.pop(); position(); }
      }
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('keydown', onKey, true);

    tip.textContent = 'Move the mouse and click the element you want to hide · Esc to cancel';

    picker = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      tip.remove();
    };
  }

  function stopPicker() {
    picker?.();
    picker = null;
  }

  async function pickElement(el) {
    const selector = cssPath(el);
    const sample = describe(el); // capture size/text before hiding zeroes the rect
    if (!manualSelectors.includes(selector)) manualSelectors.push(selector);
    hideElement(el, { reason: 'manual', selector, ...sample });
    reportStats();
    await send({ type: 'manual-add', host: PAGE_HOST, selector, sample });
  }

  // --- Cookie-consent prompts -------------------------------------------------
  // Strategy: prefer clicking the banner's own "reject all / only necessary"
  // button (known CMP selector → multilingual text match → ask the local LLM
  // to pick from the button labels). Never auto-accept. If no reject path
  // exists (accept-only banners) or mode is 'hide', hide the banner and undo
  // its side effects: body scroll locks and backdrop overlays.

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function buttonCandidates(root) {
    const out = [];
    for (const el of root.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], a')) {
      const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 60 || !isVisible(el)) continue;
      out.push({ el, text });
      if (out.length >= 12) break;
    }
    return out;
  }

  function findRejectButton(root) {
    for (const { el, text } of buttonCandidates(root)) {
      if (REJECT_TEXT_RE.test(text) && !NOT_REJECT_RE.test(text)) return el;
    }
    return null;
  }

  function looksLikeCookiePrompt(el) {
    const text = (el.innerText || '').slice(0, 4000);
    if (!text || text.length < 30) return false;
    const cookieMentions = (text.match(/cookie/gi) || []).length;
    if (!(COOKIE_WORD_RE.test(text) && (CONSENT_WORD_RE.test(text) || cookieMentions >= 3))) {
      return false;
    }
    // Must be an overlay/banner, not an article that talks about cookies.
    const cs = getComputedStyle(el);
    const overlayish =
      cs.position === 'fixed' || cs.position === 'sticky' ||
      el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' ||
      (cs.position === 'absolute' && (parseInt(cs.zIndex, 10) || 0) >= 100);
    return overlayish;
  }

  function unlockScroll() {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') {
        el.style.setProperty('overflow', 'auto', 'important');
      }
    }
  }

  function hideBackdrops() {
    let nodes;
    try {
      nodes = document.querySelectorAll(
        '[class*="overlay" i], [class*="backdrop" i], [class*="scrim" i]');
    } catch { return; }
    const vw = innerWidth || 1;
    const vh = innerHeight || 1;
    for (const el of nodes) {
      if (el.dataset.bbHidden || !isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const text = (el.innerText || '').trim();
      if (cs.position === 'fixed' && rect.width > vw * 0.7 && rect.height > vh * 0.7 &&
          text.length < 40) {
        hideElement(el, { reason: 'cookie', action: 'hidden', ...describe(el) });
      }
    }
  }

  function hideCookieBanner(el) {
    if (!el.dataset.bbHidden) {
      hideElement(el, { reason: 'cookie', action: 'hidden', ...describe(el) });
    }
    unlockScroll();
    hideBackdrops();
    reportStats();
  }

  function clickReject(el, btn, banner) {
    cookieClicks++;
    cookieRecords.push({
      reason: 'cookie', action: 'rejected',
      buttonText: (btn.innerText || btn.value || '').trim().slice(0, 60),
      ...describe(el),
    });
    try { btn.click(); } catch { /* ignore */ }
    reportStats();
    // Some banners need a beat to dismiss themselves; if this one didn't,
    // hide it so the user never sees a half-dead prompt.
    setTimeout(() => {
      if (banner.isConnected && isVisible(banner)) hideCookieBanner(banner);
      else unlockScroll();
    }, 1200);
  }

  async function handleCookieBanner(el, rejectSel, shadow) {
    if (cookieHandled.has(el)) return;
    cookieHandled.add(el);
    const root = shadow && el.shadowRoot ? el.shadowRoot : el;

    if (cookieMode === 'reject' && cookieClicks < 3) {
      let btn = null;
      if (rejectSel) {
        try { btn = root.querySelector(rejectSel); } catch { /* bad selector */ }
      }
      if (!btn || !isVisible(btn)) btn = findRejectButton(root);
      if (btn) return clickReject(el, btn, el);

      // No obvious reject button — let the local LLM read the labels.
      const btns = buttonCandidates(root);
      if (btns.length) {
        const res = await send({ type: 'cookie-buttons', texts: btns.map((b) => b.text) });
        const pick = btns[res?.index];
        if (pick && isVisible(pick.el) && cookieClicks < 3 &&
            !NOT_REJECT_RE.test(pick.text)) {
          return clickReject(el, pick.el, el);
        }
      }
    }
    hideCookieBanner(el);
  }

  function scanCookieBanners() {
    if (!active || cookieMode === 'off' || !document.body) return;

    for (const { sel, reject, shadow } of KNOWN_CMPS) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const el of nodes) {
        if (!cookieHandled.has(el) && (isVisible(el) || (shadow && el.shadowRoot))) {
          handleCookieBanner(el, reject, shadow);
        }
      }
    }

    // Generic: cookie/consent-named overlays and dialogs.
    let nodes;
    try {
      nodes = document.querySelectorAll(
        '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], ' +
        '[aria-label*="cookie" i], dialog, [role="dialog"], [aria-modal="true"]');
    } catch { return; }
    const matches = [...nodes].filter(
      (el) => !cookieHandled.has(el) && !el.dataset.bbHidden &&
        el !== document.body && el !== document.documentElement &&
        isVisible(el) && looksLikeCookiePrompt(el));
    // Handle outermost matches only (a banner often nests many matching divs).
    for (const el of matches) {
      if (!matches.some((o) => o !== el && o.contains(el))) {
        handleCookieBanner(el, null, false);
      }
    }
  }

  // --- Tier 2: candidate discovery & scoring --------------------------------

  function scoreElement(el, f) {
    let score = 0;
    const idClass = `${f.idAttr} ${f.classes}`;
    if (STRONG_AD_RE.test(idClass)) score += 3;
    if (WEAK_AD_RE.test(idClass)) score += 2;
    if (f.tag === 'iframe' && f.thirdParty) score += 2;
    if (f.srcHost && AD_HOST_RE.test(f.srcHost)) score += 4;
    if (IAB_SIZES.has(`${f.width}x${f.height}`)) score += 1.5;
    if (AD_TEXT_RE.test(f.text)) score += 2.5;
    if ((f.position === 'fixed' || f.position === 'sticky') && f.zIndex >= 1000) {
      const vw = innerWidth || 1;
      const vh = innerHeight || 1;
      const coverage = (f.width * f.height) / (vw * vh);
      if (coverage > 0.03 && coverage < 0.5) score += 2; // floating banner, not a modal
    }
    if (el.hasAttribute('data-ad') || el.hasAttribute('data-ad-client') ||
        el.hasAttribute('data-adunit') || el.hasAttribute('data-ad-unit')) score += 3;
    if (f.linkHosts.length && f.linkHosts.every(isThirdParty) && f.text.length < 300) score += 1;
    return score;
  }

  function extractFeatures(el) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const src = el.getAttribute('src') || '';
    const srcHost = src ? hostOf(src) : '';
    const linkHosts = [];
    for (const a of el.querySelectorAll('a[href]')) {
      const h = hostOf(a.getAttribute('href'));
      if (h && !linkHosts.includes(h)) linkHosts.push(h);
      if (linkHosts.length >= 4) break;
    }
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    return {
      tag: el.tagName.toLowerCase(),
      idAttr: el.id || '',
      classes: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      position: cs.position,
      zIndex: parseInt(cs.zIndex, 10) || 0,
      srcHost,
      pageHost: PAGE_HOST,
      thirdParty: isThirdParty(srcHost),
      linkHosts,
      text,
    };
  }

  function featureKey(f) {
    // Stable across page views: bucket sizes to 10px, ignore volatile text tail.
    const sig = [
      f.pageHost, f.tag, f.idAttr.replace(/\d+/g, '#'), f.classes,
      Math.round(f.width / 10), Math.round(f.height / 10),
      f.srcHost, f.text.slice(0, 60),
    ].join('|');
    return fnv1a(sig);
  }

  function eligible(el) {
    if (processed.has(el)) return false;
    if (el.dataset.bbHidden) return false;
    const tag = el.tagName;
    if (tag === 'HTML' || tag === 'BODY' || tag === 'MAIN' || tag === 'ARTICLE') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return false; // pixels/beacons: network layer's job
    const vw = innerWidth || 1;
    const vh = innerHeight || 1;
    const cs = getComputedStyle(el);
    // Never consider elements that dominate the page unless they float above it.
    if (rect.width > vw * 0.75 && rect.height > vh * 0.75 &&
        cs.position !== 'fixed' && cs.position !== 'sticky') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  }

  function collectCandidates(root) {
    const found = new Set();
    const selectors = [
      'iframe',
      '[id*="ad" i]', '[class*="ad" i]',
      '[id*="sponsor" i]', '[class*="sponsor" i]',
      '[class*="banner" i]', '[class*="promo" i]',
      '[data-ad]', '[data-ad-client]', '[data-adunit]', '[data-ad-unit]',
      '[aria-label*="advertisement" i]',
    ];
    let nodes;
    try {
      nodes = root.querySelectorAll(selectors.join(','));
    } catch {
      return [];
    }
    for (const el of nodes) {
      if (found.size >= MAX_PER_SCAN * 3) break;
      if (eligible(el)) found.add(el);
    }
    return [...found];
  }

  // --- Tier 3: classification ----------------------------------------------

  async function classify(items) {
    if (!items.length) return;
    stats.aiChecked += items.length;
    const res = await send({
      type: 'classify',
      items: items.map(({ key, features }) => ({ key, features })),
    });
    if (!res?.verdicts || !active) return;
    const t = res.threshold ?? threshold;
    let changed = false;
    for (const { key, el, features } of items) {
      const v = res.verdicts[key];
      if (v?.isAd && v.confidence >= t) {
        const record = {
          reason: 'ai',
          confidence: v.confidence,
          source: v.source,
          ...describe(el),
          // describe() reads a zero rect once hidden; keep scan-time size
          width: features.width,
          height: features.height,
        };
        if (hideElement(el, record)) {
          stats.aiHidden++;
          changed = true;
        }
      }
    }
    if (changed || items.length) reportStats();
  }

  function scan(root = document) {
    applyManualRules();
    scanCookieBanners();
    if (!active || candidatesSeen >= MAX_PER_PAGE) {
      reportStats();
      return;
    }
    const batch = [];
    for (const el of collectCandidates(root)) {
      processed.add(el);
      const features = extractFeatures(el);
      const score = scoreElement(el, features);
      if (score < 2) continue; // not suspicious enough to bother the model
      features.heuristicScore = score;
      batch.push({ key: featureKey(features), features, el });
      candidatesSeen++;
      if (batch.length >= MAX_PER_SCAN || candidatesSeen >= MAX_PER_PAGE) break;
    }
    stats.baselineHidden = baselineHits().length;
    if (batch.length) classify(batch);
    else reportStats();
  }

  function scheduleScan() {
    if (scanTimer) return;
    if (!active && !manualSelectors.length) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, SCAN_DEBOUNCE_MS);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes.length) {
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  function syncObserver() {
    if (active || manualSelectors.length) startObserver();
    else stopObserver();
  }

  // --- Details for the popup --------------------------------------------------

  function collectDetails() {
    const elements = hidden.map((h, index) => ({ index, ...h.record }));
    const rejected = cookieRecords.map((r) => ({ index: -1, ...r }));
    const baseline = baselineHits().slice(0, 50).map((el) => ({
      index: -1,
      reason: 'baseline',
      ...describe(el),
    }));
    return { elements: [...elements, ...rejected, ...baseline], stats, active };
  }

  // --- Lifecycle -------------------------------------------------------------

  function activate() {
    if (active) return;
    active = true;
    injectBaseline();
    scheduleScan();
    syncObserver();
    // Late-loading ad tech: a couple of follow-up sweeps, then MO only.
    setTimeout(() => { if (active) scan(); }, 2500);
    setTimeout(() => { if (active) scan(); }, 7000);
  }

  function deactivate() {
    active = false;
    removeBaseline();
    // Manual (user-picked) hides survive the protection toggle.
    unhideWhere((h) => h.record.reason !== 'manual');
    stats.baselineHidden = stats.aiHidden = stats.aiChecked = 0;
    syncObserver();
    reportStats();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'bb-set-active':
        if (msg.active) activate();
        else deactivate();
        sendResponse({ ok: true });
        break;
      case 'bb-start-picker':
        startPicker();
        sendResponse({ ok: true });
        break;
      case 'bb-get-details':
        sendResponse(collectDetails());
        break;
      case 'bb-unhide': {
        const entry = hidden[msg.index];
        if (entry) {
          if (entry.record.reason === 'ai') stats.aiHidden = Math.max(0, stats.aiHidden - 1);
          unhideEntry(entry);
          // Don't re-hide it on the next scan this page view.
          processed.add(entry.el);
          hidden.splice(msg.index, 1);
          reportStats();
        }
        sendResponse({ ok: true });
        break;
      }
      case 'bb-remove-manual':
        removeManualSelector(msg.selector);
        sendResponse({ ok: true });
        break;
      default:
        return false;
    }
    return false;
  });

  send({ type: 'get-config', host: PAGE_HOST }).then((cfg) => {
    if (!cfg || cfg.error) return;
    threshold = cfg.threshold ?? threshold;
    cookieMode = cfg.cookieMode ?? cookieMode;
    manualSelectors = cfg.manualSelectors ?? [];
    if (cfg.enabled && !cfg.allowlisted) {
      activate();
    } else if (manualSelectors.length) {
      // Protection is off here, but user-picked hides still apply.
      const applyNow = () => { applyManualRules(); syncObserver(); reportStats(); };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyNow, { once: true });
      } else {
        applyNow();
      }
    }
  });
})();
