# Plan: Per-clip download status in UI

**Priority:** P3 — UX  
**Files:** `popup/popup.html`, `popup/popup.js`, `popup/popup.css`  
**Estimated changes:** ~60 lines  
**Depends on:** nothing (but pairs well with the selective-download plan)

---

## Goal

After a download run, each clip row in the list is visually marked:
- ✓ (green) — all assets downloaded successfully
- ✗ (red) — at least one asset failed
- – (grey) — not included in the run (either deselected or cancelled before reached)

The per-clip status is derived from `progress.errors[]` (already broadcast from the
background) and updated in real time as the download progresses.

---

## Data flow

The background already broadcasts `DOWNLOAD_PROGRESS` messages with:
```js
{
  phase: "downloading" | "complete" | ...,
  current: number,
  total: number,
  currentTitle: string,
  errors: [{ id, title, error }]
}
```

The `id` field in each error entry is the clip ID. The popup can map that back to
the rendered `<li data-id="...">` elements.

---

## Step-by-step

### popup/popup.js changes

#### Step 1 — Add a module-level download-status map

After the `let currentClips = [];` line (or after `let clipCount = 0;` if the
selective-download plan is not implemented), add:
```js
// Map of clipId → "ok" | "error" | "active" | null
// Populated during and after a download run; cleared on new discover.
let clipDownloadStatus = {};
```

#### Step 2 — Clear status on new discover

Inside the `renderClips` function, at the very top of the function body (before
`el.clipCount.textContent`), add:
```js
  clipDownloadStatus = {};
```

This ensures stale status icons from a previous run don't persist after a re-discover.

#### Step 3 — Add a helper to update a single row's status icon

Add this function after `renderClips`:

```js
function setClipStatus(clipId, status) {
  // status: "active" | "ok" | "error" | null
  clipDownloadStatus[clipId] = status;
  const li = el.clipList.querySelector(`li[data-id="${CSS.escape(clipId)}"]`);
  if (!li) return;
  // Remove any existing status badge
  li.querySelector(".clip-status")?.remove();
  if (!status) return;
  const badge = document.createElement("span");
  badge.className = `clip-status clip-status-${status}`;
  badge.setAttribute("aria-label", status === "ok" ? "Downloaded" : status === "error" ? "Failed" : "Downloading");
  badge.textContent = status === "ok" ? "✓" : status === "error" ? "✗" : "↓";
  // Insert badge after the clip-meta span
  const meta = li.querySelector(".clip-meta");
  if (meta) {
    meta.insertAdjacentElement("afterend", badge);
  } else {
    li.appendChild(badge);
  }
}
```

#### Step 4 — Update statuses inside `updateProgress`

Find the download progress handler inside `updateProgress` (popup.js ~line 103):

```js
  if (type === "download") {
    if (progress.phase === "downloading") {
      setStatus("Downloading…", "busy");
      const pct = progress.total
        ? Math.round((progress.current / progress.total) * 100)
        : 0;
      el.progressText.textContent = `${progress.current} / ${progress.total}`;
      el.progressDetail.textContent = progress.currentTitle || "";
      el.progressBar.style.width = `${pct}%`;
      el.btnCancel.disabled = false;
```

After the `el.btnCancel.disabled = false;` line, add:
```js
      // Mark the currently-downloading clip as active
      // We don't have its ID here, only the title — so we highlight by title
      // (best effort; duplicates are rare in practice)
      if (progress.currentTitle) {
        for (const [id, _] of Object.entries(clipDownloadStatus)) {
          // already settled — don't overwrite
        }
        // Find the li matching currentTitle
        const allLis = el.clipList.querySelectorAll("li[data-id]");
        allLis.forEach((li) => {
          const titleEl = li.querySelector(".clip-title");
          if (titleEl?.textContent === progress.currentTitle) {
            if (!clipDownloadStatus[li.dataset.id]) {
              setClipStatus(li.dataset.id, "active");
            }
          }
        });
      }
```

Then find the `complete` phase block inside the `download` type handler:
```js
    } else if (progress.phase === "complete") {
      const failed = progress.errors?.length || 0;
      setStatus( ... );
      el.progressText.textContent = "Download complete";
      el.progressDetail.textContent = failed ? ... : "";
      el.progressBar.style.width = "100%";
      el.btnCancel.disabled = true;
```

After `el.btnCancel.disabled = true;` add:
```js
      // Settle all clip statuses
      const errorIds = new Set((progress.errors || []).map((e) => e.id));
      el.clipList.querySelectorAll("li[data-id]").forEach((li) => {
        const id = li.dataset.id;
        if (errorIds.has(id)) {
          setClipStatus(id, "error");
        } else if (clipDownloadStatus[id] !== undefined) {
          // was active or already ok — mark ok
          setClipStatus(id, "ok");
        }
        // clips never reached (cancelled) stay as null → no badge
      });
```

#### Step 5 — Thread clip IDs through DOWNLOAD_PROGRESS (background.js change)

Currently `currentTitle` is the only per-clip field in the progress broadcast. To make
active-clip highlighting reliable, also broadcast `currentClipId`.

Find inside `runDownloadQueue`'s worker, before the `broadcast` call (background.js ~line 537):
```js
      state.downloadProgress.currentTitle = clip.title;
      broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });
```

Replace with:
```js
      state.downloadProgress.currentTitle = clip.title;
      state.downloadProgress.currentClipId = clip.id;
      broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });
```

Then update the `active` marking in popup.js Step 4 to use `progress.currentClipId`
instead of matching by title:

Replace the block added in Step 4 with this simpler version:
```js
      if (progress.currentClipId) {
        // Only mark active if not already settled
        if (!clipDownloadStatus[progress.currentClipId]) {
          setClipStatus(progress.currentClipId, "active");
        }
      }
```

---

### popup/popup.css changes

#### Step 6 — Add badge styles

Append to `popup.css`:
```css
/* Per-clip download status badges */
.clip-status {
  font-size: 11px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  margin-left: auto;
  flex-shrink: 0;
}

.clip-status-ok {
  color: #1a7f37;
  background: #dafbe1;
}

.clip-status-error {
  color: #cf222e;
  background: #ffebe9;
}

.clip-status-active {
  color: #9a6700;
  background: #fff8c5;
}
```

If the selective-download plan is implemented, the `.clip-row` already uses `display:
flex`, so `margin-left: auto` on the badge will right-align it. If not, add
`display: flex; align-items: baseline;` to the `li` selector in popup.css.

---

## Verification

1. Discover 4 clips. Start downloading.
2. While downloading, observe that the currently-active clip shows a yellow ↓ badge.
3. After completion, all downloaded clips show a green ✓.
4. Simulate a failure (disconnect network mid-run or use a clip with a broken audio URL).
   Confirm that clip shows a red ✗ after the run completes.
5. Cancel mid-run. Confirm cancelled clips have no badge; completed ones show ✓.
6. Run discover again. Confirm all badges are cleared.
