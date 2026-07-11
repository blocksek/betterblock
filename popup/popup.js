// BetterBlock popup.

const $ = (id) => document.getElementById(id);

let tab = null;
let tabHost = '';

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

function sendToTab(msg) {
  return new Promise((resolve) => {
    if (!tab?.id) return resolve(undefined);
    chrome.tabs.sendMessage(tab.id, msg, (res) => {
      void chrome.runtime.lastError; // no content script on this page
      resolve(res);
    });
  });
}

const AI_LABELS = {
  ready: ['Gemini Nano active', 'Ads classified by on-device AI'],
  downloadable: ['On-device AI available', 'One-time model download required'],
  downloading: ['Downloading Gemini Nano…', 'Using heuristics meanwhile'],
  fallback: ['Heuristic mode', 'Gemini Nano unavailable on this device'],
};

function renderAI(llm) {
  const [label, sub] = AI_LABELS[llm.state] ?? AI_LABELS.fallback;
  $('ai-label').textContent = label;
  $('ai-sub').textContent =
    llm.state === 'downloading' && llm.downloadProgress > 0
      ? `Downloading… ${Math.round(llm.downloadProgress * 100)}%`
      : sub;
  $('ai-dot').className = 'dot ' + llm.state;
  $('download-btn').classList.toggle('hidden', llm.state !== 'downloadable');
}

async function refresh() {
  const status = await send({ type: 'get-status', tabId: tab?.id, host: tabHost });
  if (!status || status.error) return;

  renderAI(status.llm);

  $('global-toggle').checked = status.settings.enabled;
  $('site-toggle').checked = status.settings.enabled && !status.allowlisted;
  $('site-toggle').disabled = !status.settings.enabled || !tabHost;
  $('site-host').textContent = tabHost || 'this site';

  $('net-count').textContent = status.networkBlocked ?? '–';
  $('el-count').textContent = status.tabStats?.cosmeticHidden ?? 0;

  $('learned-note').textContent = status.learnedCount
    ? `${status.learnedCount} AI-learned block rules`
    : '';
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    tabHost = new URL(tab?.url ?? '').hostname;
  } catch { tabHost = ''; }

  await refresh();

  $('global-toggle').addEventListener('change', async (e) => {
    await send({ type: 'set-enabled', enabled: e.target.checked });
    await sendToTab({ type: 'bb-set-active', active: e.target.checked });
    refresh();
  });

  $('site-toggle').addEventListener('change', async (e) => {
    if (!tabHost) return;
    await send({ type: 'toggle-site', host: tabHost });
    await sendToTab({ type: 'bb-set-active', active: e.target.checked });
    refresh();
  });

  $('download-btn').addEventListener('click', async () => {
    $('download-btn').classList.add('hidden');
    $('ai-label').textContent = 'Starting download…';
    await send({ type: 'download-model' });
    pollDownload();
  });

  $('options-link').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function pollDownload() {
  const timer = setInterval(async () => {
    const llm = await send({ type: 'llm-status' });
    if (!llm) return clearInterval(timer);
    renderAI(llm);
    if (llm.state === 'ready' || llm.state === 'fallback') clearInterval(timer);
  }, 1000);
}

init();
