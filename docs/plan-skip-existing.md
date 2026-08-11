# Plan: Skip already-downloaded files

**Priority:** P2 — feature  
**Files:** `background.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`  
**Estimated changes:** ~50 lines  
**Depends on:** nothing

---

## Goal

Add a "Skip existing files" checkbox. When checked, before queuing a clip's audio file
the extension searches `chrome.downloads` history for a file with the same name. If a
completed download is found, that asset is skipped (not re-downloaded). This prevents
accumulating `Song [abc12345](1).mp3`, `(2).mp3` duplicates on re-runs.

The check is per-asset (audio, image, metadata, video). Any asset already present is
skipped individually; the others still download normally.

---

## How chrome.downloads.search works

```js
chrome.downloads.search({ filenameRegex: "exact-name\\.mp3$" }, (items) => {
  const alreadyDone = items.some((i) => i.state === "complete");
});
```

`filename` in the result is the **full absolute path** on disk. We match on the
basename using a regex anchored to the end of the string.

---

## Step-by-step

### background.js changes

#### Step 1 — Add a helper to check download history

Insert this new function after the `downloadFromUrl` function (background.js ~line 449,
after the closing `}`):

```js
/**
 * Returns true if chrome.downloads history has a completed entry whose
 * filename ends with the given basename.
 * baseName should be just the filename portion, e.g. "Song [abc12345].mp3"
 */
function isAlreadyDownloaded(baseName) {
  return new Promise((resolve) => {
    // Escape regex special chars in the filename
    const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    chrome.downloads.search({ filenameRegex: `${escaped}$` }, (items) => {
      resolve(items.some((i) => i.state === "complete"));
    });
  });
}
```

#### Step 2 — Add `skipExisting` parameter to `downloadClipAssets`

Find the function signature (~line 499):
```js
async function downloadClipAssets(clip, basePath, includeVideo = false) {
```

Replace with:
```js
async function downloadClipAssets(clip, basePath, includeVideo = false, skipExisting = false) {
```

#### Step 3 — Wrap each asset download with an existence check

The pattern is the same for every asset: extract the basename from the full path,
check history, skip if found.

**Audio** — find (~lines 502–504):
```js
  await downloadWithRetry(() =>
    downloadFromUrl(clip.audio_url, getAudioFilename(clip, basePath)),
  );
```

Replace with:
```js
  const audioFilename = getAudioFilename(clip, basePath);
  const audioBaseName = audioFilename.split("/").pop();
  if (!skipExisting || !(await isAlreadyDownloaded(audioBaseName))) {
    await downloadWithRetry(() => downloadFromUrl(clip.audio_url, audioFilename));
  }
```

**Image** — find (~lines 506–512):
```js
  if (clip.image_large_url) {
    try {
      await downloadWithRetry(() =>
        downloadFromUrl(clip.image_large_url, getImageFilename(clip, basePath)),
      );
    } catch (err) {
      assetErrors.push(`image: ${err.message}`);
    }
  }
```

Replace with:
```js
  if (clip.image_large_url) {
    try {
      const imgFilename = getImageFilename(clip, basePath);
      const imgBaseName = imgFilename.split("/").pop();
      if (!skipExisting || !(await isAlreadyDownloaded(imgBaseName))) {
        await downloadWithRetry(() => downloadFromUrl(clip.image_large_url, imgFilename));
      }
    } catch (err) {
      assetErrors.push(`image: ${err.message}`);
    }
  }
```

**Metadata** — find (~lines 516–520):
```js
  try {
    await downloadWithRetry(() => downloadJsonMetadata(clip, basePath));
  } catch (err) {
    assetErrors.push(`metadata: ${err.message}`);
  }
```

Replace with:
```js
  try {
    const metaFilename = getMetadataFilename(clip, basePath);
    const metaBaseName = metaFilename.split("/").pop();
    if (!skipExisting || !(await isAlreadyDownloaded(metaBaseName))) {
      await downloadWithRetry(() => downloadJsonMetadata(clip, basePath));
    }
  } catch (err) {
    assetErrors.push(`metadata: ${err.message}`);
  }
```

**Video** (only if the video-download plan is also implemented) — apply the same pattern
to the video block: extract `videoFilename`, `videoBaseName`, and gate with
`!skipExisting || !(await isAlreadyDownloaded(videoBaseName))`.

#### Step 4 — Thread `skipExisting` through the call chain

**`runDownloadQueue`** — find signature (~line 525):
```js
async function runDownloadQueue(clips, basePath, includeVideo = false) {
```
Replace with:
```js
async function runDownloadQueue(clips, basePath, includeVideo = false, skipExisting = false) {
```

Find the `downloadClipAssets` call inside the worker (~line 541):
```js
        const { assetErrors } = await downloadClipAssets(clip, basePath, includeVideo);
```
Replace with:
```js
        const { assetErrors } = await downloadClipAssets(clip, basePath, includeVideo, skipExisting);
```

**`startDownload`** — find signature (~line 568):
```js
async function startDownload(limit = 0, selectedIds = null, includeVideo = false) {
```
Replace with:
```js
async function startDownload(limit = 0, selectedIds = null, includeVideo = false, skipExisting = false) {
```

Find the `runDownloadQueue` call (~line 591):
```js
    const { completed, errors } = await runDownloadQueue(clips, basePath, includeVideo);
```
Replace with:
```js
    const { completed, errors } = await runDownloadQueue(clips, basePath, includeVideo, skipExisting);
```

**Message handler** — find the `START_DOWNLOAD` case:
```js
        sendResponse(await startDownload(
          message.limit || 0,
          message.selectedIds || null,
          message.includeVideo || false,
        ));
```
Replace with:
```js
        sendResponse(await startDownload(
          message.limit || 0,
          message.selectedIds || null,
          message.includeVideo || false,
          message.skipExisting || false,
        ));
```

If the video-download plan has not been implemented, the existing handler is simpler;
add `message.skipExisting || false` as the last argument in the same pattern.

---

### popup/popup.html changes

#### Step 5 — Add checkbox next to the video checkbox

Find the options panel added in the video-download plan. If that plan is not implemented,
find the limit input section. In either case, add inside the same `<section class="panel">`:

```html
      <label class="option-row">
        <input type="checkbox" id="chk-skip-existing" />
        Skip already-downloaded files
      </label>
```

Place it after the video checkbox (if present) or after the limit input.

---

### popup/popup.js changes

#### Step 6 — Add element reference

In `const el = { ... }`, add:
```js
  chkSkipExisting: document.getElementById("chk-skip-existing"),
```

#### Step 7 — Pass `skipExisting` in the download message

Find the `send(Actions.START_DOWNLOAD, { ... })` call and add:
```js
    skipExisting: el.chkSkipExisting.checked,
```

---

### popup/popup.css changes

No additional CSS is needed beyond what the video-download plan already adds for
`.option-row`. If that plan is not implemented, add the `.option-row` style from
`plan-video-download.md` Step 10 instead.

---

## Important caveat

`chrome.downloads.search` only sees downloads initiated by **this extension** (or the
browser generally, depending on browser version and platform). It will not detect files
the user downloaded manually outside the browser, or files downloaded by a different
browser profile. Document this limitation in the popup hint text if desired.

---

## Verification

1. Run a download of 3 clips with "Skip existing files" unchecked. Confirm 3 bundles
   downloaded.
2. Without deleting the files, run the same download again with the box still unchecked.
   Confirm `(1)` duplicates appear.
3. Delete the `(1)` duplicates. Check "Skip existing files". Run the download again.
   Confirm no new files are created (all 3 originals still exist, none replaced).
4. Delete one of the originals. Run again with skip enabled. Confirm only the deleted
   clip's files are re-downloaded; the other two are skipped.
