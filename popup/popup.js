// BetterBlock popup.

const $ = (id) => document.getElementById(id);

let tab = null;
let tabHost = '';
let openPanel = null; // 'net' | 'el' | null

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

// --- Details panels ---------------------------------------------------------

function row({ what, title, chip, chipClass, meta, onRemove, removeTitle }) {
  const li = document.createElement('li');
  const whatEl = document.createElement('span');
  whatEl.className = 'what';
  whatEl.textContent = what;
  if (title) whatEl.title = title;
  li.append(whatEl);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    li.append(m);
  }
  if (chip) {
    const c = document.createElement('span');
    c.className = 'chip ' + chipClass;
    c.textContent = chip;
    li.append(c);
  }
  if (onRemove) {
    const b = document.createElement('button');
    b.className = 'unhide';
    b.textContent = 'unhide';
    b.title = removeTitle ?? '';
    b.addEventListener('click', onRemove);
    li.append(b);
  }
  return li;
}

function showPanel(list) {
  const ul = $('details-list');
  ul.textContent = '';
  $('details').classList.remove('hidden');
  $('details-empty').classList.toggle('hidden', list.length > 0);
  for (const li of list) ul.append(li);
}

function hidePanel() {
  openPanel = null;
  $('details').classList.add('hidden');
  $('net-card').classList.remove('open');
  $('el-card').classList.remove('open');
}

async function showRequests() {
  const res = await send({ type: 'get-tab-details', tabId: tab?.id });
  const requests = (res?.requests ?? []).slice().reverse(); // newest first
  showPanel(requests.map((r) => {
    let host = r.url;
    let path = '';
    try {
      const u = new URL(r.url);
      host = u.hostname;
      path = u.pathname.length > 1 ? u.pathname : '';
    } catch { /* keep raw */ }
    return row({
      what: host + path,
      title: r.url,
      meta: r.type,
      chip: 'blocked',
      chipClass: 'baseline',
    });
  }));
}

function elementLabel(e) {
  let s = e.tag ?? '?';
  if (e.idAttr) s += '#' + e.idAttr;
  else if (e.classes) s += '.' + e.classes.trim().split(/\s+/).slice(0, 2).join('.');
  return s;
}

async function showElements() {
  const res = await sendToTab({ type: 'bb-get-details' });
  if (!res) {
    showPanel([]);
    return;
  }
  const chips = {
    baseline: ['filter', 'baseline'],
    manual: ['you', 'manual'],
  };
  showPanel(res.elements.map((e) => {
    let chip, chipClass;
    if (e.reason === 'cookie') {
      chip = e.action === 'rejected' ? 'rejected' : 'cookie';
      chipClass = 'cookie';
    } else if (e.reason === 'ai') {
      chip = (e.source === 'gemini-nano' ? 'AI ' : 'heur ') + Math.round((e.confidence ?? 0) * 100) + '%';
      chipClass = e.source === 'gemini-nano' ? 'ai' : 'heuristic';
    } else {
      [chip, chipClass] = chips[e.reason] ?? ['?', 'baseline'];
    }
    const removable = e.index >= 0;
    return row({
      what: elementLabel(e),
      title: [elementLabel(e), e.text, e.selector, e.buttonText && `clicked: ${e.buttonText}`]
        .filter(Boolean).join('\n'),
      meta: e.width ? `${e.width}×${e.height}` : '',
      chip,
      chipClass,
      onRemove: removable ? async (ev) => {
        ev.target.disabled = true;
        if (e.reason === 'manual' && e.selector) {
          await send({ type: 'manual-remove', host: tabHost, selector: e.selector });
          await sendToTab({ type: 'bb-remove-manual', selector: e.selector });
        } else {
          await sendToTab({ type: 'bb-unhide', index: e.index });
        }
        await showElements();
        refresh();
      } : null,
      removeTitle: e.reason === 'manual'
        ? 'Unhide and forget this rule'
        : 'Unhide on this page view',
    });
  }));
}

async function togglePanel(which) {
  if (openPanel === which) return hidePanel();
  openPanel = which;
  $('net-card').classList.toggle('open', which === 'net');
  $('el-card').classList.toggle('open', which === 'el');
  if (which === 'net') await showRequests();
  else await showElements();
}

// --- Main -------------------------------------------------------------------

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

  $('picker-btn').disabled = !tabHost;

  await refresh();

  $('net-card').addEventListener('click', () => togglePanel('net'));
  $('el-card').addEventListener('click', () => togglePanel('el'));

  $('picker-btn').addEventListener('click', async () => {
    await sendToTab({ type: 'bb-start-picker' });
    window.close();
  });

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
