# Plan: Optional video download

**Priority:** P2 — feature  
**Files:** `background.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`  
**Estimated changes:** ~40 lines  
**Depends on:** nothing

---

## Goal

Add a checkbox in the popup — "Include video files" — that, when checked, downloads the
`video_url` for each clip alongside the audio. `video_url` is already captured in
`buildMetadataPayload` but never downloaded. Not all clips have a video; the option is
silently skipped for those.

---

## Step-by-step

### background.js changes

#### Step 1 — Add a video filename helper

Find `getMetadataFilename` (~line 231):
```js
function getMetadataFilename(clip, basePath) {
  return `${basePath}/${getBaseFilename(clip)}-metadata.json`;
}
```

Insert immediately after it:
```js
function getVideoFilename(clip, basePath) {
  // Suno videos are MP4; fall back to .mp4 if URL is ambiguous
  const url = (clip.clipData || clip).video_url || "";
  const lower = url.toLowerCase().split("?")[0];
  const ext = lower.endsWith(".webm") ? "webm" : "mp4";
  return `${basePath}/${getBaseFilename(clip)}.${ext}`;
}
```

#### Step 2 — Accept `includeVideo` in `startDownload`

Find the function signature (~line 568):
```js
async function startDownload(limit = 0, selectedIds = null) {
```

Replace with:
```js
async function startDownload(limit = 0, selectedIds = null, includeVideo = false) {
```

#### Step 3 — Thread `includeVideo` into the queue

Find inside `startDownload`, where `runDownloadQueue` is called (~line 591):
```js
    const { completed, errors } = await runDownloadQueue(clips, basePath);
```

Replace with:
```js
    const { completed, errors } = await runDownloadQueue(clips, basePath, includeVideo);
```

#### Step 4 — Accept `includeVideo` in `runDownloadQueue`

Find the function signature (~line 525):
```js
async function runDownloadQueue(clips, basePath) {
```

Replace with:
```js
async function runDownloadQueue(clips, basePath, includeVideo = false) {
```

Inside the worker, find where `downloadClipAssets` is called (~line 541):
```js
        const { assetErrors } = await downloadClipAssets(clip, basePath);
```

Replace with:
```js
        const { assetErrors } = await downloadClipAssets(clip, basePath, includeVideo);
```

#### Step 5 — Accept `includeVideo` in `downloadClipAssets` and download video

Find the function signature (~line 499):
```js
async function downloadClipAssets(clip, basePath) {
```

Replace with:
```js
async function downloadClipAssets(clip, basePath, includeVideo = false) {
```

Find the image download block inside `downloadClipAssets` (~lines 506–512):
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

Insert the following block **immediately after** it (before the metadata block):
```js
  if (includeVideo) {
    const videoUrl = (clip.clipData || clip).video_url;
    if (videoUrl) {
      try {
        await downloadWithRetry(() =>
          downloadFromUrl(videoUrl, getVideoFilename(clip, basePath)),
        );
      } catch (err) {
        assetErrors.push(`video: ${err.message}`);
      }
    }
  }
```

#### Step 6 — Pass `includeVideo` from the message handler

Find the `START_DOWNLOAD` case in `chrome.runtime.onMessage` (~line 651):
```js
      case Actions.START_DOWNLOAD:
        sendResponse(await startDownload(message.limit || 0, message.selectedIds || null));
        break;
```

Replace with:
```js
      case Actions.START_DOWNLOAD:
        sendResponse(await startDownload(
          message.limit || 0,
          message.selectedIds || null,
          message.includeVideo || false,
        ));
        break;
```

---

### popup/popup.html changes

#### Step 7 — Add the checkbox to the options panel

Find the limit input section (~lines 26–29):
```html
    <section class="panel">
      <label for="limit-input">Limit (optional, for testing)</label>
      <input id="limit-input" type="number" min="0" placeholder="0 = all" />
    </section>
```

Replace with:
```html
    <section class="panel">
      <label for="limit-input">Limit (optional, for testing)</label>
      <input id="limit-input" type="number" min="0" placeholder="0 = all" />
      <label class="option-row">
        <input type="checkbox" id="chk-include-video" />
        Include video files (where available)
      </label>
    </section>
```

---

### popup/popup.js changes

#### Step 8 — Add element reference

In the `const el = { ... }` block, after `limitInput`:
```js
  chkIncludeVideo: document.getElementById("chk-include-video"),
```

#### Step 9 — Pass `includeVideo` in the download message

Find inside the download button click handler (~line 223):
```js
  const res = await send(Actions.START_DOWNLOAD, {
    limit: getLimit(),
    selectedIds: idsToDownload,
  });
```

Replace with:
```js
  const res = await send(Actions.START_DOWNLOAD, {
    limit: getLimit(),
    selectedIds: idsToDownload,
    includeVideo: el.chkIncludeVideo.checked,
  });
```

If the selective-download plan has not been implemented yet, the existing line will be:
```js
  const res = await send(Actions.START_DOWNLOAD, { limit: getLimit() });
```

In that case replace with:
```js
  const res = await send(Actions.START_DOWNLOAD, {
    limit: getLimit(),
    includeVideo: el.chkIncludeVideo.checked,
  });
```

---

### popup/popup.css changes

#### Step 10 — Style the option row

Append to the end of `popup.css`:
```css
/* Option checkbox rows */
.option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-top: 8px;
  cursor: pointer;
  user-select: none;
}
```

---

## Verification

1. Connect and Discover a few clips.
2. With "Include video files" **unchecked**, download. Confirm no `.mp4` files appear.
3. Check "Include video files", download the same clips. Confirm `.mp4` files appear for
   clips that have a `video_url` in their metadata JSON.
4. Confirm clips without `video_url` produce no `.mp4` and no error in the status bar.
5. Confirm the video error (if CDN is unreachable) is surfaced in the error list, not
   silently swallowed.
