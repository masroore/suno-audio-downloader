# Plan: Resumable / background downloads

**Priority:** P3 — reliability  
**Files:** `background.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`  
**Estimated changes:** ~80 lines  
**Depends on:** nothing (but works best after selective-download plan)

---

## Goal

Two related improvements:

1. **Background discovery** — discovery continues even if the popup is closed, because
   the current implementation awaits `sendMessage` from the popup which hangs when
   the popup closes.

2. **Resumable downloads** — if a download run is cancelled or interrupted, the set of
   completed clip IDs is persisted to `chrome.storage.local`. On the next run the user
   can click "Resume" to skip already-completed clips, rather than re-downloading
   everything.

These two goals are implemented independently below. Implement them together or
separately.

---

## Part A — Background discovery (fire-and-forget)

### Problem

`popup.js` calls:
```js
const res = await send(Actions.DISCOVER, { limit: getLimit() });
```

`background.js` returns the result only after the entire discovery is done. If the popup
closes before that, Chrome kills the message port and `discoverClips` receives an
unhandled rejection from `broadcast`, potentially leaving `isDiscovering = true` stuck.

### Fix

Convert `DISCOVER` to a fire-and-forget pattern: the background starts discovery
immediately, returns `{ success: true, started: true }`, and the popup polls state on
re-open.

#### background.js — Step A1

Find the `DISCOVER` case in the message handler (background.js ~line 648):
```js
      case Actions.DISCOVER:
        sendResponse(await discoverClips(message.limit || 0));
        break;
```

Replace with:
```js
      case Actions.DISCOVER:
        if (isDiscovering) {
          sendResponse({ success: false, error: "Discovery already in progress" });
          break;
        }
        // Fire and forget — popup polls via GET_STATE / DISCOVER_PROGRESS broadcasts
        discoverClips(message.limit || 0).catch((err) => {
          console.error("[suno-dl] background discover error", err);
        });
        sendResponse({ success: true, started: true });
        break;
```

#### popup.js — Step A2

The discover button click handler currently does:
```js
  const res = await send(Actions.DISCOVER, { limit: getLimit() });
  setBusy(false);
  if (!res.success) {
    setStatus(res.error || "Discover failed", "error");
    return;
  }
  clipCount = res.count;
  renderClips(res.clips || []);
  el.btnDownload.disabled = clipCount === 0;
  setStatus(`Connected · ${clipCount} clips`, "ok");
```

Replace with:
```js
  const res = await send(Actions.DISCOVER, { limit: getLimit() });
  if (!res.success) {
    setBusy(false);
    setStatus(res.error || "Discover failed", "error");
    return;
  }
  // Discovery is now running in the background.
  // Progress arrives via DISCOVER_PROGRESS messages (already handled).
  // setBusy(false) and renderClips() happen inside the DISCOVER_PROGRESS handler
  // when phase === "complete" (via refreshState()).
  setStatus("Discovering…", "busy");
```

No other changes needed — `DISCOVER_PROGRESS` messages already call `refreshState()`
on `phase === "complete"`, which re-renders the clip list.

---

## Part B — Resumable downloads

### Data model

Add `completedClipIds: []` to `chrome.storage.local`. After each clip finishes without
error, its ID is appended. When a run completes cleanly (not cancelled), the list is
cleared. On popup open, if `completedClipIds` is non-empty and clips are loaded, show
a "Resume" button.

#### background.js — Step B1: load/save completedClipIds

In `loadState` (background.js ~line 46), add to the `chrome.storage.local.get` call:
```js
  const stored = await chrome.storage.local.get([
    "token", "userId", "deviceId", "downloadPath", "completedClipIds"
  ]);
```

Add to the state object (background.js ~line 25, inside `let state = { ... }`):
```js
  completedClipIds: [],   // IDs of clips successfully downloaded in a prior run
```

After the `chrome.storage.local.get` call in `loadState`, add:
```js
  if (Array.isArray(stored.completedClipIds)) {
    state.completedClipIds = stored.completedClipIds;
  }
```

#### background.js — Step B2: persist a completed clip ID

In `runDownloadQueue`'s worker, after `completed++` and before the `broadcast` call
(~line 555), add:
```js
      // Persist this clip as completed (only if no errors)
      if (!errors.some((e) => e.id === clip.id)) {
        state.completedClipIds.push(clip.id);
        chrome.storage.local.set({ completedClipIds: state.completedClipIds });
      }
```

#### background.js — Step B3: clear completedClipIds on clean finish

In `startDownload`, after the `runDownloadQueue` call, find:
```js
    state.downloadProgress.phase = cancelRequested ? "cancelled" : "complete";
```

Add immediately before this line:
```js
    if (!cancelRequested && errors.length === 0) {
      // Clean run — reset resume state
      state.completedClipIds = [];
      await chrome.storage.local.remove("completedClipIds");
    }
```

#### background.js — Step B4: expose completedClipIds in GET_STATE

Find the `GET_STATE` response (background.js ~line 631):
```js
        sendResponse({
          success: true,
          connected: !!(state.token && state.userId),
          downloadPath: state.downloadPath,
          clipCount: state.clips.length,
          clips: clipsForPopup(state.clips),
          discoverProgress: state.discoverProgress,
          downloadProgress: state.downloadProgress,
          isDiscovering,
          isDownloading,
        });
```

Add `completedClipIds: state.completedClipIds` to the response object:
```js
        sendResponse({
          success: true,
          connected: !!(state.token && state.userId),
          downloadPath: state.downloadPath,
          clipCount: state.clips.length,
          clips: clipsForPopup(state.clips),
          discoverProgress: state.discoverProgress,
          downloadProgress: state.downloadProgress,
          isDiscovering,
          isDownloading,
          completedClipIds: state.completedClipIds,
        });
```

#### background.js — Step B5: add RESUME_DOWNLOAD action

Add `RESUME_DOWNLOAD: "resumeDownload"` to the `Actions` object in background.js
(and the matching entry in popup.js `Actions` object).

In the message handler switch, add a new case before `default`:
```js
      case Actions.RESUME_DOWNLOAD: {
        // Re-run startDownload but exclude already-completed clips
        const remaining = state.clips.filter(
          (c) => !state.completedClipIds.includes(c.id)
        );
        if (remaining.length === 0) {
          sendResponse({ success: true, completed: 0, failed: 0, errors: [], cancelled: false });
          break;
        }
        // Temporarily override clips for this run
        const originalClips = state.clips;
        state.clips = remaining;
        const result = await startDownload(message.limit || 0);
        state.clips = originalClips;
        sendResponse(result);
        break;
      }
```

---

### popup/popup.html changes

#### Step B6 — Add Resume button

Find the actions section (popup.html ~lines 31–36):
```html
    <section class="actions">
      <button id="btn-connect" type="button">Connect</button>
      <button id="btn-discover" type="button" disabled>Discover</button>
      <button id="btn-download" type="button" disabled>Download all</button>
      <button id="btn-cancel" type="button" class="secondary" disabled>Cancel</button>
    </section>
```

Replace with:
```html
    <section class="actions">
      <button id="btn-connect" type="button">Connect</button>
      <button id="btn-discover" type="button" disabled>Discover</button>
      <button id="btn-download" type="button" disabled>Download all</button>
      <button id="btn-resume" type="button" class="secondary" disabled hidden>Resume</button>
      <button id="btn-cancel" type="button" class="secondary" disabled>Cancel</button>
    </section>
```

---

### popup/popup.js changes

#### Step B7 — Add element reference and wire up Resume

In `const el = { ... }`, add:
```js
  btnResume: document.getElementById("btn-resume"),
```

In `refreshState`, after the `setBusy` calls, add:
```js
  // Show Resume button when there are persisted completed IDs and remaining clips
  const hasResumable = res.completedClipIds?.length > 0 && res.clipCount > 0
    && res.completedClipIds.length < res.clipCount;
  el.btnResume.hidden = !hasResumable;
  el.btnResume.disabled = hasResumable ? busy : true;
  if (hasResumable) {
    const remaining = res.clipCount - res.completedClipIds.length;
    el.btnResume.textContent = `Resume (${remaining} left)`;
  }
```

Add the click handler (after the Cancel button handler):
```js
el.btnResume.addEventListener("click", async () => {
  setBusy(true);
  el.btnCancel.disabled = false;
  const res = await send(Actions.RESUME_DOWNLOAD, { limit: getLimit() });
  setBusy(false);
  el.btnCancel.disabled = true;
  el.btnResume.hidden = true;
  if (!res.success) {
    setStatus(res.error || "Resume failed", "error");
    return;
  }
  const failed = res.failed || 0;
  setStatus(
    res.cancelled
      ? "Download cancelled"
      : failed
        ? `Done · ${res.completed} ok, ${failed} failed`
        : `Downloaded ${res.completed} file(s)`,
    failed ? "error" : "ok",
  );
});
```

Also update `setBusy` to account for the Resume button:
Find:
```js
function setBusy(busy) {
  el.btnConnect.disabled = busy;
  el.btnDiscover.disabled = busy || !connected;
  el.btnDownload.disabled = busy || clipCount === 0;
}
```
Replace with:
```js
function setBusy(busy) {
  el.btnConnect.disabled = busy;
  el.btnDiscover.disabled = busy || !connected;
  el.btnDownload.disabled = busy || clipCount === 0;
  if (!el.btnResume.hidden) {
    el.btnResume.disabled = busy;
  }
}
```

---

### popup/popup.css changes

No new styles needed — `btn-resume` uses the existing `.secondary` button style.

---

## Verification

**Part A — Background discovery**
1. Click Discover. Immediately close the popup.
2. Wait 10–15 seconds. Re-open popup.
3. Confirm clips are listed and status shows "Connected · N clips".
4. Confirm no stuck `isDiscovering` state (Discover button is re-enabled).

**Part B — Resumable downloads**
1. Discover 6 clips. Start downloading. Cancel after 2–3 complete.
2. Close and re-open popup. Confirm "Resume (N left)" button appears with the correct
   remaining count.
3. Click Resume. Confirm only the remaining clips are downloaded (not the already-done ones).
4. After a clean full-run (no cancel, no errors), re-open popup.
   Confirm the Resume button does not appear.
5. Check `chrome.storage.local` in the service worker console:
   `chrome.storage.local.get(null, console.log)` — confirm `completedClipIds` is absent
   after a clean run and present (with IDs) after a cancelled run.
