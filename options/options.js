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

async function renderManual() {
  const { rules = {} } = (await send({ type: 'get-manual' })) ?? {};
  const box = $('manual-groups');
  box.textContent = '';
  const hosts = Object.keys(rules).sort();
  $('manual-empty').style.display = hosts.length ? 'none' : 'block';
  for (const host of hosts) {
    const h = document.createElement('h3');
    h.textContent = host;
    h.style.cssText = 'font-size:12px;margin:10px 0 4px';
    const ul = document.createElement('ul');
    ul.className = 'pill-list';
    for (const rule of rules[host]) {
      const li = document.createElement('li');
      const sample = rule.sample;
      const label = sample
        ? (sample.tag + (sample.idAttr ? '#' + sample.idAttr : '') +
           (sample.text ? ` — “${sample.text.slice(0, 40)}”` : ''))
        : rule.selector;
      li.append(label.slice(0, 60));
      li.title = rule.selector;
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Stop hiding this element';
      x.addEventListener('click', async () => {
        await send({ type: 'manual-remove', host, selector: rule.selector });
        renderManual();
      });
      li.append(x);
      ul.append(li);
    }
    box.append(h, ul);
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
  $('hide-cookies').checked = (settings.cookieMode ?? 'hide') !== 'off';
  renderAllowlist();
  renderLearned();
  renderManual();

  $('threshold').addEventListener('input', () => {
    $('threshold-value').textContent = Number($('threshold').value).toFixed(2);
  });
  $('threshold').addEventListener('change', () => {
    save({ threshold: Number($('threshold').value) });
  });

  $('learn-rules').addEventListener('change', (e) => {
    save({ learnNetworkRules: e.target.checked });
  });

  $('hide-cookies').addEventListener('change', (e) => {
    save({ cookieMode: e.target.checked ? 'hide' : 'off' });
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
