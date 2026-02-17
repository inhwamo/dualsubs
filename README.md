# Claude Dual Subs

A Chrome extension that adds dual-language subtitle overlays to YouTube videos, powered by Claude AI translation. Designed for language learners who want to watch foreign-language content with both the original subtitles and an English (or other language) translation displayed simultaneously.

## Features

- **Dual subtitle overlay** — Original and translated subtitles displayed together over the YouTube player
- **Word-level karaoke highlighting** — Individual words highlight in sync with the audio using YouTube's word-level timing data
- **Click-to-seek** — Click any word in the original subtitle to jump the video to that word's timestamp
- **Dictionary hover** — Hover over French words to see English definitions from a bundled offline dictionary (405K entries from Wiktionary)
- **Multi-word phrase lookup** — Recognizes common phrases like "il y a", "c'est-a-dire", etc. (17K phrases)
- **Expanded definitions** — Press `Shift` while hovering to toggle between compact and expanded dictionary views showing multiple senses and base word forms
- **Display modes** — Toggle between: Both (original + translation), Original only, Translation only, or Off
- **Subtitle navigation** — Jump between subtitle segments with `[` / `]` keys or on-screen buttons
- **Model selection** — Choose between Haiku 4.5 (fast/cheap), Sonnet 4.5 (balanced), or Opus 4.6 (best quality)
- **Translation caching** — Translations are cached per video so you don't pay twice
- **Survives app switching** — Translation runs in the content script, not the service worker, so it continues even when you switch away from Chrome

## Installation

1. Clone or download this repository
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `dualsubs` folder
5. Click the extension icon, enter your [Anthropic API key](https://console.anthropic.com/), and save

## Usage

1. Navigate to a YouTube video with subtitles in your source language
2. Click the Claude Dual Subs extension icon
3. Set source language (e.g., French) and target language (e.g., English)
4. Choose a translation model
5. Click **Translate Current Video**
6. The extension captures subtitles, sends them to Claude for translation, and overlays the results

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `]` | Jump to next subtitle |
| `[` | Jump to previous subtitle |
| `Shift` | Toggle expanded dictionary tooltip (while hovering a word) |

### Display Modes

Use the toggle in the popup to switch between:
- **Both** — Original subtitle on top, translation below
- **Original** — Source language only
- **Translation** — Translated text only
- **Off** — Hide all subtitles

## How It Works

### Architecture

The extension uses three execution contexts that communicate via message passing:

```
┌─────────────────────────────────────────────────┐
│ YouTube Page                                    │
│                                                 │
│  ┌──────────────┐    window.postMessage    ┌────────────┐
│  │  content.js  │ ◄─────────────────────► │  page.js   │
│  │  (ISOLATED)  │                          │  (MAIN)    │
│  └──────┬───────┘                          └────────────┘
│         │                                   Intercepts XHR
│         │ chrome.runtime                    Triggers captions
│         │ .sendMessage                      via player API
│         │
│  ┌──────▼───────┐
│  │background.js │
│  │  (SERVICE    │
│  │   WORKER)    │
│  └──────────────┘
│   URL fetching only
└─────────────────────────────────────────────────┘
```

**`page.js`** (MAIN world) — Runs in YouTube's page context. Monkey-patches `XMLHttpRequest` and `fetch` to intercept YouTube's own timedtext (subtitle) requests. This is necessary because YouTube's caption URLs include an `exp=xpe` experiment flag that causes direct fetches to return empty responses. By intercepting YouTube's own requests, we get the actual subtitle data. It also triggers caption loading via `player.setOption('captions', 'track', ...)`.

**`content.js`** (ISOLATED world) — The core of the extension. Handles:
- Communicating with `page.js` via `window.postMessage` to request subtitle data
- Parsing JSON3 and XML subtitle formats, preserving word-level timing
- Making translation API calls directly to `api.anthropic.com` (not through the service worker, to avoid MV3 lifecycle issues)
- Rendering the overlay with word spans, karaoke highlighting, and dictionary tooltips
- Managing display modes, subtitle navigation, and caching
- Loading and querying the bundled dictionaries

**`background.js`** (Service Worker) — Minimal. Only handles generic URL fetching. Translation was moved out of the service worker because MV3 terminates it when the user switches apps, which would kill in-progress translations.

### Subtitle Capture Flow

1. Content script asks page script for available caption tracks
2. Page script reads tracks from `player.getOption('captions', 'tracklist')` or `ytInitialPlayerResponse`
3. Content script requests subtitles for a specific language
4. Page script triggers `player.setOption('captions', 'track', trackObj)` to make YouTube fetch the captions
5. The monkey-patched XHR intercepts the timedtext response and passes it back
6. Content script parses the JSON3 data, extracting word-level timing from segments

### Translation

Subtitles are sent to Claude in batches of 150 lines. Each line is numbered (`[0]`, `[1]`, ...) and the system prompt enforces strict 1:1 line correspondence — Claude must translate each numbered line independently without merging or redistributing meaning across lines. This keeps translations time-aligned with the original.

### Dictionary

The French-English dictionary is generated from [Wiktionary data](https://kaikki.org/dictionary/French/) using `dictionaries/generate_dict.py`. It produces:

- **`fr-en.json`** (~30 MB, bundled) — 405K entries with definitions, parts of speech, gender, base word references, and up to 4 senses per word
- **`fr-en-phrases.json`** (~1.2 MB, bundled) — 17K multi-word phrases

Word lookup handles French-specific patterns:
- **Elisions**: `l'homme` → looks up "homme"
- **Hyphenation**: `peut-être` → tries full word, then parts
- **Accent stripping**: fuzzy fallback for accented characters
- **Plural stripping**: basic trailing 's' removal
- **Inflected forms**: resolves to base word (e.g., "ponctueé" → shows definition of "ponctué")

## File Structure

```
dualsubs/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker (URL fetching only)
├── content.js             # Main content script (translation, overlay, dictionary)
├── page.js                # MAIN world script (XHR interception, caption triggering)
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic (settings, status, display toggle)
├── popup.css              # Popup styles
├── styles.css             # Overlay and tooltip styles
├── icons/
│   ├── icon48.png
│   └── icon128.png
└── dictionaries/
    ├── fr-en.json          # French-English dictionary (bundled)
    ├── fr-en-phrases.json  # French-English phrases (bundled)
    └── generate_dict.py    # Dictionary generator from Wiktionary data
```

## Cost

Translation cost depends on subtitle length and model:
- **Haiku 4.5**: ~$0.01-0.03 per video (recommended for most use)
- **Sonnet 4.5**: ~$0.05-0.15 per video
- **Opus 4.6**: ~$0.15-0.50 per video

Translations are cached locally, so rewatching a video costs nothing.

## Privacy

- Your API key is stored locally in `chrome.storage.local` and never sent anywhere except `api.anthropic.com`
- Subtitle text is sent to the Anthropic API for translation
- Dictionary lookups are entirely offline — no network requests
- No analytics, tracking, or external services
