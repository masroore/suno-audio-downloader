const API_BASE = "https://studio-api-prod.suno.com/api";
const API_DELAY_MIN_MS = 250;
const API_DELAY_MAX_MS = 1999;
const MAX_RETRIES = 3;
const CONCURRENT_DOWNLOADS = 4;
const DOWNLOAD_TIMEOUT_MS = 300000;
const DEFAULT_START = 0;
const DEFAULT_COUNT = 0;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_CATALOG_BATCH_SIZE = 1000;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 100;
const MIN_CATALOG_BATCH_SIZE = 1;
const PAGE_SIZE_FALLBACKS = [50, 20, 10];
// TODO: remove after production / once discover is stable
const DEBUG = true;

function debugLog(...args) {
  if (DEBUG) console.log("[suno-dl]", ...args);
}

const Actions = {
  EXTRACT_TOKEN: "extractToken",
  GET_STATE: "getState",
  SET_DOWNLOAD_PATH: "setDownloadPath",
  SET_DISCOVERY_OPTIONS: "setDiscoveryOptions",
  DISCOVER: "discover",
  START_DOWNLOAD: "startDownload",
  EXTRACT_JSON: "extractJson",
  RESUME_DOWNLOAD: "resumeDownload",
  CANCEL_DOWNLOAD: "cancelDownload",
  DISCOVER_PROGRESS: "discoverProgress",
  DOWNLOAD_PROGRESS: "downloadProgress",
};

let state = {
  token: null,
  userId: null,
  deviceId: null,
  downloadPath: "SunoDownloads",
  clips: [],
  completedClipIds: [],
  discoveryOptions: {
    start: DEFAULT_START,
    count: DEFAULT_COUNT,
    pageSize: DEFAULT_PAGE_SIZE,
    auto: false,
  },
  lastDiscovery: null,
  discoverProgress: { phase: "idle", page: 0, count: 0 },
  downloadProgress: {
    phase: "idle",
    current: 0,
    total: 0,
    currentTitle: "",
    currentClipId: "",
    statuses: {},
    errors: [],
  },
};

let isDiscovering = false;
let isAutoDiscovering = false;
let isDownloading = false;
let cancelRequested = false;
async function loadState() {
  const stored = await chrome.storage.local.get([
    "token",
    "userId",
    "deviceId",
    "downloadPath",
    "completedClipIds",
    "discoveryOptions",
  ]);
  if (stored.token) state.token = stored.token;
  if (stored.userId) state.userId = stored.userId;
  if (stored.deviceId) state.deviceId = stored.deviceId;
  else {
    // Generate and persist a device ID
    state.deviceId = crypto.randomUUID();
    await chrome.storage.local.set({ deviceId: state.deviceId });
  }
  if (stored.downloadPath) state.downloadPath = sanitizeDownloadFolder(stored.downloadPath);
  if (Array.isArray(stored.completedClipIds)) {
    state.completedClipIds = stored.completedClipIds;
  }
  if (stored.discoveryOptions) {
    state.discoveryOptions = normalizeDiscoveryOptions(stored.discoveryOptions);
  }
}

async function saveAuth(token, userId) {
  state.token = token;
  state.userId = userId;
  await chrome.storage.local.set({ token, userId });
}

async function clearAuth() {
  state.token = null;
  state.userId = null;
  await chrome.storage.local.remove(["token", "userId"]);
}

function sanitizeDownloadFolder(path) {
  const flat = String(path || "")
    .replace(/[\\/]+/g, "")
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  return flat || "SunoDownloads";
}

async function saveDownloadPath(path) {
  state.downloadPath = sanitizeDownloadFolder(path);
  await chrome.storage.local.set({ downloadPath: state.downloadPath });
}

function normalizeDiscoveryOptions(options = {}) {
  const startValue = Number(options.start);
  const countValue = Number(options.count);
  const pageSizeValue = Number(options.pageSize);
  const catalogBatchSizeValue = Number(options.catalogBatchSize);
  const auto = options.auto === true;
  const start = Number.isInteger(startValue) && startValue >= 0
    ? startValue
    : DEFAULT_START;
  const count = Number.isInteger(countValue) && countValue >= 0
    ? countValue
    : DEFAULT_COUNT;
  const pageSize = Number.isInteger(pageSizeValue) &&
    pageSizeValue >= MIN_PAGE_SIZE &&
    pageSizeValue <= MAX_PAGE_SIZE
    ? pageSizeValue
    : DEFAULT_PAGE_SIZE;
  const catalogBatchSize = Number.isInteger(catalogBatchSizeValue) &&
    catalogBatchSizeValue >= MIN_CATALOG_BATCH_SIZE
    ? catalogBatchSizeValue
    : DEFAULT_CATALOG_BATCH_SIZE;
  return { start, count, pageSize, catalogBatchSize, auto };
}

async function saveDiscoveryOptions(options) {
  state.discoveryOptions = normalizeDiscoveryOptions(options);
  await chrome.storage.local.set({ discoveryOptions: state.discoveryOptions });
}

function broadcast(action, data) {
  chrome.runtime.sendMessage({ action, ...data }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelayMs(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function apiRateLimit() {
  await sleep(getRandomDelayMs(API_DELAY_MIN_MS, API_DELAY_MAX_MS));
}

async function apiFetch(endpoint, options = {}, attempt = 0) {
  await apiRateLimit();
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  const method = options.method || "GET";

  // Generate browser-token with timestamp
  const browserToken = {
    token: btoa(JSON.stringify({ timestamp: Date.now() }))
  };

  const fetchOptions = {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${state.token}`,
      "browser-token": JSON.stringify(browserToken),
      "device-id": state.deviceId,
    },
  };
  if (options.body !== undefined) {
    fetchOptions.body = JSON.stringify(options.body);
  }
  debugLog("apiFetch request", {
    url,
    method,
    body: options.body,
    tokenPreview: state.token ? `${state.token.slice(0, 12)}…` : null,
  });
  const response = await fetch(url, fetchOptions);
  const responseText = await response.text();
  let data = null;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch {
    data = null;
  }
  debugLog("apiFetch response", {
    url,
    status: response.status,
    ok: response.ok,
    bodyPreview: responseText.slice(0, 2000),
    parsedKeys: data && typeof data === "object" ? Object.keys(data) : null,
  });
  if (!response.ok) {
    if (response.status === 401) {
      await clearAuth();
      throw new Error("Token expired — reconnect on suno.com.");
    }
    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`API rate limited after ${MAX_RETRIES} retries — try again later.`);
      }
      const backoff = 5000 * Math.pow(2, attempt);
      debugLog(`429 rate limit, retrying in ${backoff}ms (attempt ${attempt + 1})`);
      await sleep(backoff);
      return apiFetch(endpoint, options, attempt + 1);
    }
    const detail =
      (data && (data.detail || data.message || data.error)) ||
      responseText.slice(0, 300) ||
      response.statusText;
    const error = new Error(`API error: ${response.status}${detail ? ` — ${detail}` : ""}`);
    error.status = response.status;
    error.detail = detail;
    throw error;
  }
  return data;
}

function buildFeedFilters(userId) {
  return {
    disliked: "False",
    trashed: "False",
    fromStudioProject: { presence: "False" },
    stem: { presence: "False" },
    stemComplement: "False",
    user: {
      presence: "True",
      userId,
    },
  };
}

function sanitizeFilename(name) {
  return (
    (name &&
      name
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/\s+/g, " ")
        .replace(/^\.+/, "")
        .replace(/\.+$/, "")
        .trim()
        .slice(0, 80)) ||
    "Untitled"
  );
}

function getAudioUrl(clip) {
  if (clip.audio_url) return clip.audio_url;
  if (clip.id) return `https://cdn1.suno.ai/${clip.id}.mp3`;
  return null;
}

function getAudioExtension(url) {
  if (!url) return "mp3";
  const lower = url.toLowerCase().split("?")[0];
  if (lower.endsWith(".m4a")) return "m4a";
  if (lower.endsWith(".mp3")) return "mp3";
  if (lower.includes(".m4a")) return "m4a";
  return "mp3";
}

function getImageExtension(url) {
  if (!url) return "jpeg";
  const path = url.toLowerCase().split("?")[0];
  const match = path.match(/\.([a-z0-9]+)$/);
  if (match) return match[1];
  return "jpeg";
}

function getBaseFilename(clip) {
  const title = sanitizeFilename(clip.title || "Untitled");
  const shortId = clip.id ? clip.id.substring(0, 8) : "unknown";
  return `${title} [${shortId}]`;
}

function getAudioFilename(clip, basePath) {
  const audioUrl = getAudioUrl(clip);
  const ext = getAudioExtension(audioUrl);
  return `${basePath}/${getBaseFilename(clip)}.${ext}`;
}

function getImageFilename(clip, basePath) {
  const ext = getImageExtension(clip.image_large_url);
  return `${basePath}/${getBaseFilename(clip)}.${ext}`;
}

function getMetadataFilename(clip, basePath) {
  return `${basePath}/${getBaseFilename(clip)}-metadata.json`;
}

function getAggregateMetadataFilename(discovery, basePath) {
  const start = discovery?.start ?? DEFAULT_START;
  const count = discovery?.actual_count ?? 0;
  const range = count > 0 ? `${start}-${start + count - 1}` : `${start}-empty`;
  return `${basePath}/Suno metadata [${range}].json`;
}

function getLyricsFilename(clip, basePath) {
  return `${basePath}/${getBaseFilename(clip)}-lyrics.txt`;
}

function normalizeClip(clip) {
  const audioUrl = getAudioUrl(clip);
  return {
    id: clip.id,
    title: clip.title || "Untitled",
    audio_url: audioUrl,
    image_large_url: clip.image_large_url || null,
    format: getAudioExtension(audioUrl),
    duration: clip.metadata?.duration || null,
    created_at: clip.created_at || null,
    clipData: clip,
  };
}

function clipsForPopup(clips) {
  return clips.map(({ clipData, ...rest }) => rest);
}

async function extractTokenFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      let attempts = 0;
      while ((!window.Clerk || !window.Clerk.session) && attempts < 20) {
        await new Promise((r) => setTimeout(r, 500));
        attempts++;
      }
      if (!window.Clerk || !window.Clerk.session) {
        return { success: false, error: "Clerk not available — are you logged in?" };
      }
      try {
        const token = await window.Clerk.session.getToken();

        // Extract Suno UUID from localStorage session
        let userId = null;
        const sessionData = localStorage.getItem('session');
        if (sessionData) {
          const parsed = JSON.parse(sessionData);
          userId = parsed?.identity?.id;
        }

        if (!userId) {
          return { success: false, error: "Could not read Suno user ID from session" };
        }
        return { success: true, token, userId };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  });
  const result = results?.[0]?.result;
  if (!result?.success || !result.token || !result.userId) {
    return { success: false, error: result?.error || "Failed to extract token" };
  }
  await saveAuth(result.token, result.userId);
  return { success: true };
}

function isPageSizeValidationError(error) {
  return (error?.status === 400 || error?.status === 422) &&
    /(?:page\s*size|page_size|\blimit\b)/i.test(error.detail || error.message || "");
}

function getPageSizeCandidates(requestedPageSize) {
  return [...new Set([requestedPageSize, ...PAGE_SIZE_FALLBACKS])];
}

async function fetchFeedPage(cursor, pageSize, filters) {
  return apiFetch("/feed/v3", {
    method: "POST",
    body: { cursor, limit: pageSize, filters },
  });
}

async function fetchFeedPageAtOffset(offset, filters) {
  return apiFetch("/feed/v3/offset", {
    method: "POST",
    body: { offset, filters },
  });
}

async function fetchFeedPageWithFallback(cursor, activePageSize, requestedPageSize, filters) {
  let lastError = null;
  const ladder = getPageSizeCandidates(requestedPageSize);
  const activeIndex = ladder.indexOf(activePageSize);
  const candidates = ladder.slice(activeIndex >= 0 ? activeIndex : 0);
  for (const pageSize of candidates) {
    try {
      return { data: await fetchFeedPage(cursor, pageSize, filters), pageSize };
    } catch (error) {
      lastError = error;
      if (!isPageSizeValidationError(error)) throw error;
    }
  }
  throw lastError;
}

function publishDiscoverProgress(progress, autoContext = null) {
  const enriched = autoContext
    ? {
        ...progress,
        auto: true,
        batch: autoContext.batch,
        batchStart: autoContext.start,
        batchCount: progress.count,
        cumulativeCount: autoContext.completed + progress.count,
      }
    : progress;
  state.discoverProgress = enriched;
  broadcast(Actions.DISCOVER_PROGRESS, { progress: state.discoverProgress });
}

async function discoverClips(options = {}, { autoContext = null, resetCancellation = true } = {}) {
  const { start, count, pageSize: requestedPageSize } = normalizeDiscoveryOptions(options);
  if (isDiscovering && !autoContext) {
    return { success: false, error: "Discovery already in progress" };
  }
  if (!state.token) {
    const error = "Not connected";
    publishDiscoverProgress({
      phase: "error",
      page: 0,
      count: 0,
      start,
      requestedCount: count,
      requestedPageSize,
      pageSize: requestedPageSize,
      error,
    }, autoContext);
    return { success: false, error };
  }
  if (!state.userId) {
    const error = "Missing user id — reconnect on suno.com.";
    publishDiscoverProgress({
      phase: "error",
      page: 0,
      count: 0,
      start,
      requestedCount: count,
      requestedPageSize,
      pageSize: requestedPageSize,
      error,
    }, autoContext);
    return { success: false, error };
  }

  isDiscovering = true;
  if (resetCancellation) cancelRequested = false;
  const clips = [];
  const seenIds = new Set();
  let page = 0;
  let hasMore = true;
  let cursor = null;
  let activePageSize = requestedPageSize;
  let skipped = 0;
  let offsetRequestPending = start > 0;
  const filters = buildFeedFilters(state.userId);

  debugLog("discover start", {
    start,
    count,
    requestedPageSize,
    userId: state.userId,
    filters,
  });

  publishDiscoverProgress({
    phase: "discovering",
    page: 0,
    count: 0,
    start,
    requestedCount: count,
    requestedPageSize,
    pageSize: activePageSize,
  }, autoContext);

  try {
    while (hasMore && !cancelRequested) {
      debugLog("discover page request", {
        page,
        cursor,
        offset: offsetRequestPending ? start : null,
        limit: activePageSize,
        filters,
      });
      const usedOffset = offsetRequestPending;
      const pageResult = usedOffset
        ? { data: await fetchFeedPageAtOffset(start, filters), pageSize: activePageSize }
        : await fetchFeedPageWithFallback(
          cursor,
          activePageSize,
          requestedPageSize,
          filters,
        );
      offsetRequestPending = false;
      if (usedOffset) skipped = start;
      if (pageResult.pageSize !== activePageSize) {
        debugLog("discover page size fallback", {
          requestedPageSize,
          from: activePageSize,
          to: pageResult.pageSize,
        });
      }
      activePageSize = pageResult.pageSize;
      const data = pageResult.data;
      if (usedOffset) {
        cursor = data?.clip_id || data?.next_cursor || null;
        offsetRequestPending = false;
        if (!cursor) hasMore = false;
        debugLog("discover offset cursor", { cursor });
        continue;
      }
      const pageClips = data?.clips || [];
      const nextCursor = data?.next_cursor;
      debugLog("discover page result", {
        page,
        clipCount: pageClips.length,
        pageSize: activePageSize,
        has_more: data?.has_more,
        next_cursor: nextCursor ?? null,
        sampleKeys: pageClips[0] ? Object.keys(pageClips[0]) : [],
        rawKeys: data && typeof data === "object" ? Object.keys(data) : [],
      });
      for (const clip of pageClips) {
        const seenKey = clip?.id || `page-${page}-clip-${skipped + clips.length}`;
        if (seenIds.has(seenKey)) continue;
        seenIds.add(seenKey);
        if (!usedOffset && skipped < start) {
          skipped++;
          continue;
        }
        if (count > 0 && clips.length >= count) break;
        const normalized = normalizeClip(clip);
        clips.push(normalized);
      }
      const reachedCount = count > 0 && clips.length >= count;
      const feedHasMore = Boolean(data.has_more && pageClips.length > 0 && nextCursor);
      hasMore = hasMore && feedHasMore && !reachedCount;
      cursor = nextCursor || null;
      if (!cursor) hasMore = false;
      page++;
      publishDiscoverProgress({
        phase: "discovering",
        page,
        count: clips.length,
        skipped,
        start,
        requestedCount: count,
        requestedPageSize,
        pageSize: activePageSize,
      }, autoContext);
      if (reachedCount) {
        // Manual discovery stops at count; auto mode needs the cursor signal
        // to decide whether to request the next batch.
        if (autoContext) hasMore = feedHasMore;
        break;
      }
    }

    state.clips = clips;
    state.lastDiscovery = {
      source: "suno",
      fetched_at: new Date().toISOString(),
      start,
      requested_count: count,
      actual_count: clips.length,
      requested_page_size: requestedPageSize,
      page_size: activePageSize,
      clips: clips.map(({ clipData }) => clipData),
    };
    if (!autoContext && !cancelRequested && count > 0 && clips.length > 0) {
      await saveDiscoveryOptions({
        ...state.discoveryOptions,
        start: start + clips.length,
      });
    }
    if (!autoContext) {
      publishDiscoverProgress({
        phase: cancelRequested ? "cancelled" : "complete",
        page,
        count: clips.length,
        skipped,
        start,
        requestedCount: count,
        requestedPageSize,
        pageSize: activePageSize,
      });
    }
    debugLog("discover done", {
      phase: state.discoverProgress.phase,
      pages: page,
      count: clips.length,
    });
    return {
      success: true,
      cancelled: cancelRequested,
      count: clips.length,
      hasMore: !cancelRequested && hasMore,
      clips: clipsForPopup(clips),
    };
  } catch (err) {
    console.error("[suno-dl] discover failed", {
      page,
      count: clips.length,
      userId: state.userId,
      cursor,
      filters,
      error: err?.message || String(err),
      stack: err?.stack,
    });
    // Also log to console to ensure visibility
    console.error("[suno-dl] DISCOVER ERROR:", err);
    publishDiscoverProgress({
      phase: "error",
      page,
      count: clips.length,
      start,
      requestedCount: count,
      requestedPageSize,
      pageSize: activePageSize,
      error: err.message,
    }, autoContext);
    return { success: false, error: err.message };
  } finally {
    isDiscovering = false;
  }
}

async function autoDiscoverClips(options = {}) {
  if (isDiscovering || isAutoDiscovering) {
    return { success: false, error: "Discovery already in progress" };
  }

  const normalized = normalizeDiscoveryOptions(options);
  isAutoDiscovering = true;
  cancelRequested = false;
  let nextStart = normalized.start;
  let cumulativeCount = 0;
  let batch = 0;
  let lastSavedBatchStart = nextStart;
  let lastSavedBatchCount = 0;

  try {
    while (!cancelRequested) {
      batch++;
      const autoContext = {
        batch,
        start: nextStart,
        completed: cumulativeCount,
      };
      const result = await discoverClips(
        {
          ...normalized,
          start: nextStart,
          count: normalized.catalogBatchSize,
          auto: true,
        },
        { autoContext, resetCancellation: false },
      );

      if (!result.success) {
        publishDiscoverProgress({
          ...state.discoverProgress,
          autoComplete: true,
          count: lastSavedBatchCount,
          start: lastSavedBatchStart,
          error: result.error,
          phase: "error",
        }, {
          batch,
          start: lastSavedBatchStart,
          completed: cumulativeCount - lastSavedBatchCount,
        });
        return result;
      }
      if (result.cancelled) break;

      if (result.count === 0) break;

      const basePath = sanitizeDownloadFolder(state.downloadPath);
      await extractAggregateJson(basePath);

      cumulativeCount += result.count;
      lastSavedBatchStart = nextStart;
      lastSavedBatchCount = result.count;
      nextStart += result.count;
      await saveDiscoveryOptions({
        ...state.discoveryOptions,
        start: nextStart,
        auto: true,
      });

      if (
        cancelRequested ||
        result.count < normalized.catalogBatchSize ||
        !result.hasMore
      ) {
        break;
      }
    }

    publishDiscoverProgress({
      phase: cancelRequested ? "cancelled" : "complete",
      page: state.discoverProgress.page || 0,
      count: lastSavedBatchCount,
      start: lastSavedBatchStart,
      requestedCount: normalized.catalogBatchSize,
      requestedPageSize: normalized.pageSize,
      pageSize: state.discoverProgress.pageSize || normalized.pageSize,
      autoComplete: true,
    }, {
      batch,
      start: lastSavedBatchStart,
      completed: cumulativeCount - lastSavedBatchCount,
    });
    return {
      success: true,
      count: cumulativeCount,
      cancelled: cancelRequested,
    };
  } catch (err) {
    publishDiscoverProgress({
      phase: "error",
      page: state.discoverProgress.page || 0,
      count: lastSavedBatchCount,
      start: lastSavedBatchStart,
      requestedCount: normalized.catalogBatchSize,
      requestedPageSize: normalized.pageSize,
      pageSize: state.discoverProgress.pageSize || normalized.pageSize,
      error: err.message,
      autoComplete: true,
    }, {
      batch,
      start: lastSavedBatchStart,
      completed: cumulativeCount - lastSavedBatchCount,
    });
    return { success: false, error: err.message };
  } finally {
    isAutoDiscovering = false;
  }
}

function downloadFromUrl(url, filename) {
  return new Promise((resolve, reject) => {
    let downloadId = null;
    let finished = false;
    let timeoutId = null;

    const cleanup = () => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      if (timeoutId) clearTimeout(timeoutId);
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === "complete") {
        cleanup();
        chrome.downloads.search({ id: downloadId }, (items) => {
          resolve({ fileSize: items[0]?.fileSize || 0 });
        });
      }
      if (delta.state?.current === "interrupted" || delta.error?.current) {
        cleanup();
        reject(new Error(delta.error?.current || "Download interrupted"));
      }
    };

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify",
      },
      (id) => {
        if (chrome.runtime.lastError) {
          cleanup();
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        downloadId = id;
        timeoutId = setTimeout(() => {
          cleanup();
          if (downloadId) chrome.downloads.cancel(downloadId);
          reject(new Error("Download timeout (5 min)"));
        }, DOWNLOAD_TIMEOUT_MS);
      },
    );
  });
}

function buildMetadataPayload(clip) {
  const raw = clip.clipData || clip;
  const meta = raw.metadata || {};

  return {
    title: raw.title,
    play_count: raw.play_count,
    upvote_count: raw.upvote_count,
    id: raw.id,
    video_url: raw.video_url,
    audio_url: raw.audio_url,
    media_urls: raw.media_urls || [],
    image_url: raw.image_url,
    style: meta.tags,
    lyrics: meta.prompt,
    duration: meta.duration,
    user_id: raw.user_id,
    display_name: raw.display_name,
    handle: raw.handle,
    avatar_image_url: raw.avatar_image_url,
    reaction: raw.reaction,
    display_tags: raw.display_tags,
    created_at: raw.created_at,
    is_public: raw.is_public,
    clip_roots: raw.clip_roots,
  };
}

async function downloadJsonMetadata(clip, basePath) {
  const payload = buildMetadataPayload(clip);
  const json = JSON.stringify(payload, null, 2);
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  return downloadFromUrl(dataUrl, getMetadataFilename(clip, basePath));
}

const CATALOG_OMITTED_KEYS = new Set([
  "model_badges",
  "action_config",
  "ownership",
]);

function sanitizeCatalogPayload(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeCatalogPayload);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CATALOG_OMITTED_KEYS.has(key))
      .map(([key, nestedValue]) => [key, sanitizeCatalogPayload(nestedValue)]),
  );
}

async function extractAggregateJson(basePath) {
  if (!state.lastDiscovery) {
    throw new Error("No discovery results — run Discover first");
  }
  const discovery = {
    ...state.lastDiscovery,
    clips: state.clips.map(({ clipData }) => clipData),
    actual_count: state.clips.length,
  };
  const persistedDiscovery = sanitizeCatalogPayload(discovery);
  const json = JSON.stringify(persistedDiscovery, null, 2);
  const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  return downloadFromUrl(
    dataUrl,
    getAggregateMetadataFilename(persistedDiscovery, basePath),
  );
}

async function downloadLyrics(clip, basePath) {
  const raw = clip.clipData || clip;
  const lyrics = raw.metadata?.prompt;
  if (!lyrics || !lyrics.trim()) return null;
  const dataUrl = "data:text/plain;charset=utf-8," + encodeURIComponent(lyrics);
  return downloadFromUrl(dataUrl, getLyricsFilename(clip, basePath));
}

async function downloadWithRetry(fn, attempt = 0) {
  try {
    return await fn();
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = 2000 * Math.pow(2, attempt);
      await sleep(delay);
      return downloadWithRetry(fn, attempt + 1);
    }
    throw err;
  }
}

async function downloadClipAssets(clip, basePath) {
  const assetErrors = [];

  await downloadWithRetry(() =>
    downloadFromUrl(clip.audio_url, getAudioFilename(clip, basePath)),
  );

  if (clip.image_large_url) {
    try {
      await downloadWithRetry(() =>
        downloadFromUrl(clip.image_large_url, getImageFilename(clip, basePath)),
      );
    } catch (err) {
      assetErrors.push(`image: ${err.message}`);
    }
  }

  try {
    await downloadWithRetry(() => downloadJsonMetadata(clip, basePath));
  } catch (err) {
    assetErrors.push(`metadata: ${err.message}`);
  }

  try {
    await downloadLyrics(clip, basePath);
  } catch (err) {
    assetErrors.push(`lyrics: ${err.message}`);
  }

  return { assetErrors };
}

async function runDownloadQueue(clips, basePath) {
  const errors = [];
  let completed = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (!cancelRequested) {
      const index = nextIndex++;
      if (index >= clips.length) break;

      const clip = clips[index];
      state.downloadProgress.statuses[clip.id] = "active";
      state.downloadProgress.currentTitle = clip.title;
      state.downloadProgress.currentClipId = clip.id;
      broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });

      try {
        if (!clip.audio_url) throw new Error("No audio URL");
        const { assetErrors } = await downloadClipAssets(clip, basePath);
        if (assetErrors.length) {
          errors.push({
            id: clip.id,
            title: clip.title,
            error: assetErrors.join("; "),
          });
          state.downloadProgress.statuses[clip.id] = "error";
          state.downloadProgress.errors = [...errors];
        }
      } catch (err) {
        errors.push({ id: clip.id, title: clip.title, error: err.message });
        state.downloadProgress.statuses[clip.id] = "error";
        state.downloadProgress.errors = [...errors];
      }

      if (!errors.some((error) => error.id === clip.id)) {
        state.downloadProgress.statuses[clip.id] = "ok";
      }

      completed++;
      if (
        !errors.some((error) => error.id === clip.id) &&
        !state.completedClipIds.includes(clip.id)
      ) {
        state.completedClipIds.push(clip.id);
        await chrome.storage.local.set({ completedClipIds: state.completedClipIds });
      }
      state.downloadProgress.current = completed;
      broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });
    }
  };

  await Promise.all(
    Array.from({ length: CONCURRENT_DOWNLOADS }, () => worker()),
  );
  return { completed, errors };
}

async function startDownload(limit = 0, selectedIds = null) {
  if (isDownloading) {
    return { success: false, error: "Download already in progress" };
  }
  if (!state.clips.length) {
    return { success: false, error: "No clips discovered — run Discover first" };
  }

  isDownloading = true;
  cancelRequested = false;
  const basePath = sanitizeDownloadFolder(state.downloadPath);
  let clips = limit > 0 ? state.clips.slice(0, limit) : state.clips;
  if (Array.isArray(selectedIds)) {
    const selectedIdSet = new Set(selectedIds);
    clips = clips.filter((clip) => selectedIdSet.has(clip.id));
  }
  const selectedIdSet = new Set(clips.map((clip) => clip.id));

  state.downloadProgress = {
    phase: "downloading",
    current: 0,
    total: clips.length,
    currentTitle: "",
    currentClipId: "",
    statuses: Object.fromEntries(
      state.clips.map((clip) => [clip.id, selectedIdSet.has(clip.id) ? null : "skipped"]),
    ),
    errors: [],
  };
  broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });

  try {
    const { completed, errors } = await runDownloadQueue(clips, basePath);
    if (!cancelRequested && errors.length === 0) {
      // Clean run — reset resume state
      state.completedClipIds = [];
      await chrome.storage.local.remove("completedClipIds");
    }
    state.downloadProgress.phase = cancelRequested ? "cancelled" : "complete";
    state.downloadProgress.current = completed;
    state.downloadProgress.errors = errors;
    if (cancelRequested) {
      for (const id of Object.keys(state.downloadProgress.statuses)) {
        if (state.downloadProgress.statuses[id] === null) {
          state.downloadProgress.statuses[id] = "skipped";
        }
      }
    }
    broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });
    return {
      success: true,
      completed,
      failed: errors.length,
      errors,
      cancelled: cancelRequested,
    };
  } catch (err) {
    state.downloadProgress.phase = "error";
    state.downloadProgress.error = err.message;
    broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });
    return { success: false, error: err.message };
  } finally {
    isDownloading = false;
  }
}

function cancelDownload() {
  cancelRequested = true;
  return { success: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message.action) {
      case Actions.EXTRACT_TOKEN: {
        const tabId = message.tabId;
        if (!tabId) {
          sendResponse({ success: false, error: "No tab ID" });
          return;
        }
        sendResponse(await extractTokenFromTab(tabId));
        break;
      }
      case Actions.GET_STATE:
        sendResponse({
          success: true,
          connected: !!(state.token && state.userId),
          downloadPath: state.downloadPath,
          clipCount: state.clips.length,
          clips: clipsForPopup(state.clips),
          discoverProgress: state.discoverProgress,
          downloadProgress: state.downloadProgress,
          isDiscovering,
          isAutoDiscovering,
          isDownloading,
          completedClipIds: state.completedClipIds,
          discoveryOptions: state.discoveryOptions,
          lastDiscovery: state.lastDiscovery
            ? {
                start: state.lastDiscovery.start,
                requested_count: state.lastDiscovery.requested_count,
                actual_count: state.lastDiscovery.actual_count,
                requested_page_size: state.lastDiscovery.requested_page_size,
                page_size: state.lastDiscovery.page_size,
              }
            : null,
        });
        break;
      case Actions.SET_DOWNLOAD_PATH:
        await saveDownloadPath(message.path);
        sendResponse({ success: true, downloadPath: state.downloadPath });
        break;
      case Actions.SET_DISCOVERY_OPTIONS:
        await saveDiscoveryOptions(message.options || {});
        sendResponse({ success: true, discoveryOptions: state.discoveryOptions });
        break;
      case Actions.DISCOVER:
        if (isDiscovering || isAutoDiscovering) {
          sendResponse({ success: false, error: "Discovery already in progress" });
          break;
        }
        // Fire and forget — popup polls via GET_STATE / DISCOVER_PROGRESS broadcasts
        const discoveryOptions = normalizeDiscoveryOptions(message.options || state.discoveryOptions);
        const discoveryRunner = discoveryOptions.auto ? autoDiscoverClips : discoverClips;
        discoveryRunner(discoveryOptions).catch((err) => {
          console.error("[suno-dl] background discover error", err);
        });
        sendResponse({ success: true, started: true });
        break;
      case Actions.EXTRACT_JSON:
        try {
          const basePath = sanitizeDownloadFolder(state.downloadPath);
          await extractAggregateJson(basePath);
          sendResponse({ success: true, count: state.clips.length });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
        break;
      case Actions.START_DOWNLOAD:
        sendResponse(
          await startDownload(message.limit || 0, message.selectedIds ?? null),
        );
        break;
      case Actions.RESUME_DOWNLOAD: {
        // Re-run startDownload but exclude already-completed clips
        const remaining = state.clips.filter(
          (clip) => !state.completedClipIds.includes(clip.id),
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
      case Actions.CANCEL_DOWNLOAD:
        sendResponse(cancelDownload());
        break;
      default:
        sendResponse({ success: false, error: "Unknown action" });
    }
  })();
  return true;
});

// Service worker startup log
console.log("[suno-dl] Service worker started", {
  timestamp: new Date().toISOString(),
  version: chrome.runtime.getManifest().version
});
debugLog("Service worker initialized");
loadState();
