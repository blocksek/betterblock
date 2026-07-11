// BetterBlock background service worker.
//
// Responsibilities:
//  - Own the LocalClassifier (Gemini Nano session / heuristic fallback).
//  - Cache classification verdicts so the model runs once per unique element
//    shape, not once per page view.
//  - Promote high-confidence ad iframes into "learned" dynamic
//    declarativeNetRequest rules so future page loads never fetch them.
//  - Serve config/status to the content script, popup and options page.
//
// Privacy invariant: no fetch()/XHR anywhere in this extension. All state
// lives in chrome.storage.local on the user's machine.

import { LocalClassifier } from './llm.js';

const classifier = new LocalClassifier();

const DEFAULT_SETTINGS = {
  enabled: true,
  // Minimum LLM confidence before an element is hidden.
  threshold: 0.7,
  // Allow AI verdicts to create network-level block rules for ad iframe hosts.
  learnNetworkRules: true,
  // Cookie prompts: 'reject' = click reject-all (hide as fallback),
  // 'hide' = just hide the banner, 'off' = leave them alone.
  cookieMode: 'reject',
  allowlist: [], // hostnames where BetterBlock is off
};

const VERDICT_CACHE_KEY = 'verdictCache';
const VERDICT_CACHE_MAX = 5000;
const LEARNED_KEY = 'learnedDomains';
const LEARNED_RULE_ID_BASE = 100000;
const LEARNED_MAX = 300;
const LEARN_CONFIDENCE = 0.85;

// Hosts that must never be auto-blocked even if an ad was served through
// them — blocking these breaks unrelated functionality on many sites.
const NEVER_LEARN = new Set([
  'google.com', 'www.google.com', 'gstatic.com', 'www.gstatic.com',
  'googleapis.com', 'youtube.com', 'www.youtube.com', 'ytimg.com',
  'cloudflare.com', 'cdnjs.cloudflare.com', 'jsdelivr.net', 'cdn.jsdelivr.net',
  'unpkg.com', 'akamaihd.net', 'fastly.net', 'cloudfront.net',
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com',
]);

// ---------------------------------------------------------------------------
// Settings & small storage helpers

let settingsCache = null;

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = (await chrome.storage.local.get('settings')).settings ?? {};
  settingsCache = { ...DEFAULT_SETTINGS, ...stored };
  return settingsCache;
}

async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  settingsCache = next;
  await chrome.storage.local.set({ settings: next });
  return next;
}

function baseHost(host) {
  return (host ?? '').toLowerCase().replace(/^www\./, '');
}

function isAllowlisted(settings, host) {
  return settings.allowlist.includes(baseHost(host));
}

// ---------------------------------------------------------------------------
// Verdict cache (feature-hash -> verdict), persisted with lazy writes

let verdictCache = null;
let cacheDirty = false;
let cacheWriteTimer = null;

async function getVerdictCache() {
  if (verdictCache) return verdictCache;
  const stored = (await chrome.storage.local.get(VERDICT_CACHE_KEY))[VERDICT_CACHE_KEY] ?? {};
  verdictCache = new Map(Object.entries(stored));
  return verdictCache;
}

function scheduleCacheWrite() {
  cacheDirty = true;
  if (cacheWriteTimer) return;
  cacheWriteTimer = setTimeout(async () => {
    cacheWriteTimer = null;
    if (!cacheDirty || !verdictCache) return;
    cacheDirty = false;
    if (verdictCache.size > VERDICT_CACHE_MAX) {
      // Drop oldest entries (Map preserves insertion order).
      const drop = verdictCache.size - VERDICT_CACHE_MAX;
      let i = 0;
      for (const key of verdictCache.keys()) {
        if (i++ >= drop) break;
        verdictCache.delete(key);
      }
    }
    await chrome.storage.local.set({ [VERDICT_CACHE_KEY]: Object.fromEntries(verdictCache) });
  }, 2000);
}

// ---------------------------------------------------------------------------
// Learned network rules (dynamic DNR rules created from AI verdicts)

async function getLearnedDomains() {
  return (await chrome.storage.local.get(LEARNED_KEY))[LEARNED_KEY] ?? [];
}

async function maybeLearnDomain(host, pageHost, verdict, settings) {
  if (!settings.learnNetworkRules) return;
  if (!host || !verdict.isAd || verdict.confidence < LEARN_CONFIDENCE) return;
  host = host.toLowerCase();
  const page = baseHost(pageHost);
  if (!host.includes('.') || host === page || host.endsWith('.' + page)) return;
  if (NEVER_LEARN.has(host) || NEVER_LEARN.has(baseHost(host))) return;

  const learned = await getLearnedDomains();
  if (learned.some((d) => d.host === host)) return;
  if (learned.length >= LEARNED_MAX) return;

  const usedIds = new Set(learned.map((d) => d.ruleId));
  let ruleId = LEARNED_RULE_ID_BASE;
  while (usedIds.has(ruleId)) ruleId++;

  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: ruleId,
      priority: 1,
      action: { type: 'block' },
      condition: {
        requestDomains: [host],
        domainType: 'thirdParty',
        resourceTypes: ['sub_frame', 'script', 'image', 'xmlhttprequest', 'ping', 'other'],
      },
    }],
  });
  learned.push({ host, ruleId, learnedOn: page, source: verdict.source });
  await chrome.storage.local.set({ [LEARNED_KEY]: learned });
}

async function removeLearnedDomain(host) {
  const learned = await getLearnedDomains();
  const entry = learned.find((d) => d.host === host);
  if (!entry) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [entry.ruleId] });
  await chrome.storage.local.set({ [LEARNED_KEY]: learned.filter((d) => d.host !== host) });
}

// ---------------------------------------------------------------------------
// Allowlist -> dynamic "allow" rules so network blocking is also disabled
// on allowlisted sites (cosmetic filtering is skipped by the content script).

const ALLOW_RULE_ID_BASE = 200000;

async function syncAllowlistRules(allowlist) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing
    .filter((r) => r.id >= ALLOW_RULE_ID_BASE && r.id < ALLOW_RULE_ID_BASE + 10000)
    .map((r) => r.id);
  const addRules = allowlist.map((host, i) => ({
    id: ALLOW_RULE_ID_BASE + i,
    priority: 10,
    action: { type: 'allow' },
    condition: {
      initiatorDomains: [host],
      resourceTypes: ['sub_frame', 'script', 'image', 'xmlhttprequest', 'ping', 'media', 'other'],
    },
  }));
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// ---------------------------------------------------------------------------
// Manual element-hide rules (from the picker), keyed by base host

const MANUAL_KEY = 'manualRules'; // { host: [{selector, sample, createdAt}] }

async function getManualRules() {
  return (await chrome.storage.local.get(MANUAL_KEY))[MANUAL_KEY] ?? {};
}

async function addManualRule(host, selector, sample) {
  host = baseHost(host);
  if (!host || !selector) return;
  const rules = await getManualRules();
  const list = rules[host] ?? [];
  if (!list.some((r) => r.selector === selector)) {
    list.push({ selector, sample: sample ?? null, createdAt: Date.now() });
    rules[host] = list;
    await chrome.storage.local.set({ [MANUAL_KEY]: rules });
  }
}

async function removeManualRule(host, selector) {
  host = baseHost(host);
  const rules = await getManualRules();
  if (!rules[host]) return;
  rules[host] = rules[host].filter((r) => r.selector !== selector);
  if (!rules[host].length) delete rules[host];
  await chrome.storage.local.set({ [MANUAL_KEY]: rules });
}

// ---------------------------------------------------------------------------
// Per-tab blocked-request log. declarativeNetRequest blocks silently, so we
// observe (never modify) request *failures* and keep the ones Chrome reports
// as blocked-by-extension. Log lives in session storage only — cleared on
// navigation and when the browser closes, never transmitted anywhere.

const NET_LOG_MAX = 300;
const netLogs = new Map(); // tabId -> [{url, type, ts}]
const netLogTimers = new Map();

async function getNetLog(tabId) {
  if (!netLogs.has(tabId)) {
    const stored = (await chrome.storage.session.get('netLog:' + tabId))['netLog:' + tabId] ?? [];
    if (!netLogs.has(tabId)) netLogs.set(tabId, stored); // keep race winner
  }
  return netLogs.get(tabId);
}

function scheduleNetLogWrite(tabId) {
  if (netLogTimers.has(tabId)) return;
  netLogTimers.set(tabId, setTimeout(() => {
    netLogTimers.delete(tabId);
    const log = netLogs.get(tabId);
    if (log) chrome.storage.session.set({ ['netLog:' + tabId]: log });
  }, 1000));
}

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (details.error !== 'net::ERR_BLOCKED_BY_CLIENT') return;
  if (details.tabId < 0) return;
  getNetLog(details.tabId).then((log) => {
    log.push({ url: details.url, type: details.type, ts: details.timeStamp });
    if (log.length > NET_LOG_MAX) log.splice(0, log.length - NET_LOG_MAX);
    scheduleNetLogWrite(details.tabId);
  });
}, { urls: ['<all_urls>'] });

// Reset the log on navigation. Uses onBeforeRequest(main_frame) rather than
// tabs.onUpdated because it shares an ordered event pipeline with
// onErrorOccurred — a late-arriving tab event could otherwise wipe blocks
// that were logged just after the navigation committed.
chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0) return;
  netLogs.set(details.tabId, []);
  chrome.storage.session.remove('netLog:' + details.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

// ---------------------------------------------------------------------------
// Per-tab cosmetic stats (session-scoped, for the popup)

async function setTabStats(tabId, stats) {
  if (tabId == null) return;
  await chrome.storage.session.set({ ['tabStats:' + tabId]: stats });
}

async function getTabStats(tabId) {
  if (tabId == null) return null;
  return (await chrome.storage.session.get('tabStats:' + tabId))['tabStats:' + tabId] ?? null;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  netLogs.delete(tabId);
  chrome.storage.session.remove(['tabStats:' + tabId, 'netLog:' + tabId]);
});

// ---------------------------------------------------------------------------
// Classification entry point

async function handleClassify(msg, tabId) {
  const settings = await getSettings();
  const cache = await getVerdictCache();
  const verdicts = {};
  const unknown = [];

  for (const item of msg.items) {
    const cached = cache.get(item.key);
    if (cached) {
      verdicts[item.key] = cached;
      // Refresh recency so hot entries survive cache pruning.
      cache.delete(item.key);
      cache.set(item.key, cached);
    } else {
      unknown.push(item);
    }
  }

  if (unknown.length) {
    const fresh = await classifier.classifyBatch(unknown);
    for (const item of unknown) {
      const v = fresh[item.key];
      if (!v) continue;
      verdicts[item.key] = v;
      cache.set(item.key, v);
      // Only iframes give a clean "this whole host serves ads" signal.
      if (item.features.tag === 'iframe' && item.features.thirdParty && item.features.srcHost) {
        maybeLearnDomain(item.features.srcHost, item.features.pageHost, v, settings)
          .catch((e) => console.warn('BetterBlock: learn rule failed', e));
      }
    }
    scheduleCacheWrite();
  }

  return { verdicts, threshold: settings.threshold };
}

// ---------------------------------------------------------------------------
// Message routing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? msg.tabId;

  const handlers = {
    'get-config': async () => {
      const [settings, manual] = await Promise.all([getSettings(), getManualRules()]);
      return {
        enabled: settings.enabled,
        allowlisted: isAllowlisted(settings, msg.host),
        threshold: settings.threshold,
        cookieMode: settings.cookieMode,
        manualSelectors: (manual[baseHost(msg.host)] ?? []).map((r) => r.selector),
      };
    },
    'classify': () => handleClassify(msg, tabId),
    'cookie-buttons': () => classifier.pickRejectButton(msg.texts ?? []),
    'page-stats': async () => {
      await setTabStats(tabId, { ...msg.stats, host: msg.host });
      return { ok: true };
    },
    'get-status': async () => {
      const settings = await getSettings();
      const [llm, stats, learned] = await Promise.all([
        classifier.status(),
        getTabStats(msg.tabId),
        getLearnedDomains(),
      ]);
      const networkBlocked = msg.tabId != null ? (await getNetLog(msg.tabId)).length : null;
      return {
        settings,
        llm,
        tabStats: stats,
        networkBlocked,
        learnedCount: learned.length,
        allowlisted: msg.host ? isAllowlisted(settings, msg.host) : false,
      };
    },
    'download-model': async () => {
      classifier.ensureSession().catch(() => {});
      return { ok: true };
    },
    'llm-status': () => classifier.status(),
    'set-enabled': async () => {
      await saveSettings({ enabled: Boolean(msg.enabled) });
      return { ok: true };
    },
    'toggle-site': async () => {
      const settings = await getSettings();
      const host = baseHost(msg.host);
      if (!host) return { ok: false };
      const allowlist = settings.allowlist.includes(host)
        ? settings.allowlist.filter((h) => h !== host)
        : [...settings.allowlist, host];
      await saveSettings({ allowlist });
      await syncAllowlistRules(allowlist);
      return { ok: true, allowlisted: allowlist.includes(host) };
    },
    'save-settings': async () => {
      const next = await saveSettings(msg.patch ?? {});
      if (msg.patch?.allowlist) await syncAllowlistRules(next.allowlist);
      return { ok: true, settings: next };
    },
    'get-tab-details': async () => ({
      requests: msg.tabId != null ? await getNetLog(msg.tabId) : [],
    }),
    'manual-add': async () => {
      await addManualRule(msg.host, msg.selector, msg.sample);
      return { ok: true };
    },
    'manual-remove': async () => {
      await removeManualRule(msg.host, msg.selector);
      return { ok: true };
    },
    'get-manual': async () => ({ rules: await getManualRules() }),
    'get-learned': async () => ({ learned: await getLearnedDomains() }),
    'remove-learned': async () => {
      await removeLearnedDomain(msg.host);
      return { ok: true };
    },
    'clear-cache': async () => {
      verdictCache = new Map();
      await chrome.storage.local.remove(VERDICT_CACHE_KEY);
      return { ok: true };
    },
  };

  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve(handler())
    .then(sendResponse)
    .catch((err) => {
      console.error('BetterBlock:', msg.type, err);
      sendResponse({ error: String(err) });
    });
  return true; // async response
});

// ---------------------------------------------------------------------------
// Init

chrome.runtime.onInstalled.addListener(async () => {
  // Badge shows the number of network requests blocked on the current tab,
  // counted by Chrome itself (no webRequest observation needed).
  chrome.declarativeNetRequest.setExtensionActionOptions({
    displayActionCountAsBadgeText: true,
  });
  const settings = await getSettings();
  await syncAllowlistRules(settings.allowlist);
});

chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });

// Warm the availability check so the popup shows accurate status quickly.
classifier.refreshState().catch(() => {});
