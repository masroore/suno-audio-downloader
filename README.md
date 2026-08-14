# Suno Audio Downloader

A Chrome / Firefox (Manifest V3) extension that discovers the audio in your Suno library and bulk-downloads each clip’s MP3/M4A, cover image, and metadata JSON into a subfolder of your browser Downloads directory.

> For personal use. Not affiliated with Suno.

## Features

- **Connect** — pulls your Suno session token and user id from the active `suno.com` tab (via Clerk) and stores them locally.
- **Discover** — walks your Suno feed (`POST /feed/v3`) with a zero-based start offset, count, and configurable API page size.
- **Build library catalog** — discovers the full library in configurable batches (default: 1,000 clips) and saves each batch as an aggregate JSON file.
- **Bulk download** — for each clip, saves audio, large cover image, and a metadata sidecar into `Downloads/<subfolder>/` with a retry/backoff queue (4 concurrent clips, up to 3 retries per file).
- **Extract JSON** — saves one aggregate JSON file containing the full raw feed metadata for the current discovery result, without downloading media.
- **Progress + cancel** — live progress bar for both discovery and downloads, cancellable at any time.
- **Page size fallback** — starts with the selected API page size and falls back to smaller sizes when the API rejects the requested limit.

## Requirements

- A [Suno](https://suno.com) account, logged in in the same browser profile
- Chrome 109+ or Firefox 109+

## Install

### Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select this `suno-audio-downloader` folder

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` inside this folder

(For a permanent Firefox install, the extension must be signed by Mozilla.)

## Usage

1. Open [suno.com](https://suno.com) and sign in.
2. Click the extension icon and click **Connect** (the active tab must be on suno.com).
3. Optionally change the **Downloads folder** name (default: `SunoDownloads` — a single flat folder, no nesting).
4. Optionally set **Start offset** (default `0`), **Count** (default `0`, meaning all remaining), and **API page size** (default `50`, allowed `1–100`). These values persist between popup opens.
5. Set **Catalog batch size** (default `1,000`), then enable **Build library catalog** to discover and save your full library in batches, or leave it disabled for count-based discovery.
6. Click **Discover** to fetch the selected range of your library clips.
7. Click **Download all** to save audio, cover images, and per-clip metadata.
8. Click **Extract JSON** to save the current discovery result without downloading audio, images, or video.

Files are saved as:

```
Downloads/<subfolder>/<Song Title> [<id>].mp3
Downloads/<subfolder>/<Song Title> [<id>].jpeg
Downloads/<subfolder>/<Song Title> [<id>]-metadata.json
Downloads/<subfolder>/Suno metadata [<start>-<end>].json
```

(Image extension follows `image_large_url`, usually `.jpeg`.)

The aggregate JSON includes `source`, `fetched_at`, requested and actual counts, requested and effective page sizes, and a `clips` array containing each raw clip object returned by the feed. During **Build library catalog**, the `model_badges`, `action_config`, and `ownership` fields are omitted recursively from each persisted catalog JSON file. Empty or out-of-range results are saved as `Suno metadata [<start>-empty].json`.

## How it works

- **Auth** — the extension injects a script into your suno.com tab and reads `window.Clerk.session.getToken()` plus `window.Clerk.user.id`, then uses the bearer token for API requests. Token and user id are kept in `chrome.storage.local` and cleared automatically when the token expires (HTTP 401).
- **Discovery** — uses `https://studio-api-prod.suno.com/api/feed/v3/offset` to seek directly to a non-zero start offset, then pages through `https://studio-api-prod.suno.com/api/feed/v3` with cursor pagination and a randomized 250–1,999 ms delay between API requests. The requested page size is sent as `limit` for cursor requests; validation errors fall back through `50`, `20`, and `10`. Results are deduplicated by clip id, filtered by the zero-based start/count range, and scoped to your user id. Clips remain eligible for JSON extraction even when media URLs are missing.
- **Downloads** — each clip’s audio, `image_large_url`, and full feed JSON snippet are downloaded via the `chrome.downloads` API into the chosen subfolder (no save-as prompt), with 4 concurrent workers, exponential-backoff retries, a 5-minute per-file timeout, and `uniquify` conflict handling. CDN-backed asset downloads start immediately; audio failure fails the clip; image/metadata failures are reported but do not block the audio.
- **Format** — the audio extension (`.mp3` / `.m4a`) is inferred from the clip's `audio_url`, with a `cdn1.suno.ai/<id>.mp3` fallback.

## Notes & limitations

- Extensions can't write to arbitrary paths (e.g. `~/Music`). All files go under your browser **Downloads** folder.
- For unattended bulk downloads, disable **Ask where to save each file** in your browser's download settings.
- If your token expires, reload suno.com, sign in again, and click **Connect**.
- Only your library feed is accessed — no other data is collected, and nothing leaves your browser except Suno API requests.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Persist token, user id, and download subfolder |
| `downloads` | Save audio, images, and metadata to the Downloads folder |
| `scripting` + `activeTab` | Extract the session token and user id from the active suno.com tab |
| `host_permissions` | suno.com, studio-api-prod.suno.com, cdn1/cdn2.suno.ai |

## Development

```
suno-audio-downloader/
  manifest.json          # Manifest V3 + Firefox (gecko) config
  background.js          # auth, feed discovery, download queue
  popup/
    popup.html           # extension UI
    popup.js             # UI logic + messaging
    popup.css            # styles
  icons/
```

After editing, reload the extension from `chrome://extensions` (or re-load the temporary add-on in Firefox).

## License

For personal use. Not affiliated with or endorsed by Suno.
