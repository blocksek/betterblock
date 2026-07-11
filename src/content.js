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

  let active = false;
  let threshold = 0.7;
  let baselineStyle = null;
  let observer = null;
  let scanTimer = null;
  let candidatesSeen = 0;

  const processed = new WeakSet();       // elements already evaluated
  const hidden = [];                     // [{el, prevDisplay}] for undo
  const stats = { baselineHidden: 0, aiHidden: 0, aiChecked: 0 };

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

  function hideElement(el) {
    if (el.dataset.bbHidden) return false;
    hidden.push({ el, prevDisplay: el.style.getPropertyValue('display') });
    el.style.setProperty('display', 'none', 'important');
    el.dataset.bbHidden = '1';
    return true;
  }

  function unhideAll() {
    for (const { el, prevDisplay } of hidden) {
      try {
        if (prevDisplay) el.style.setProperty('display', prevDisplay);
        else el.style.removeProperty('display');
        delete el.dataset.bbHidden;
      } catch { /* element gone */ }
    }
    hidden.length = 0;
  }

  function reportStats() {
    send({
      type: 'page-stats',
      host: PAGE_HOST,
      stats: { ...stats, cosmeticHidden: stats.baselineHidden + stats.aiHidden },
    });
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

  function countBaselineHits() {
    try {
      stats.baselineHidden = document.querySelectorAll(BASELINE_SELECTORS.join(','))
        .length;
    } catch { /* selector error — shouldn't happen */ }
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
    for (const { key, el } of items) {
      const v = res.verdicts[key];
      if (v?.isAd && v.confidence >= t && hideElement(el)) {
        stats.aiHidden++;
        changed = true;
      }
    }
    if (changed || items.length) reportStats();
  }

  function scan(root = document) {
    if (!active || candidatesSeen >= MAX_PER_PAGE) return;
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
    countBaselineHits();
    if (batch.length) classify(batch);
    else reportStats();
  }

  function scheduleScan() {
    if (scanTimer || !active) return;
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

  // --- Lifecycle -------------------------------------------------------------

  function activate() {
    if (active) return;
    active = true;
    injectBaseline();
    const onReady = () => {
      scan();
      startObserver();
      // Late-loading ad tech: a couple of follow-up sweeps, then MO only.
      setTimeout(() => scan(), 2500);
      setTimeout(() => scan(), 7000);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
      onReady();
    }
  }

  function deactivate() {
    active = false;
    stopObserver();
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    removeBaseline();
    unhideAll();
    stats.baselineHidden = stats.aiHidden = stats.aiChecked = 0;
    reportStats();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'bb-set-active') {
      if (msg.active) activate();
      else deactivate();
      sendResponse({ ok: true });
    }
    return false;
  });

  send({ type: 'get-config', host: PAGE_HOST }).then((cfg) => {
    if (!cfg || cfg.error) return;
    threshold = cfg.threshold ?? threshold;
    if (cfg.enabled && !cfg.allowlisted) activate();
  });
})();
