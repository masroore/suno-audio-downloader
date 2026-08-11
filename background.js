const API_BASE = "https://studio-api.prod.suno.com/api";
const API_DELAY_MS = 500;
const MAX_RETRIES = 3;
const CONCURRENT_DOWNLOADS = 2;
const DOWNLOAD_TIMEOUT_MS = 300000;

const Actions = {
  EXTRACT_TOKEN: "extractToken",
  GET_STATE: "getState",
  SET_DOWNLOAD_PATH: "setDownloadPath",
  DISCOVER: "discover",
  START_DOWNLOAD: "startDownload",
  CANCEL_DOWNLOAD: "cancelDownload",
  DISCOVER_PROGRESS: "discoverProgress",
  DOWNLOAD_PROGRESS: "downloadProgress",
};

let state = {
  token: null,
  downloadPath: "SunoDownloads",
  clips: [],
  discoverProgress: { phase: "idle", page: 0, count: 0 },
  downloadProgress: {
    phase: "idle",
    current: 0,
    total: 0,
    currentTitle: "",
    errors: [],
  },
};

let isDiscovering = false;
let isDownloading = false;
let cancelRequested = false;
let lastApiRequest = 0;

async function loadState() {
  const stored = await chrome.storage.local.get(["token", "downloadPath"]);
  if (stored.token) state.token = stored.token;
  if (stored.downloadPath) state.downloadPath = stored.downloadPath;
}

async function saveToken(token) {
  state.token = token;
  await chrome.storage.local.set({ token });
}

async function saveDownloadPath(path) {
  state.downloadPath = path || "SunoDownloads";
  await chrome.storage.local.set({ downloadPath: state.downloadPath });
}

function broadcast(action, data) {
  chrome.runtime.sendMessage({ action, ...data }).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiRateLimit() {
  const elapsed = Date.now() - lastApiRequest;
  if (elapsed < API_DELAY_MS) {
    await sleep(API_DELAY_MS - elapsed);
  }
  lastApiRequest = Date.now();
}

async function apiFetch(endpoint) {
  if (!state.token) {
    throw new Error("Not connected — open suno.com and click Connect.");
  }
  await apiRateLimit();
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    if (response.status === 401) {
      state.token = null;
      await chrome.storage.local.remove("token");
      throw new Error("Token expired — reconnect on suno.com.");
    }
    if (response.status === 429) {
      await sleep(5000);
      return apiFetch(endpoint);
    }
    throw new Error(`API error: ${response.status}`);
  }
  return response.json();
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

function getDownloadFilename(clip, basePath) {
  const title = sanitizeFilename(clip.title || "Untitled");
  const shortId = clip.id ? clip.id.substring(0, 8) : "unknown";
  const audioUrl = getAudioUrl(clip);
  const ext = getAudioExtension(audioUrl);
  const filename = `${title} [${shortId}].${ext}`;
  return `${basePath}/${filename}`;
}

function normalizeClip(clip) {
  const audioUrl = getAudioUrl(clip);
  return {
    id: clip.id,
    title: clip.title || "Untitled",
    audio_url: audioUrl,
    format: getAudioExtension(audioUrl),
    duration: clip.metadata?.duration || null,
    created_at: clip.created_at || null,
  };
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
        return { success: true, token };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
  });
  const result = results?.[0]?.result;
  if (!result?.success || !result.token) {
    return { success: false, error: result?.error || "Failed to extract token" };
  }
  await saveToken(result.token);
  return { success: true };
}

async function discoverClips(limit = 0) {
  if (isDiscovering) {
    return { success: false, error: "Discovery already in progress" };
  }
  if (!state.token) {
    return { success: false, error: "Not connected" };
  }

  isDiscovering = true;
  cancelRequested = false;
  const clips = [];
  let page = 0;
  let hasMore = true;

  state.discoverProgress = { phase: "discovering", page: 0, count: 0 };
  broadcast(Actions.DISCOVER_PROGRESS, { progress: state.discoverProgress });

  try {
    while (hasMore && !cancelRequested) {
      const params = new URLSearchParams({
        hide_disliked: "false",
        hide_gen_stems: "true",
        hide_studio_clips: "false",
        page: page.toString(),
      });
      const data = await apiFetch(`/feed/v2?${params}`);
      const pageClips = data.clips || [];
      for (const clip of pageClips) {
        if (limit > 0 && clips.length >= limit) {
          hasMore = false;
          break;
        }
        const normalized = normalizeClip(clip);
        if (normalized.audio_url) clips.push(normalized);
      }
      hasMore = hasMore && data.has_more && pageClips.length > 0;
      page++;
      state.discoverProgress = {
        phase: "discovering",
        page,
        count: clips.length,
        totalEstimate: data.num_total_results || null,
      };
      broadcast(Actions.DISCOVER_PROGRESS, { progress: state.discoverProgress });
      if (limit > 0 && clips.length >= limit) break;
    }

    state.clips = clips;
    state.discoverProgress = {
      phase: cancelRequested ? "cancelled" : "complete",
      page,
      count: clips.length,
    };
    broadcast(Actions.DISCOVER_PROGRESS, { progress: state.discoverProgress });
    return { success: true, count: clips.length, clips };
  } catch (err) {
    state.discoverProgress = { phase: "error", page, count: clips.length, error: err.message };
    broadcast(Actions.DISCOVER_PROGRESS, { progress: state.discoverProgress });
    return { success: false, error: err.message };
  } finally {
    isDiscovering = false;
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

async function downloadClipWithRetry(clip, basePath, attempt = 0) {
  const url = clip.audio_url;
  if (!url) throw new Error("No audio URL");
  const filename = getDownloadFilename(clip, basePath);
  try {
    return await downloadFromUrl(url, filename);
  } catch (err) {
    if (attempt < MAX_RETRIES) {
      const delay = 2000 * Math.pow(2, attempt);
      await sleep(delay);
      return downloadClipWithRetry(clip, basePath, attempt + 1);
    }
    throw err;
  }
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
      state.downloadProgress.currentTitle = clip.title;
      broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });

      try {
        await downloadClipWithRetry(clip, basePath);
      } catch (err) {
        errors.push({ id: clip.id, title: clip.title, error: err.message });
        state.downloadProgress.errors = [...errors];
      }

      completed++;
      state.downloadProgress.current = completed;
      broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });
      await sleep(200);
    }
  };

  await Promise.all(
    Array.from({ length: CONCURRENT_DOWNLOADS }, () => worker()),
  );
  return { completed, errors };
}

async function startDownload(limit = 0) {
  if (isDownloading) {
    return { success: false, error: "Download already in progress" };
  }
  if (!state.clips.length) {
    return { success: false, error: "No clips discovered — run Discover first" };
  }

  isDownloading = true;
  cancelRequested = false;
  const basePath = state.downloadPath || "SunoDownloads";
  const clips = limit > 0 ? state.clips.slice(0, limit) : state.clips;

  state.downloadProgress = {
    phase: "downloading",
    current: 0,
    total: clips.length,
    currentTitle: "",
    errors: [],
  };
  broadcast(Actions.DOWNLOAD_PROGRESS, { progress: state.downloadProgress });

  try {
    const { completed, errors } = await runDownloadQueue(clips, basePath);
    state.downloadProgress.phase = cancelRequested ? "cancelled" : "complete";
    state.downloadProgress.current = completed;
    state.downloadProgress.errors = errors;
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
          connected: !!state.token,
          downloadPath: state.downloadPath,
          clipCount: state.clips.length,
          clips: state.clips,
          discoverProgress: state.discoverProgress,
          downloadProgress: state.downloadProgress,
          isDiscovering,
          isDownloading,
        });
        break;
      case Actions.SET_DOWNLOAD_PATH:
        await saveDownloadPath(message.path);
        sendResponse({ success: true, downloadPath: state.downloadPath });
        break;
      case Actions.DISCOVER:
        sendResponse(await discoverClips(message.limit || 0));
        break;
      case Actions.START_DOWNLOAD:
        sendResponse(await startDownload(message.limit || 0));
        break;
      case Actions.CANCEL_DOWNLOAD:
        sendResponse(cancelDownload());
        break;
      default:
        sendResponse({ success: false, error: "Unknown action" });
    }
  })();
  return true;
});

loadState();
