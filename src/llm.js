// Local-only ad classifier.
//
// Primary backend: Gemini Nano via Chrome's built-in Prompt API
// (the `LanguageModel` global, available in extension service workers
// from Chrome 138). Fallback backend: a deterministic heuristic score
// computed by the content script — so the extension keeps working on
// machines where the on-device model can't run.
//
// Privacy invariant: neither backend performs any network I/O. The model
// weights are managed by Chrome itself and inference runs on-device.

const SYSTEM_PROMPT = `You classify elements from a web page as advertisements or not.
You receive a JSON array of element records. Each record describes one DOM element:
tag, id, classes, width/height in px, position (static/fixed/sticky), zIndex,
srcHost (host an iframe/img/script loads from), pageHost (the site being visited),
thirdParty (srcHost differs from pageHost), linkHosts (hosts of links inside it),
and a short text excerpt.

An element IS an ad if its primary purpose is to display paid, promoted, or sponsored
content from an advertiser: display banners, ad iframes, sponsored/promoted widgets,
"around the web" content-recommendation units, interstitial or floating promo overlays.

An element is NOT an ad if it is: site navigation, article/media content the user came
to see, search results, comments, cookie/consent banners, login or paywall prompts,
or the site's own functional UI. When genuinely uncertain, prefer isAd=false with low
confidence — never break a page to block a maybe-ad.

Respond ONLY with JSON that matches the requested schema: one verdict per input record,
matching each record's "id". confidence is 0.0-1.0.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'number' },
          isAd: { type: 'boolean' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['id', 'isAd', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

const BATCH_SIZE = 6;
// Score at/above which the heuristic fallback calls an element an ad.
// Scores come from the content script's scoreElement() (roughly 0-10 scale).
const HEURISTIC_AD_SCORE = 4;

function languageModelApi() {
  // Stable global (Chrome 138+); older builds exposed it under `self.ai`.
  if (typeof LanguageModel !== 'undefined') return LanguageModel;
  if (typeof self !== 'undefined' && self.ai?.languageModel) return self.ai.languageModel;
  return null;
}

export class LocalClassifier {
  constructor() {
    this.session = null;
    this.sessionPromise = null;
    this.queue = Promise.resolve();
    this.downloadProgress = 0;
    // 'ready' | 'downloadable' | 'downloading' | 'fallback'
    this.state = 'fallback';
    this.stateKnown = false;
  }

  async availability() {
    const api = languageModelApi();
    if (!api) return 'unavailable';
    try {
      return await api.availability();
    } catch {
      return 'unavailable';
    }
  }

  async refreshState() {
    const avail = await this.availability();
    if (avail === 'available') this.state = this.session ? 'ready' : 'downloadable';
    else if (avail === 'downloadable') this.state = 'downloadable';
    else if (avail === 'downloading') this.state = 'downloading';
    else this.state = 'fallback';
    if (this.session) this.state = 'ready';
    this.stateKnown = true;
    return this.state;
  }

  async status() {
    if (!this.stateKnown) await this.refreshState();
    return {
      backend: this.state === 'ready' ? 'gemini-nano' : 'heuristic',
      state: this.state,
      downloadProgress: this.downloadProgress,
    };
  }

  // Create (or reuse) a Gemini Nano session. Triggers the model download
  // when the model is downloadable; progress is tracked for the popup.
  async ensureSession() {
    if (this.session) return this.session;
    if (this.sessionPromise) return this.sessionPromise;
    const api = languageModelApi();
    if (!api) return null;

    this.sessionPromise = (async () => {
      const avail = await this.availability();
      if (avail === 'unavailable') {
        this.state = 'fallback';
        return null;
      }
      if (avail !== 'available') this.state = 'downloading';
      try {
        const session = await api.create({
          initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
          monitor: (m) => {
            m.addEventListener('downloadprogress', (e) => {
              this.downloadProgress = e.loaded ?? 0;
              this.state = this.downloadProgress >= 1 ? 'ready' : 'downloading';
            });
          },
        });
        this.session = session;
        this.state = 'ready';
        return session;
      } catch (err) {
        console.warn('BetterBlock: could not create Gemini Nano session', err);
        await this.refreshState();
        return null;
      } finally {
        this.sessionPromise = null;
      }
    })();
    return this.sessionPromise;
  }

  // items: [{ key, features }] where features includes a `heuristicScore`
  // precomputed by the content script. Returns { key: verdict } with
  // verdict = { isAd, confidence, source }.
  async classifyBatch(items) {
    // Serialize prompts: one inference at a time keeps memory bounded and
    // avoids racing session use across tabs.
    const run = this.queue.then(() => this.#classify(items));
    this.queue = run.catch(() => {});
    return run;
  }

  async #classify(items) {
    const out = {};
    const session = await this.ensureSession();

    if (!session) {
      for (const item of items) out[item.key] = heuristicVerdict(item.features);
      return out;
    }

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        const verdicts = await this.#promptBatch(session, batch);
        Object.assign(out, verdicts);
      } catch (err) {
        console.warn('BetterBlock: prompt failed, using heuristic for batch', err);
        // A broken session (e.g. destroyed, out of tokens) shouldn't wedge
        // every future batch — drop it and let the next call recreate it.
        this.session = null;
        for (const item of batch) out[item.key] = heuristicVerdict(item.features);
      }
    }
    return out;
  }

  // Given the visible button labels of a cookie-consent prompt, identify
  // the button that rejects non-essential cookies and the one that opens
  // the settings/preferences screen (each -1 when absent). Used only when
  // the content script's own multilingual regexes found nothing, so this
  // handles the odd phrasings ("I'd rather not", uncommon languages, …).
  async pickRejectButton(texts) {
    const none = { rejectIndex: -1, settingsIndex: -1, source: 'heuristic' };
    const labels = (texts ?? []).slice(0, 12).map((t) => String(t).slice(0, 60));
    if (!labels.length) return none;
    const session = await this.ensureSession();
    if (!session) return none;

    const run = this.queue.then(async () => {
      const prompt =
        `A website cookie-consent dialog has these buttons (JSON array, ` +
        `0-indexed):\n${JSON.stringify(labels)}\n` +
        `Identify two buttons:\n` +
        `- rejectIndex: the button that REJECTS or DECLINES all non-essential ` +
        `cookies (e.g. "reject all", "only necessary", "continue without agreeing")\n` +
        `- settingsIndex: the button that opens cookie settings/preferences ` +
        `(e.g. "manage preferences", "customize", "options")\n` +
        `Never point either at a button that accepts or enables cookies. ` +
        `Use -1 for any that is absent.`;
      const raw = await session.prompt(prompt, {
        responseConstraint: {
          type: 'object',
          properties: {
            rejectIndex: { type: 'integer', minimum: -1 },
            settingsIndex: { type: 'integer', minimum: -1 },
          },
          required: ['rejectIndex', 'settingsIndex'],
          additionalProperties: false,
        },
      });
      const parsed = JSON.parse(raw);
      const idx = (v) => (Number.isInteger(v) && v >= 0 && v < labels.length ? v : -1);
      return {
        rejectIndex: idx(parsed.rejectIndex),
        settingsIndex: idx(parsed.settingsIndex),
        source: 'gemini-nano',
      };
    });
    this.queue = run.catch(() => {});
    return run.catch(() => none);
  }

  async #promptBatch(session, batch) {
    const records = batch.map((item, i) => ({ id: i, ...sanitizeFeatures(item.features) }));
    const prompt = `Classify these page elements:\n${JSON.stringify(records)}`;
    const raw = await session.prompt(prompt, { responseConstraint: RESPONSE_SCHEMA });
    const parsed = JSON.parse(raw);

    const out = {};
    for (const v of parsed.verdicts ?? []) {
      const item = batch[v.id];
      if (!item) continue;
      out[item.key] = {
        isAd: Boolean(v.isAd),
        confidence: clamp01(v.confidence),
        source: 'gemini-nano',
      };
    }
    // The model must answer for every record; fill any gaps heuristically.
    for (const item of batch) {
      if (!out[item.key]) out[item.key] = heuristicVerdict(item.features);
    }
    return out;
  }
}

// Strip fields the model shouldn't see (the heuristic score would anchor it)
// and cap string lengths so batches stay well under the context window.
function sanitizeFeatures(f) {
  return {
    tag: f.tag,
    idAttr: trunc(f.idAttr, 80),
    classes: trunc(f.classes, 120),
    width: f.width,
    height: f.height,
    position: f.position,
    zIndex: f.zIndex,
    srcHost: trunc(f.srcHost, 100),
    pageHost: trunc(f.pageHost, 100),
    thirdParty: f.thirdParty,
    linkHosts: (f.linkHosts ?? []).slice(0, 4).map((h) => trunc(h, 100)),
    text: trunc(f.text, 160),
  };
}

export function heuristicVerdict(features) {
  const score = features?.heuristicScore ?? 0;
  const isAd = score >= HEURISTIC_AD_SCORE;
  // Map score distance from threshold onto a modest confidence band.
  const confidence = clamp01(0.5 + Math.min(Math.abs(score - HEURISTIC_AD_SCORE), 4) * 0.1);
  return { isAd, confidence, source: 'heuristic' };
}

function trunc(s, n) {
  if (typeof s !== 'string') return s ?? '';
  return s.length > n ? s.slice(0, n) : s;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
