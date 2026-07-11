// BetterBlock end-to-end smoke test: load the unpacked extension into
// Chromium, serve a test page with ad-like and normal elements, and check:
//  - baseline CSS hiding + heuristic-fallback LLM-tier hiding + stats flow
//  - blocked-request logging (webRequest observation of DNR blocks)
//  - details drill-down (bb-get-details) and per-element unhide
//  - element picker: hover/click hides element, rule persists across reload,
//    and removal restores it
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');

const EXT = path.join(__dirname, '..');

// Known CMP (OneTrust ids): reject button must be clicked via its selector.
const COOKIE_KNOWN = `<!DOCTYPE html><html><head><title>k</title></head><body>
  <p id="page-content">Article.</p>
  <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:20px;z-index:9999">
    We use cookies to enhance your experience and analyze traffic. See our cookie policy.
    <button id="onetrust-accept-btn-handler" onclick="window.__accepted=true">Accept all</button>
    <button id="onetrust-reject-all-handler"
      onclick="window.__rejected=true;document.getElementById('onetrust-banner-sdk').remove()">Reject all</button>
  </div>
</body></html>`;

// Generic banner with a text-matched decline button.
const COOKIE_GENERIC_REJECT = `<!DOCTYPE html><html><head><title>g</title></head><body>
  <p id="page-content">Article.</p>
  <div class="cmp-wrapper" role="dialog" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:20px;z-index:5000">
    This website uses cookies. By continuing you consent to our use of cookies for analytics and personalization.
    <button onclick="window.__accepted=true">Allow all</button>
    <button id="generic-decline"
      onclick="window.__rejected=true;document.querySelector('.cmp-wrapper').remove()">Decline all cookies</button>
    <a href="#">Cookie settings</a>
  </div>
</body></html>`;

// Two-step CMP: first layer has only Accept-all + settings. Prefs pane has
// optional toggles (checked), a disabled necessary toggle, and a save button.
const COOKIE_TWO_STEP = `<!DOCTYPE html><html><head><title>t</title></head><body>
  <p id="page-content">Article.</p>
  <div id="cmp-banner" class="cookie-consent" style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:20px;z-index:6000">
    <div id="cmp-layer1">
      We and our partners use cookies to personalize ads and analyze traffic. You can accept or configure your consent choices.
      <button onclick="window.__accepted=true">Accept all</button>
      <button id="cmp-settings" onclick="document.getElementById('cmp-layer1').style.display='none';document.getElementById('cmp-prefs').style.display='block'">Cookie settings</button>
    </div>
    <div id="cmp-prefs" style="display:none">
      Consent preferences for cookies:
      <label><input type="checkbox" id="tg-necessary" checked disabled> Strictly necessary</label>
      <label><input type="checkbox" id="tg-analytics" checked> Analytics cookies</label>
      <label><input type="checkbox" id="tg-marketing" checked> Marketing cookies</label>
      <button onclick="window.__accepted=true">Accept all</button>
      <button id="cmp-save" onclick="window.__saved={necessary:document.getElementById('tg-necessary').checked,analytics:document.getElementById('tg-analytics').checked,marketing:document.getElementById('tg-marketing').checked};document.getElementById('cmp-banner').remove()">Confirm my choices</button>
    </div>
  </div>
</body></html>`;

// Accept-only modal with scroll lock + backdrop: must be hidden and unlocked.
const COOKIE_ACCEPT_ONLY = `<!DOCTYPE html><html><head><title>a</title></head>
<body style="overflow:hidden">
  <p id="page-content">Article.</p>
  <div id="backdrop" class="modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:4000"></div>
  <div id="cookie-modal" class="cookie-consent-popup" aria-modal="true"
    style="position:fixed;top:30%;left:30%;width:40%;background:#fff;padding:24px;z-index:4001">
    We value your privacy. This site uses cookies to give you the best experience.
    By clicking accept you agree to our use of cookies.
    <button onclick="window.__accepted=true">Accept</button>
  </div>
</body></html>`;

const PAGE = `<!DOCTYPE html>
<html><head><title>test</title></head><body>
  <h1>Article title</h1>
  <div class="content" id="real-content" style="width:600px">
    <p>${'Real article text. '.repeat(30)}</p>
  </div>
  <!-- Should be blocked by DNR rule 1 (doubleclick.net, third-party image) -->
  <img id="blocked-img" src="http://doubleclick.net/pixel.gif" width="1" height="1">
  <!-- Tier 1: baseline selector target -->
  <ins class="adsbygoogle" id="t1-adsense" style="display:inline-block;width:300px;height:250px">ad</ins>
  <!-- Tier 2/3: suspicious element -->
  <div id="sponsored-ad-banner" class="ad-banner promo" style="width:728px;height:90px">
    Sponsored: Amazing weight loss trick doctors hate! <a href="https://adclick.example.net/x">Buy now</a>
  </div>
  <!-- Third-party ad iframe -->
  <iframe id="t3-frame" src="http://ads.thirdparty-adserver.test:1/banner" style="width:300px;height:250px"></iframe>
  <!-- Normal nav element that must NOT be hidden automatically -->
  <nav id="site-nav" class="header-navigation" style="width:600px;height:50px;position:relative"><a href="/about">About</a></nav>
</body></html>`;

let failures = 0;
const check = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
  if (!cond) failures++;
};

async function main() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/cookie-known') res.end(COOKIE_KNOWN);
    else if (req.url === '/cookie-generic-reject') res.end(COOKIE_GENERIC_REJECT);
    else if (req.url === '/cookie-accept-only') res.end(COOKIE_ACCEPT_ONLY);
    else if (req.url === '/cookie-two-step') res.end(COOKIE_TWO_STEP);
    else res.end(PAGE);
  }).listen(8917);

  const ctx = await chromium.launchPersistentContext(
    path.join(__dirname, 'profile-' + Date.now()), {
      headless: true,
      // Set CHROMIUM_PATH if your Playwright install lacks a matching browser.
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        '--headless=new',
      ],
    });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  check('service worker registered', !!sw);
  const extId = new URL(sw.url()).host;

  const page = await ctx.newPage();
  await page.goto('http://localhost:8917/');
  await page.waitForTimeout(3500);

  const vis = (id) => page.evaluate((i) => {
    const el = document.getElementById(i);
    return el ? getComputedStyle(el).display !== 'none' : null;
  }, id);

  check('tier1 adsense hidden', (await vis('t1-adsense')) === false);
  check('tier3 sponsored banner hidden', (await vis('sponsored-ad-banner')) === false);
  check('tier3 ad iframe hidden', (await vis('t3-frame')) === false);
  check('real content visible', (await vis('real-content')) === true);
  check('nav visible', (await vis('site-nav')) === true);

  // Use the popup page as a messaging context (it can talk to SW and tabs).
  const popup = await ctx.newPage();
  const popupErrors = [];
  popup.on('pageerror', (e) => popupErrors.push(String(e)));
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForTimeout(1000);
  check('popup renders without page errors', popupErrors.length === 0);
  if (popupErrors.length) console.log('  popup errors:', popupErrors.join(' | '));

  const msg = (m) => popup.evaluate((mm) =>
    new Promise((r) => chrome.runtime.sendMessage(mm, (res) => { void chrome.runtime.lastError; r(res ?? null); })), m);
  const tabIds = await popup.evaluate(() =>
    chrome.tabs.query({ url: 'http://localhost:8917/*' }).then((ts) => ts.map((t) => t.id)));
  const tabId = tabIds[0];
  const tabMsg = (m) => popup.evaluate(([id, mm]) =>
    new Promise((r) => chrome.tabs.sendMessage(id, mm, (res) => { void chrome.runtime.lastError; r(res ?? null); })), [tabId, m]);

  // --- Feature 1: drill-down details ---------------------------------------
  // Reload once: the first-ever navigation races extension cold start, and
  // webRequest events can be missed before the SW's listeners are live.
  await page.reload();
  await page.waitForTimeout(2500);
  const netDetails = await msg({ type: 'get-tab-details', tabId });
  const blockedUrls = (netDetails?.requests ?? []).map((r) => r.url);
  check('blocked request logged with full URL',
    blockedUrls.some((u) => u.includes('doubleclick.net/pixel.gif')));
  console.log('  info: blocked requests =', JSON.stringify(netDetails?.requests));

  const details = await tabMsg({ type: 'bb-get-details' });
  const els = details?.elements ?? [];
  check('element details include AI-hidden banner with reason+confidence',
    els.some((e) => e.idAttr === 'sponsored-ad-banner' && e.reason === 'ai' &&
      e.source === 'heuristic' && e.confidence > 0));
  check('element details include baseline-hidden adsense',
    els.some((e) => e.idAttr === 't1-adsense' && e.reason === 'baseline'));
  console.log('  info: elements =', JSON.stringify(els.map((e) => ({
    i: e.index, id: e.idAttr, tag: e.tag, reason: e.reason, conf: e.confidence }))));

  // Unhide the banner for this page view.
  const banner = els.find((e) => e.idAttr === 'sponsored-ad-banner');
  await tabMsg({ type: 'bb-unhide', index: banner.index });
  check('unhide restores the banner', (await vis('sponsored-ad-banner')) === true);

  // --- Feature 2: element picker -------------------------------------------
  await tabMsg({ type: 'bb-start-picker' });
  await page.bringToFront();
  const navBox = await page.locator('#site-nav').boundingBox();
  // Hover the right side of the nav (away from the link), then click.
  await page.mouse.move(navBox.x + navBox.width - 20, navBox.y + navBox.height / 2);
  await page.waitForTimeout(300);
  const highlighted = await page.evaluate(() =>
    [...document.querySelectorAll('div')].some((d) =>
      d.getAttribute('style')?.includes('2147483647') && d.style.display !== 'none'));
  check('picker highlight overlay visible', highlighted);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(500);
  check('picked nav is hidden', (await vis('site-nav')) === false);

  const manual = await msg({ type: 'get-manual' });
  const rules = manual?.rules?.localhost ?? [];
  check('manual rule persisted for host', rules.length === 1 && rules[0].selector === '#site-nav');
  console.log('  info: manual rules =', JSON.stringify(manual?.rules));

  // Rule survives reload.
  await page.reload();
  await page.waitForTimeout(2500);
  check('manual hide re-applied after reload', (await vis('site-nav')) === false);
  check('real content still visible after reload', (await vis('real-content')) === true);

  // Stats include the manual hide.
  const stats = (await tabMsg({ type: 'bb-get-details' }))?.stats;
  check('stats count manual hide', stats?.manualHidden === 1);

  // Remove the rule → element restored.
  await msg({ type: 'manual-remove', host: 'localhost', selector: '#site-nav' });
  await tabMsg({ type: 'bb-remove-manual', selector: '#site-nav' });
  check('removing manual rule restores nav', (await vis('site-nav')) === true);
  const manual2 = await msg({ type: 'get-manual' });
  check('manual rule gone from storage', !(manual2?.rules?.localhost?.length));

  // --- Feature 3: cookie prompts --------------------------------------------
  const ck = await ctx.newPage();

  const bannerHidden = (page2, id) => page2.evaluate((i) => {
    const el = document.getElementById(i);
    return el ? getComputedStyle(el).display === 'none' : false;
  }, id);
  const nothingClicked = (page2) => page2.evaluate(() =>
    !window.__accepted && !window.__rejected && !window.__saved);

  await ck.goto('http://localhost:8917/cookie-known');
  await ck.waitForTimeout(1800);
  check('known CMP: banner hidden', await bannerHidden(ck, 'onetrust-banner-sdk'));
  check('known CMP: no button was clicked', await nothingClicked(ck));

  await ck.goto('http://localhost:8917/cookie-generic-reject');
  await ck.waitForTimeout(1800);
  check('generic banner: hidden', await ck.evaluate(() =>
    getComputedStyle(document.querySelector('.cmp-wrapper')).display === 'none'));
  check('generic banner: no button was clicked', await nothingClicked(ck));

  await ck.goto('http://localhost:8917/cookie-two-step');
  await ck.waitForTimeout(2000);
  check('two-step CMP: banner hidden', await bannerHidden(ck, 'cmp-banner'));
  check('two-step CMP: no button was clicked, nothing saved', await nothingClicked(ck));

  await ck.goto('http://localhost:8917/cookie-accept-only');
  await ck.waitForTimeout(2500);
  const acceptOnly = await ck.evaluate(() => ({
    accepted: window.__accepted === true,
    modalVisible: getComputedStyle(document.getElementById('cookie-modal')).display !== 'none',
    backdropVisible: getComputedStyle(document.getElementById('backdrop')).display !== 'none',
    bodyOverflow: getComputedStyle(document.body).overflow,
  }));
  check('accept-only: nothing was accepted', !acceptOnly.accepted);
  check('accept-only: modal hidden', !acceptOnly.modalVisible);
  check('accept-only: backdrop hidden', !acceptOnly.backdropVisible);
  check('accept-only: scroll unlocked', acceptOnly.bodyOverflow !== 'hidden');
  const cookieStats = await popup.evaluate((id) =>
    chrome.tabs.query({ url: 'http://localhost:8917/cookie-accept-only' })
      .then(([t]) => new Promise((r) =>
        chrome.tabs.sendMessage(t.id, { type: 'bb-get-details' }, (res) => { void chrome.runtime.lastError; r(res ?? null); }))), null);
  check('cookie records in details with reason',
    (cookieStats?.elements ?? []).some((e) => e.reason === 'cookie' && e.action === 'hidden'));
  check('stats count cookies handled', cookieStats?.stats?.cookiesHandled >= 1);
  console.log('  info: cookie elements =', JSON.stringify(
    (cookieStats?.elements ?? []).filter((e) => e.reason === 'cookie')));

  // Options page still loads clean.
  const options = await ctx.newPage();
  const optErrors = [];
  options.on('pageerror', (e) => optErrors.push(String(e)));
  await options.goto(`chrome-extension://${extId}/options/options.html`);
  await options.waitForTimeout(800);
  check('options renders without page errors', optErrors.length === 0);
  if (optErrors.length) console.log('  options errors:', optErrors.join(' | '));

  await ctx.close();
  server.close();
  console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE TEST CRASH:', e); process.exit(1); });
