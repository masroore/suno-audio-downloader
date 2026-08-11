# Plan: Disable DEBUG flag for production

**Priority:** P0 — housekeeping  
**File:** `background.js` only  
**Estimated changes:** 2 lines

---

## Problem

`background.js` line 8:
```js
// TODO: remove after production / once discover is stable
const DEBUG = true;
```

Every API request and response body (up to 2000 chars) is logged to the service worker
console. This leaks auth tokens in developer tools and wastes memory in production.

---

## Fix

Gate `DEBUG` on whether the extension is running as an unpacked (developer) load.
Chrome exposes this via `chrome.runtime.getManifest().update_url` — packed extensions
from the Web Store have an `update_url`; unpacked developer loads do not.

---

## Step-by-step

### Step 1 — Replace the DEBUG constant

Find (background.js line 8):
```js
const DEBUG = true;
```

Replace with:
```js
// true only when loaded unpacked (no update_url = developer mode)
const DEBUG = !chrome.runtime.getManifest().update_url;
```

### Step 2 — Remove the TODO comment on line 7

Find:
```js
// TODO: remove after production / once discover is stable
```

Delete that line entirely (it is no longer needed).

---

## Verification

1. Load the extension **unpacked** from `chrome://extensions`. Open the service worker
   console. Trigger a Connect + Discover. Confirm `[suno-dl]` debug lines still appear.
2. Pack the extension (`chrome://extensions` → Pack extension). Install the `.crx`.
   Open service worker console. Trigger Connect + Discover. Confirm **no** `[suno-dl]`
   debug lines appear (only the startup log from `console.log` on line 664, which is
   intentional and not gated by `DEBUG`).
