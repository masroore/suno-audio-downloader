# Suno Audio Downloader

A Chrome / Firefox (Manifest V3) extension that discovers the MP3/M4A audio in your Suno library and bulk-downloads it into a subfolder of your browser Downloads directory.

> For personal use. Not affiliated with Suno.

## Features

- **Connect** — pulls your Suno session token from the active `suno.com` tab (via Clerk) and stores it locally.
- **Discover** — walks your Suno feed (`/feed/v2`) and lists every clip with a playable audio URL.
- **Bulk download** — downloads clips into `Downloads/<subfolder>/<Song Title> [<id>].mp3` with a retry/backoff queue (2 concurrent downloads, up to 3 retries per file).
- **Progress + cancel** — live progress bar for both discovery and downloads, cancellable at any time.
- **Limit option** — cap discovery/downloads to N clips for testing (0 = everything).

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
3. Optionally change the **Downloads subfolder** (default: `SunoDownloads`).
4. Optionally set a **Limit** (e.g. `5`) to test with a small batch.
5. Click **Discover** to fetch your library clips.
6. Click **Download all** to save the audio files.

Files are saved as:

```
Downloads/<subfolder>/<Song Title> [<id>].mp3
```

## How it works

- **Auth** — the extension injects a script into your suno.com tab and calls `window.Clerk.session.getToken()`, then uses that bearer token for API requests. The token is kept in `chrome.storage.local` and cleared automatically when it expires (HTTP 401).
- **Discovery** — pages through `https://studio-api.prod.suno.com/api/feed/v2` (500 ms rate limit between requests). Stems are excluded (`hide_gen_stems=true`); studio clips are included.
- **Downloads** — each clip is downloaded via the `chrome.downloads` API straight to the chosen subfolder (no save-as prompt), with 2 concurrent workers, exponential-backoff retries, a 5-minute per-file timeout, and `uniquify` conflict handling.
- **Format** — the file extension (`.mp3` / `.m4a`) is inferred from the clip's `audio_url`, with a `cdn1.suno.ai/<id>.mp3` fallback.

## Notes & limitations

- Extensions can't write to arbitrary paths (e.g. `~/Music`). All files go under your browser **Downloads** folder.
- For unattended bulk downloads, disable **Ask where to save each file** in your browser's download settings.
- If your token expires, reload suno.com, sign in again, and click **Connect**.
- Only your library feed is accessed — no other data is collected, and nothing leaves your browser except Suno API requests.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Persist token and download subfolder |
| `downloads` | Save audio files to the Downloads folder |
| `scripting` + `activeTab` | Extract the session token from the active suno.com tab |
| `host_permissions` | suno.com, studio-api.prod.suno.com, cdn1/cdn2.suno.ai |

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
