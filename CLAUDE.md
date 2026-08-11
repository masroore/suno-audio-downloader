# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Chrome/Firefox Manifest V3 browser extension that discovers and bulk-downloads audio files, cover images, and metadata from a user's Suno library. The extension extracts session tokens from the active Suno tab, pages through the user's feed API, and queues concurrent downloads with retry logic.

## Architecture

### Core Components

**background.js** (service worker)
- Auth: extracts Clerk session token + user ID via content script injection
- Discovery: pages through `/api/feed/v3` with cursor-based pagination (500ms rate limit)
- Download queue: 2 concurrent workers, exponential backoff (up to 3 retries per file), 5-minute timeout per download
- State management: tracks discovery/download progress, broadcasts updates to popup
- Storage: persists token, user ID, and download path in `chrome.storage.local`

**popup/** (extension UI)
- `popup.js`: handles Connect/Discover/Download actions, renders clip list (max 50 preview), real-time progress updates
- Message-based communication with background service worker via `chrome.runtime.sendMessage`

### API Integration

**Authentication**
- Injects script into `suno.com` tab via `chrome.scripting.executeScript` with `world: "MAIN"`
- Reads `window.Clerk.session.getToken()` and `window.Clerk.user.id`
- Token sent as `Authorization: Bearer <token>` header in all API requests
- Tokens stored locally; auto-cleared on HTTP 401

**Feed Discovery**
- Endpoint: `POST https://studio-api-prod.suno.com/api/feed/v3`
- Pagination: cursor-based with `FEED_PAGE_LIMIT = 20` clips per page
- Filters: excludes disliked, trashed, studio-project, and stem clips; scoped to current user ID
- Rate limit: 500ms between requests, 5s backoff on HTTP 429

**Downloads**
- Audio: `audio_url` or fallback to `https://cdn1.suno.ai/<id>.mp3`
- Cover: `image_large_url` (when present)
- Metadata: full clip JSON as `-metadata.json` sidecar
- Filename format: `<Title> [<8-char-id>].<ext>`
- All files saved to `Downloads/<downloadPath>/` (flat structure, no nesting)

## Key Constants

```javascript
API_DELAY_MS = 500          // Rate limit between API requests
MAX_RETRIES = 3             // Per-file download retry count
CONCURRENT_DOWNLOADS = 2    // Parallel download workers
DOWNLOAD_TIMEOUT_MS = 300000  // 5-minute timeout per file
FEED_PAGE_LIMIT = 20        // Clips per feed page
```

## Testing

No automated test suite. Manual testing workflow:

1. Load extension in Chrome (`chrome://extensions`, Developer mode, Load unpacked)
2. Or Firefox (`about:debugging#/runtime/this-firefox`, Load Temporary Add-on)
3. Open `suno.com` and sign in
4. Click extension icon → Connect
5. Set Limit to small value (e.g., 5) for testing
6. Run Discover → Download all

Verify:
- Token extraction succeeds with logged-in Clerk session
- Discovery pages through feed without hitting rate limits
- Downloads create files in `Downloads/<path>/` with correct naming
- Progress bars update during discovery and download phases
- Cancel button stops in-progress operations
- Errors surface in UI (expired token, network failures, missing audio URLs)

## State Management

All state lives in `background.js`:
- `state.token` / `state.userId`: auth credentials
- `state.downloadPath`: target subfolder name (sanitized)
- `state.clips[]`: discovered clips with normalized `audio_url`, `image_large_url`, `clipData`
- `state.discoverProgress`: `{ phase, page, count }`
- `state.downloadProgress`: `{ phase, current, total, currentTitle, currentClipId, statuses, errors[] }`

State is broadcast to popup via `chrome.runtime.sendMessage` on every phase change.

## Common Workflows

**Adding a new download asset type**
1. Update `downloadClipAssets()` to fetch the new asset
2. Add filename helper (e.g., `getLyricsFilename()`)
3. Wrap fetch in `downloadWithRetry()` and catch errors into `assetErrors[]`

**Changing rate limits or concurrency**
- Update constants at top of `background.js`
- Test with large libraries to avoid HTTP 429 or browser download throttling

**Debugging discovery issues**
- Check `debugLog()` output in background service worker console
- Verify `buildFeedFilters()` returns expected filter structure
- Confirm `state.userId` is set before calling `discoverClips()`

## File Naming & Sanitization

- `sanitizeFilename()`: strips filesystem-unsafe chars, trims to 80 chars
- `sanitizeDownloadFolder()`: flattens to single folder name (no `/` or `\`)
- Conflict resolution: `chrome.downloads` API uses `conflictAction: "uniquify"` (appends `(1)`, `(2)`, etc.)

## Permissions

- `storage`: persist auth and settings
- `downloads`: write files to Downloads folder
- `scripting` + `activeTab`: inject token extraction script
- `host_permissions`: suno.com, studio-api-prod.suno.com, cdn1/cdn2.suno.ai

## Version History

- v1.2.0: Added per-clip download status indicators in the popup
- v1.1.0: Added user ID handling, cover image downloads, metadata sidecar files
- v1.0.0: Initial release with audio-only downloads
