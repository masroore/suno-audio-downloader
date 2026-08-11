# Plan: Lyrics .txt sidecar export

**Priority:** P2 — feature  
**Files:** `background.js` only  
**Estimated changes:** ~25 lines  
**Depends on:** nothing

---

## Goal

Save the song lyrics (stored in `clip.clipData.metadata.prompt`) as a plain `.txt` file
alongside the audio and metadata JSON. The file is only created when lyrics are present
and non-empty.

---

## Step-by-step

### Step 1 — Add a filename helper

Find the `getMetadataFilename` function (background.js ~line 231):
```js
function getMetadataFilename(clip, basePath) {
  return `${basePath}/${getBaseFilename(clip)}-metadata.json`;
}
```

Insert the following new function **immediately after** it:
```js
function getLyricsFilename(clip, basePath) {
  return `${basePath}/${getBaseFilename(clip)}-lyrics.txt`;
}
```

### Step 2 — Add a lyrics download helper

Find the `downloadJsonMetadata` function (background.js ~line 479):
```js
async function downloadJsonMetadata(clip, basePath) {
  const payload = buildMetadataPayload(clip);
  const json = JSON.stringify(payload, null, 2);
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  return downloadFromUrl(dataUrl, getMetadataFilename(clip, basePath));
}
```

Insert the following new function **immediately after** it:
```js
async function downloadLyrics(clip, basePath) {
  const raw = clip.clipData || clip;
  const lyrics = raw.metadata?.prompt;
  if (!lyrics || !lyrics.trim()) return null;   // no lyrics — skip silently
  const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(lyrics);
  return downloadFromUrl(dataUrl, getLyricsFilename(clip, basePath));
}
```

### Step 3 — Call downloadLyrics inside downloadClipAssets

Find the end of `downloadClipAssets` (background.js ~lines 516–522), specifically the
metadata download block and the return statement:
```js
  try {
    await downloadWithRetry(() => downloadJsonMetadata(clip, basePath));
  } catch (err) {
    assetErrors.push(`metadata: ${err.message}`);
  }

  return { assetErrors };
```

Replace with:
```js
  try {
    await downloadWithRetry(() => downloadJsonMetadata(clip, basePath));
  } catch (err) {
    assetErrors.push(`metadata: ${err.message}`);
  }

  try {
    await downloadLyrics(clip, basePath);   // no-op when lyrics absent
  } catch (err) {
    assetErrors.push(`lyrics: ${err.message}`);
  }

  return { assetErrors };
```

---

## Notes

- `downloadLyrics` returns `null` (not an error) when the clip has no lyrics. The caller
  ignores a `null` return. Do not push to `assetErrors` for a missing-lyrics skip.
- The `.txt` file uses UTF-8 encoding via the data URL. Suno lyrics can contain emoji and
  non-ASCII characters; `encodeURIComponent` handles them correctly.
- No new permissions are required — `chrome.downloads` is already granted.

---

## Verification

1. Connect, Discover. Download 2–3 clips that have visible lyrics on Suno.
2. Open `Downloads/SunoDownloads/`. Confirm `Song Title [abcd1234]-lyrics.txt` is present.
3. Open the `.txt`. Confirm it contains the raw lyrics text without extra formatting.
4. Download a clip with no lyrics (instrumental). Confirm no `-lyrics.txt` file is created
   and no error appears in the popup.
