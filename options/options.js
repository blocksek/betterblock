// BetterBlock options page.

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

let settings = null;

function renderAllowlist() {
  const ul = $('allowlist');
  ul.textContent = '';
  for (const host of settings.allowlist) {
    const li = document.createElement('li');
    li.append(host);
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', async () => {
      await save({ allowlist: settings.allowlist.filter((h) => h !== host) });
      renderAllowlist();
    });
    li.append(x);
    ul.append(li);
  }
}

async function renderLearned() {
  const { learned = [] } = (await send({ type: 'get-learned' })) ?? {};
  const ul = $('learned-list');
  ul.textContent = '';
  $('learned-empty').style.display = learned.length ? 'none' : 'block';
  for (const entry of learned) {
    const li = document.createElement('li');
    li.append(entry.host);
    li.title = `Learned on ${entry.learnedOn} (${entry.source})`;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Unblock this domain';
    x.addEventListener('click', async () => {
      await send({ type: 'remove-learned', host: entry.host });
      renderLearned();
    });
    li.append(x);
    ul.append(li);
  }
}

async function save(patch) {
  const res = await send({ type: 'save-settings', patch });
  if (res?.settings) settings = res.settings;
}

async function init() {
  const status = await send({ type: 'get-status' });
  settings = status?.settings ?? { threshold: 0.7, learnNetworkRules: true, allowlist: [] };

  $('threshold').value = settings.threshold;
  $('threshold-value').textContent = Number(settings.threshold).toFixed(2);
  $('learn-rules').checked = settings.learnNetworkRules;
  renderAllowlist();
  renderLearned();

  $('threshold').addEventListener('input', () => {
    $('threshold-value').textContent = Number($('threshold').value).toFixed(2);
  });
  $('threshold').addEventListener('change', () => {
    save({ threshold: Number($('threshold').value) });
  });

  $('learn-rules').addEventListener('change', (e) => {
    save({ learnNetworkRules: e.target.checked });
  });

  const addHost = async () => {
    const host = $('allow-input').value.trim().toLowerCase()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    if (!host || !host.includes('.') || settings.allowlist.includes(host)) return;
    await save({ allowlist: [...settings.allowlist, host] });
    $('allow-input').value = '';
    renderAllowlist();
  };
  $('allow-add').addEventListener('click', addHost);
  $('allow-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addHost();
  });

  $('clear-cache').addEventListener('click', async () => {
    await send({ type: 'clear-cache' });
    $('clear-done').textContent = 'Cleared ✓';
    setTimeout(() => { $('clear-done').textContent = ''; }, 2000);
  });
}

init();
