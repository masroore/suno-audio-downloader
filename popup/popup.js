const Actions = {
  EXTRACT_TOKEN: "extractToken",
  GET_STATE: "getState",
  SET_DOWNLOAD_PATH: "setDownloadPath",
  DISCOVER: "discover",
  START_DOWNLOAD: "startDownload",
  RESUME_DOWNLOAD: "resumeDownload",
  CANCEL_DOWNLOAD: "cancelDownload",
  DISCOVER_PROGRESS: "discoverProgress",
  DOWNLOAD_PROGRESS: "downloadProgress",
};

const el = {
  status: document.getElementById("status"),
  downloadPath: document.getElementById("download-path"),
  limitInput: document.getElementById("limit-input"),
  btnConnect: document.getElementById("btn-connect"),
  btnDiscover: document.getElementById("btn-discover"),
  btnDownload: document.getElementById("btn-download"),
  btnResume: document.getElementById("btn-resume"),
  btnCancel: document.getElementById("btn-cancel"),
  progressPanel: document.getElementById("progress-panel"),
  progressText: document.getElementById("progress-text"),
  progressBar: document.getElementById("progress-bar"),
  progressDetail: document.getElementById("progress-detail"),
  clipCount: document.getElementById("clip-count"),
  clipList: document.getElementById("clip-list"),
  selectBar: document.getElementById("select-bar"),
  chkSelectAll: document.getElementById("chk-select-all"),
  selectedCount: document.getElementById("selected-count"),
};

function send(action, data = {}) {
  return chrome.runtime.sendMessage({ action, ...data });
}

function setStatus(text, kind = "idle") {
  el.status.textContent = text;
  el.status.className = `status status-${kind}`;
}

function getLimit() {
  const value = parseInt(el.limitInput.value, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatDuration(seconds) {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderClips(clips, statuses = {}) {
  currentClips = clips;
  el.clipCount.textContent = String(clips.length);
  el.clipList.innerHTML = "";
  el.selectBar.hidden = clips.length === 0;
  selectedIds = new Set(clips.map((clip) => clip.id));

  const preview = clips.slice(0, 50);
  for (const clip of preview) {
    const li = document.createElement("li");
    li.dataset.id = clip.id;
    const duration = formatDuration(clip.duration);
    li.innerHTML = `
      <label class="clip-row">
        <input type="checkbox" class="clip-chk" data-id="${escapeHtml(clip.id)}" checked />
        <span class="clip-title">${escapeHtml(clip.title)}</span>
        <span class="clip-meta">${escapeHtml(clip.format.toUpperCase())}${duration ? ` · ${duration}` : ""}</span>
      </label>
    `;
    el.clipList.appendChild(li);
    if (statuses[clip.id]) setClipStatus(clip.id, statuses[clip.id]);
  }
  if (clips.length > 50) {
    const li = document.createElement("li");
    li.className = "clip-meta";
    li.textContent = `…and ${clips.length - 50} more`;
    el.clipList.appendChild(li);
  }
  updateSelectAllState();
  updateDownloadButton();
}

function updateSelectAllState() {
  const total = currentClips.length;
  el.chkSelectAll.checked = total > 0 && selectedIds.size === total;
  el.chkSelectAll.indeterminate = selectedIds.size > 0 && selectedIds.size < total;
  el.selectedCount.textContent = `${selectedIds.size} selected`;
}

function updateDownloadButton() {
  el.btnDownload.textContent =
    selectedIds.size === clipCount
      ? "Download all"
      : `Download selected (${selectedIds.size})`;
  el.btnDownload.disabled = busy || clipCount === 0 || selectedIds.size === 0;
}

function setClipStatus(clipId, status) {
  const li = [...el.clipList.querySelectorAll("li[data-id]")]
    .find((item) => item.dataset.id === String(clipId));
  if (!li) return;

  li.querySelector(".clip-status")?.remove();
  if (!status || status === "pending") return;

  const badge = document.createElement("span");
  badge.className = `clip-status clip-status-${status}`;
  badge.setAttribute(
    "aria-label",
    status === "ok"
      ? "Downloaded"
      : status === "error"
        ? "Failed"
        : status === "skipped"
          ? "Not included"
          : "Downloading",
  );
  badge.textContent = status === "ok" ? "✓" : status === "error" ? "✗" : status === "skipped" ? "–" : "↓";
  const meta = li.querySelector(".clip-meta");
  if (meta) meta.insertAdjacentElement("afterend", badge);
  else li.appendChild(badge);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function updateProgress(progress, type) {
  el.progressPanel.hidden = false;
  if (type === "discover") {
    if (progress.phase === "discovering") {
      setStatus("Discovering…", "busy");
      el.progressText.textContent = `Fetching page ${progress.page}…`;
      el.progressDetail.textContent = `${progress.count} clips found`;
      el.progressBar.style.width = progress.totalEstimate
        ? `${Math.min(100, (progress.count / progress.totalEstimate) * 100)}%`
        : "30%";
    } else if (progress.phase === "complete") {
      setStatus(`Connected · ${progress.count} clips`, "ok");
      el.progressText.textContent = "Discovery complete";
      el.progressDetail.textContent = "";
      el.progressBar.style.width = "100%";
    } else if (progress.phase === "cancelled") {
      el.progressText.textContent = "Discovery cancelled";
    } else if (progress.phase === "error") {
      setStatus(progress.error || "Discovery failed", "error");
      el.progressText.textContent = "Discovery failed";
      el.progressDetail.textContent = progress.error || "";
    }
    return;
  }

  if (type === "download") {
    renderProgressStatuses(progress);
    if (progress.phase === "downloading") {
      setStatus("Downloading…", "busy");
      const pct = progress.total
        ? Math.round((progress.current / progress.total) * 100)
        : 0;
      el.progressText.textContent = `${progress.current} / ${progress.total}`;
      el.progressDetail.textContent = progress.currentTitle || "";
      el.progressBar.style.width = `${pct}%`;
      el.btnCancel.disabled = false;
      if (progress.currentClipId) {
        setClipStatus(progress.currentClipId, "active");
      }
    } else if (progress.phase === "complete") {
      const failed = progress.errors?.length || 0;
      setStatus(
        failed
          ? `Done with ${failed} error(s)`
          : `Downloaded ${progress.current} file(s)`,
        failed ? "error" : "ok",
      );
      el.progressText.textContent = "Download complete";
      el.progressDetail.textContent = failed
        ? progress.errors.map((e) => e.title).join(", ")
        : "";
      el.progressBar.style.width = "100%";
      el.btnCancel.disabled = true;
      renderProgressStatuses(progress);
    } else if (progress.phase === "cancelled") {
      el.progressText.textContent = "Download cancelled";
      el.btnCancel.disabled = true;
      renderProgressStatuses(progress);
    }
  }
}

function renderProgressStatuses(progress) {
  for (const [id, status] of Object.entries(progress.statuses || {})) {
    setClipStatus(id, status);
  }
}

function setBusy(nextBusy) {
  busy = nextBusy;
  el.btnConnect.disabled = busy;
  el.btnDiscover.disabled = busy || !connected;
  updateDownloadButton();
  if (!el.btnResume.hidden) {
    el.btnResume.disabled = busy;
  }
}

let connected = false;
let clipCount = 0;
let busy = false;
let selectedIds = new Set();
let currentClips = [];

async function refreshState() {
  const res = await send(Actions.GET_STATE);
  if (!res?.success) return;
  connected = res.connected;
  clipCount = res.clipCount;
  el.downloadPath.value = (res.downloadPath || "SunoDownloads").replace(/[\\/]+/g, "");
  if (Array.isArray(res.clips)) {
    renderClips(res.clips, res.downloadProgress?.statuses);
  }
  const busy = res.isDiscovering || res.isDownloading;
  if (busy) {
    setBusy(true);
    el.btnCancel.disabled = false;
  } else {
    setBusy(false);
    el.btnCancel.disabled = true;
  }
  const hasResumable =
    res.completedClipIds?.length > 0 &&
    res.clipCount > 0 &&
    res.completedClipIds.length < res.clipCount;
  el.btnResume.hidden = !hasResumable;
  el.btnResume.disabled = hasResumable ? busy : true;
  if (hasResumable) {
    const remaining = res.clipCount - res.completedClipIds.length;
    el.btnResume.textContent = `Resume (${remaining} left)`;
  }
  if (connected && !res.isDiscovering && !res.isDownloading) {
    setStatus(clipCount ? `Connected · ${clipCount} clips` : "Connected", "ok");
  } else if (!connected) {
    setStatus("Not connected", "idle");
  }
  if (res.discoverProgress?.phase === "discovering") {
    updateProgress(res.discoverProgress, "discover");
  }
  if (res.downloadProgress?.phase && res.downloadProgress.phase !== "idle") {
    updateProgress(res.downloadProgress, "download");
  }
}

el.btnConnect.addEventListener("click", async () => {
  setStatus("Connecting…", "busy");
  el.btnConnect.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.includes("suno.com")) {
      setStatus("Open suno.com in the active tab first", "error");
      el.btnConnect.disabled = false;
      return;
    }
    const res = await send(Actions.EXTRACT_TOKEN, { tabId: tab.id });
    if (!res.success) {
      setStatus(res.error || "Connect failed", "error");
      el.btnConnect.disabled = false;
      return;
    }
    connected = true;
    setStatus("Connected", "ok");
    el.btnDiscover.disabled = false;
  } catch (err) {
    setStatus(err.message, "error");
    el.btnConnect.disabled = false;
  }
});

async function persistDownloadPath() {
  const path = el.downloadPath.value.trim() || "SunoDownloads";
  const res = await send(Actions.SET_DOWNLOAD_PATH, { path });
  if (res?.downloadPath) el.downloadPath.value = res.downloadPath;
}

el.downloadPath.addEventListener("change", persistDownloadPath);
el.downloadPath.addEventListener("blur", persistDownloadPath);

el.clipList.addEventListener("change", (event) => {
  if (!event.target.classList.contains("clip-chk")) return;
  const id = event.target.dataset.id;
  if (event.target.checked) {
    selectedIds.add(id);
  } else {
    selectedIds.delete(id);
  }
  updateSelectAllState();
  updateDownloadButton();
});

el.chkSelectAll.addEventListener("change", () => {
  const checked = el.chkSelectAll.checked;
  selectedIds = checked
    ? new Set(currentClips.map((clip) => clip.id))
    : new Set();
  el.clipList.querySelectorAll(".clip-chk").forEach((checkbox) => {
    checkbox.checked = checked;
  });
  updateSelectAllState();
  updateDownloadButton();
});

el.btnDiscover.addEventListener("click", async () => {
  setBusy(true);
  el.progressPanel.hidden = false;
  el.progressText.textContent = "Starting discovery…";
  const res = await send(Actions.DISCOVER, { limit: getLimit() });
  if (!res.success) {
    setBusy(false);
    setStatus(res.error || "Discover failed", "error");
    return;
  }
  // Discovery is running in the background. Progress arrives via broadcasts.
  setStatus("Discovering…", "busy");
});

el.btnDownload.addEventListener("click", async () => {
  setBusy(true);
  el.btnCancel.disabled = false;
  const idsToDownload =
    selectedIds.size === clipCount ? null : [...selectedIds];
  const res = await send(Actions.START_DOWNLOAD, {
    limit: getLimit(),
    selectedIds: idsToDownload,
  });
  setBusy(false);
  el.btnCancel.disabled = true;
  if (!res.success) {
    setStatus(res.error || "Download failed", "error");
    return;
  }
  const failed = res.failed || 0;
  setStatus(
    res.cancelled
      ? "Download cancelled"
      : failed
        ? `Done · ${res.completed} ok, ${failed} failed`
        : `Downloaded ${res.completed} file(s)`,
    failed ? "error" : "ok",
  );
});

el.btnCancel.addEventListener("click", async () => {
  await send(Actions.CANCEL_DOWNLOAD);
  el.btnCancel.disabled = true;
});

el.btnResume.addEventListener("click", async () => {
  setBusy(true);
  el.btnCancel.disabled = false;
  const res = await send(Actions.RESUME_DOWNLOAD, { limit: getLimit() });
  setBusy(false);
  el.btnCancel.disabled = true;
  el.btnResume.hidden = true;
  if (!res.success) {
    setStatus(res.error || "Resume failed", "error");
    return;
  }
  const failed = res.failed || 0;
  setStatus(
    res.cancelled
      ? "Download cancelled"
      : failed
        ? `Done · ${res.completed} ok, ${failed} failed`
        : `Downloaded ${res.completed} file(s)`,
    failed ? "error" : "ok",
  );
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === Actions.DISCOVER_PROGRESS && message.progress) {
    updateProgress(message.progress, "discover");
    if (message.progress.phase === "complete") {
      refreshState();
    }
  }
  if (message.action === Actions.DOWNLOAD_PROGRESS && message.progress) {
    updateProgress(message.progress, "download");
    if (message.progress.phase === "complete" || message.progress.phase === "cancelled") {
      setBusy(false);
      el.btnCancel.disabled = true;
    }
  }
});

refreshState();
