# Enhancement Plans — Suno Audio Downloader

All plans are self-contained. Each file has a **Files to edit**, **Step-by-step**, and **Verification** section. Implement them independently in any order unless a dependency is noted.

| Plan file | Title | Priority |
|---|---|---|
| [plan-fix-429-retry.md](plan-fix-429-retry.md) | Fix infinite 429 retry loop | P0 — bug |
| [plan-selective-download.md](plan-selective-download.md) | Selective (checkbox) download | P1 — feature |
| [plan-lyrics-export.md](plan-lyrics-export.md) | Lyrics .txt sidecar export | P2 — feature |
| [plan-video-download.md](plan-video-download.md) | Optional video download | P2 — feature |
| [plan-skip-existing.md](plan-skip-existing.md) | Skip already-downloaded files | P2 — feature |
| [plan-per-clip-status.md](plan-per-clip-status.md) | Per-clip download status in UI | P3 — UX |
| [plan-resumable-downloads.md](plan-resumable-downloads.md) | Resumable / background downloads | P3 — reliability |
| [plan-disable-debug.md](plan-disable-debug.md) | Disable DEBUG flag for production | P0 — housekeeping |

## Key file map (read before touching anything)

```
background.js          — service worker; all API, state, download logic
popup/popup.html       — extension popup markup
popup/popup.js         — popup event handlers and rendering
popup/popup.css        — popup styles
manifest.json          — extension manifest (permissions, version)
```

## Shared constants in background.js (lines 1–8)

```js
const API_DELAY_MS = 500;
const MAX_RETRIES = 3;
const CONCURRENT_DOWNLOADS = 2;
const DOWNLOAD_TIMEOUT_MS = 300000;
const FEED_PAGE_LIMIT = 20;
const DEBUG = true;   // ← must be false in production
```

## Message action keys (background.js lines 14–23, popup.js lines 1–10)

Both files define the same `Actions` object. Any new action must be added to **both**.

## State shape (background.js lines 25–39)

```js
let state = {
  token, userId, deviceId, downloadPath,
  clips[],            // normalizeClip() objects — each has .clipData
  discoverProgress,   // { phase, page, count }
  downloadProgress,   // { phase, current, total, currentTitle, errors[] }
};
```

`clipsForPopup()` strips `.clipData` before sending clips to the popup. Never send the raw `state.clips` array to the popup directly.
