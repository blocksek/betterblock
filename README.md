# BetterBlock — Local AI Ad Blocker

A Chrome extension that blocks ads using an **on-device LLM** (Gemini Nano via
Chrome's built-in Prompt API). Privacy is the whole point:

- **Zero network requests.** The extension contains no `fetch`, no XHR, no
  remote filter-list updates, no telemetry, no analytics. You can grep the
  source to confirm. (The `webRequest` permission is used purely
  observationally — to log which requests *Chrome already blocked* so the
  popup can show them to you; the log is per-tab, session-only, local.)
- **All AI inference is on-device.** Gemini Nano is downloaded and managed by
  Chrome itself and runs locally. Page content used for classification never
  leaves your machine.
- **All state is local.** Verdict cache, learned rules and settings live in
  `chrome.storage.local` in your browser profile.

## How it works

An LLM is far too slow to sit in the network request path, so BetterBlock
layers three tiers, cheapest first:

```
┌────────────────────────────────────────────────────────────────────┐
│ Tier 1 · Network      declarativeNetRequest static rules block     │
│                       known ad/tracker domains before any bytes    │
│                       are fetched. Blocked count shows on badge.   │
├────────────────────────────────────────────────────────────────────┤
│ Tier 2 · Heuristics   The content script finds *candidate* ads:    │
│                       suspicious ids/classes, third-party iframes, │
│                       IAB banner sizes, floating overlays. Obvious │
│                       ad containers are hidden instantly via CSS.  │
├────────────────────────────────────────────────────────────────────┤
│ Tier 3 · Local LLM    Ambiguous candidates are described (tag,     │
│                       size, hosts, text excerpt) and classified by │
│                       Gemini Nano with a JSON-schema-constrained   │
│                       prompt. Verdicts above your confidence       │
│                       threshold hide the element — and are cached  │
│                       so the model runs once per element shape,    │
│                       not once per page view.                      │
└────────────────────────────────────────────────────────────────────┘
```

The AI also **learns network rules**: when it is highly confident
(≥ 0.85) that a third-party iframe host serves ads, that host is added as a
dynamic `declarativeNetRequest` block rule, so on future page loads the ad is
never even fetched. Learned domains are listed in Settings, capped, guarded by
a never-block list of critical infrastructure (CDNs, captcha providers, major
platforms), and removable with one click.

### When Gemini Nano isn't available

BetterBlock automatically falls back to its deterministic heuristic scorer
(same signals as Tier 2, thresholded) so blocking keeps working on machines
that can't run the model. The classifier is a pluggable interface
(`src/llm.js`), so other fully-local backends (WebLLM, transformers.js with a
small ONNX classifier) can be added later.

## Cookie-consent prompts

BetterBlock also deals with cookie banners — privacy-first, meaning it will
**never accept cookies on your behalf**. Default mode is *Reject & hide*:

1. **Known CMPs** (OneTrust, Cookiebot, Didomi, Quantcast, Sourcepoint,
   Usercentrics, Google Funding Choices, Osano, CookieYes, TrustArc, …) get
   their documented "reject all" button clicked directly.
2. **Generic banners** are detected by overlay/banner geometry plus
   cookie/consent wording, and their reject button is found by multilingual
   text matching ("reject all", "only necessary", "alle ablehnen",
   "tout refuser", "continuer sans accepter", …).
3. **Odd phrasing?** The button labels are handed to the on-device LLM, which
   picks the rejecting button (or none) via structured output.
4. **No reject path** (accept-only banners) → the banner is hidden and its
   side effects undone: body scroll locks removed, backdrop overlays cleared.

Every handled prompt appears in the popup's element list with a `rejected` or
`cookie` chip (hover shows which button was clicked). Modes in Settings:
*Reject & hide* / *Just hide* (never clicks anything) / *Off*.

## Requirements for the AI backend

Gemini Nano via the Prompt API needs:

- Chrome 138+ (the `LanguageModel` API is available to extension service
  workers from 138 stable).
- A supported device: ~22 GB free disk for the model, and either a GPU with
  > 4 GB VRAM or a recent CPU. Chrome decides eligibility itself.
- On some channels you may need to enable
  `chrome://flags/#prompt-api-for-gemini-nano` and
  `chrome://flags/#optimization-guide-on-device-model` (set to
  *Enabled BypassPerfRequirement*), then check that
  `chrome://components` shows **Optimization Guide On Device Model**.

The popup shows live AI status: **Gemini Nano active**, **Downloading…** (with
progress), **Enable AI** (one-time model download), or **Heuristic mode**.

## Install (developer mode)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. Click **Load unpacked** and select the repo folder.
4. Click the BetterBlock icon → if it says "On-device AI available", press
   **Enable AI** to trigger the one-time model download.

## Usage

- The **badge** counts network requests blocked on the current tab (counted by
  Chrome's declarativeNetRequest engine — no request observation needed).
- The **popup** shows blocked requests, hidden elements, AI status, and
  per-site / global kill switches.
- **Click either counter** to drill into exactly what was blocked:
  - *Requests blocked* lists each blocked request (host, path, resource type;
    hover for the full URL), newest first.
  - *Elements hidden* lists every hidden element with why: `AI 92%`
    (Gemini Nano verdict + confidence), `heur` (heuristic fallback), `filter`
    (baseline cosmetic CSS) or `you` (picked manually) — each with an
    **unhide** button.
- **Hide any element yourself** (Safari-style): popup → *"⌖ Hide an element on
  this page…"*, then hover to highlight, **↑/↓** to widen/narrow the selection,
  click to hide, Esc to cancel. Picks are saved as per-site rules and re-applied
  on every visit (even if the site is allowlisted — it's your explicit choice).
  Undo from the popup's element list or Settings → *Elements you hid*.
- **Settings** (options page): AI confidence threshold, toggle rule-learning,
  allowlist, review/remove AI-learned block rules and manually hidden
  elements, clear the verdict cache.

## Repository layout

```
manifest.json          MV3 manifest (minimum Chrome 138)
rules/baseline.json    Static declarativeNetRequest baseline blocklist
src/background.js      Service worker: cache, learned rules, messaging
src/llm.js             Local classifier: Gemini Nano + heuristic fallback
src/content.js         Candidate discovery, scoring, element hiding
popup/                 Toolbar popup UI
options/               Settings page
scripts/gen_icons.py   Icon generator (stdlib-only PNG writer)
```

## Design notes & limitations

- The LLM classifies **element descriptions**, not raw pages: tag, id/class,
  geometry, source hosts, link hosts, and a ≤160-char text excerpt. Small
  payloads keep inference fast and well inside Nano's context window.
- Batches are capped (24 candidates/scan, 80/page) and verdicts are cached by
  a stable feature hash, so steady-state browsing rarely invokes the model.
- False-positive safety: the system prompt instructs "when uncertain, prefer
  not-ad"; the confidence threshold is user-tunable; huge page-dominating
  containers are never candidates; allowlisting a site disables everything.
- This is not a filter-list engine — Tier 1 ships a compact curated blocklist,
  not EasyList. The AI tiers exist precisely to catch what static lists miss,
  and everything stays local.
