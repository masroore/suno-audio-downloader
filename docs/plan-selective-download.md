# Plan: Selective (checkbox) download

**Priority:** P1 — feature  
**Files:** `background.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`  
**Estimated changes:** ~120 lines across all files  
**Depends on:** nothing

---

## Goal

Let users check/uncheck individual clips in the list and download only the checked ones.
An "all / none" toggle header makes bulk selection fast. The Download button label changes
to "Download selected (N)" when a subset is chosen.

---

## Data model

The popup owns selection state as a `Set<string>` of clip IDs. It passes a
`selectedIds` array to the background via `START_DOWNLOAD`. The background filters
`state.clips` by that list.

---

## Step-by-step

### background.js changes

#### Step 1 — Accept `selectedIds` in `startDownload`

Find the function signature (background.js ~line 568):
```js
async function startDownload(limit = 0) {
```

Replace with:
```js
async function startDownload(limit = 0, selectedIds = null) {
```

#### Step 2 — Filter clips by selectedIds

Find this line inside `startDownload` (~line 579):
```js
  const clips = limit > 0 ? state.clips.slice(0, limit) : state.clips;
```

Replace with:
```js
  let clips = limit > 0 ? state.clips.slice(0, limit) : state.clips;
  if (selectedIds && selectedIds.length > 0) {
    const idSet = new Set(selectedIds);
    clips = clips.filter((c) => idSet.has(c.id));
  }
```

#### Step 3 — Pass `selectedIds` from the message handler

Find inside the `chrome.runtime.onMessage` switch, the `START_DOWNLOAD` case
(background.js ~line 651):
```js
      case Actions.START_DOWNLOAD:
        sendResponse(await startDownload(message.limit || 0));
        break;
```

Replace with:
```js
      case Actions.START_DOWNLOAD:
        sendResponse(await startDownload(message.limit || 0, message.selectedIds || null));
        break;
```

---

### popup/popup.html changes

#### Step 4 — Add select-all header above the clip list

Find the existing list header block (popup.html ~lines 44–50):
```html
    <section class="panel">
      <div class="list-header">
        <h2>Discovered clips</h2>
        <span id="clip-count">0</span>
      </div>
      <ul id="clip-list"></ul>
    </section>
```

Replace with:
```html
    <section class="panel">
      <div class="list-header">
        <h2>Discovered clips</h2>
        <span id="clip-count">0</span>
      </div>
      <div class="select-bar" id="select-bar" hidden>
        <label class="select-all-label">
          <input type="checkbox" id="chk-select-all" />
          Select all
        </label>
        <span id="selected-count" class="hint">0 selected</span>
      </div>
      <ul id="clip-list"></ul>
    </section>
```

---

### popup/popup.js changes

#### Step 5 — Add selectedIds set and el references

At the top of popup.js, find the `const el = { ... }` block and add three new entries
after `clipList`:

```js
  selectBar: document.getElementById("select-bar"),
  chkSelectAll: document.getElementById("chk-select-all"),
  selectedCount: document.getElementById("selected-count"),
```

After the `let clipCount = 0;` line (~line 141), add:
```js
let selectedIds = new Set();   // clip IDs the user has checked
```

#### Step 6 — Rewrite renderClips to add checkboxes

Find the entire `renderClips` function (popup.js ~lines 49–68):
```js
function renderClips(clips) {
  el.clipCount.textContent = String(clips.length);
  el.clipList.innerHTML = "";
  const preview = clips.slice(0, 50);
  for (const clip of preview) {
    const li = document.createElement("li");
    const duration = formatDuration(clip.duration);
    li.innerHTML = `
      <span class="clip-title">${escapeHtml(clip.title)}</span>
      <span class="clip-meta">${escapeHtml(clip.format.toUpperCase())}${duration ? ` · ${duration}` : ""}</span>
    `;
    el.clipList.appendChild(li);
  }
  if (clips.length > 50) {
    const li = document.createElement("li");
    li.className = "clip-meta";
    li.textContent = `…and ${clips.length - 50} more`;
    el.clipList.appendChild(li);
  }
}
```

Replace with:
```js
function renderClips(clips) {
  el.clipCount.textContent = String(clips.length);
  el.clipList.innerHTML = "";

  // Show select bar only when there are clips
  el.selectBar.hidden = clips.length === 0;

  // Seed selectedIds with all IDs (all selected by default)
  selectedIds = new Set(clips.map((c) => c.id));
  updateSelectAllState(clips);

  const preview = clips.slice(0, 50);
  for (const clip of preview) {
    const li = document.createElement("li");
    li.dataset.id = clip.id;
    const duration = formatDuration(clip.duration);
    const checked = selectedIds.has(clip.id) ? "checked" : "";
    li.innerHTML = `
      <label class="clip-row">
        <input type="checkbox" class="clip-chk" data-id="${escapeHtml(clip.id)}" ${checked} />
        <span class="clip-title">${escapeHtml(clip.title)}</span>
        <span class="clip-meta">${escapeHtml(clip.format.toUpperCase())}${duration ? ` · ${duration}` : ""}</span>
      </label>
    `;
    el.clipList.appendChild(li);
  }
  if (clips.length > 50) {
    const li = document.createElement("li");
    li.className = "clip-meta";
    li.textContent = `…and ${clips.length - 50} more`;
    el.clipList.appendChild(li);
  }

  updateDownloadButton();
}

function updateSelectAllState(clips) {
  const total = Math.min(clips.length, 50);   // only rendered rows
  const checkedCount = [...el.clipList.querySelectorAll(".clip-chk:checked")].length;
  el.chkSelectAll.checked = checkedCount === total && total > 0;
  el.chkSelectAll.indeterminate = checkedCount > 0 && checkedCount < total;
  el.selectedCount.textContent = `${selectedIds.size} selected`;
}

function updateDownloadButton() {
  const allCount = clipCount;
  const selCount = selectedIds.size;
  if (selCount === 0 || selCount === allCount) {
    el.btnDownload.textContent = "Download all";
  } else {
    el.btnDownload.textContent = `Download selected (${selCount})`;
  }
  el.btnDownload.disabled = selCount === 0;
}
```

#### Step 7 — Wire up checkbox events via event delegation

After the `el.downloadPath.addEventListener("blur", persistDownloadPath);` line, add:

```js
// Per-clip checkbox toggle
el.clipList.addEventListener("change", (e) => {
  if (!e.target.classList.contains("clip-chk")) return;
  const id = e.target.dataset.id;
  if (e.target.checked) {
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }
  updateSelectAllState(currentClips);
  updateDownloadButton();
});

// Select-all checkbox
el.chkSelectAll.addEventListener("change", () => {
  const checkboxes = el.clipList.querySelectorAll(".clip-chk");
  checkboxes.forEach((chk) => {
    chk.checked = el.chkSelectAll.checked;
    if (el.chkSelectAll.checked) {
      selectedIds.add(chk.dataset.id);
    } else {
      selectedIds.delete(chk.dataset.id);
    }
  });
  updateSelectAllState(currentClips);
  updateDownloadButton();
});
```

Note: `currentClips` is a module-level variable added in Step 8.

#### Step 8 — Track currentClips at module level

After the `let selectedIds = new Set();` line added in Step 5, add:
```js
let currentClips = [];   // last full clips array from background
```

Inside `renderClips`, at the very top of the function body (before `el.clipCount.textContent`), add:
```js
  currentClips = clips;
```

#### Step 9 — Pass selectedIds to START_DOWNLOAD

Find the download button click handler (popup.js ~line 220):
```js
  const res = await send(Actions.START_DOWNLOAD, { limit: getLimit() });
```

Replace with:
```js
  const idsToDownload = selectedIds.size > 0 && selectedIds.size < clipCount
    ? [...selectedIds]
    : null;   // null = download all (no filtering needed)
  const res = await send(Actions.START_DOWNLOAD, {
    limit: getLimit(),
    selectedIds: idsToDownload,
  });
```

---

### popup/popup.css changes

#### Step 10 — Add styles for the new elements

Append to the end of `popup.css`:

```css
/* Select bar */
.select-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--border, #e0e0e0);
  margin-bottom: 4px;
}

.select-all-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

/* Clip rows with checkbox */
.clip-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  cursor: pointer;
  width: 100%;
}

.clip-row input[type="checkbox"] {
  flex-shrink: 0;
  margin-top: 2px;
}

/* Disabled state — dim unchecked clips */
#clip-list li:has(.clip-chk:not(:checked)) .clip-title {
  opacity: 0.45;
}
```

---

## Verification

1. Load extension. Connect. Discover (use limit 5 for speed).
2. All 5 clips appear checked. "Download all" is shown on the button.
3. Uncheck clip 2. Button changes to "Download selected (4)".
4. Uncheck all → button shows "Download selected (0)" and is disabled.
5. Use select-all checkbox → all re-checked, button reverts to "Download all".
6. Re-check 3 clips, click Download. Confirm only 3 audio/image/metadata bundles
   appear in `Downloads/SunoDownloads/`.
7. With all checked, click Download. Confirm all 5 bundles are downloaded.
