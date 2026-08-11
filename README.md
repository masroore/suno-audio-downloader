# Suno Audio Downloader

A minimal Chrome / Firefox extension to discover MP3 and M4A audio from your Suno library and bulk-download them into a subfolder of your browser Downloads directory.

## Requirements

- Logged into [suno.com](https://suno.com) in the same browser profile
- Chrome 109+ or Firefox 109+

## Install

### Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `suno-audio-downloader` folder

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` inside the `suno-audio-downloader` folder

## Usage

1. Open [suno.com](https://suno.com) and sign in
2. Click the extension icon
3. Click **Connect** (uses your active suno.com tab)
4. Set a **Downloads subfolder** name (default: `SunoDownloads`)
5. Optionally set **Limit** to a small number (e.g. `5`) for testing
6. Click **Discover** to fetch your library clips
7. Click **Download all** to save audio files

Files are saved as:

```
Downloads/<subfolder>/<Song Title>/<Song Title> [<id>].mp3
```

## Important notes

- Extensions cannot write to arbitrary paths (e.g. `/Users/you/Music`). All files go under your browser **Downloads** folder with the subfolder you choose.
- For unattended bulk downloads, disable **Ask where to save each file** in your browser download settings.
- Audio URLs come from Suno’s API (`audio_url`) with a CDN fallback (`cdn1.suno.ai/{id}.mp3`). Format is inferred from the URL (`.mp3` or `.m4a`).
- Stems are hidden during discovery (`hide_gen_stems=true`). Studio clips are included.
- If your token expires, reconnect on suno.com and click **Connect** again.

## Development

```
suno-audio-downloader/
  manifest.json
  background.js      # auth, feed discovery, download queue
  popup/
    popup.html
    popup.js
    popup.css
  icons/
```

## License

For personal use. Not affiliated with Suno.
