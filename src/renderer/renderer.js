(() => {
  "use strict";

  const api = window.bunni ?? null;
  const ACTIVE_STATUSES = new Set(["queued", "probing", "downloading", "paused", "error"]);
  const STATUS_LABELS = {
    queued: "Queued",
    probing: "Connecting",
    downloading: "Downloading",
    paused: "Paused",
    completed: "Completed",
    cancelled: "Cancelled",
    error: "Needs attention"
  };
  const CATEGORY_STORAGE_KEY = "bunni.category-folders.v1";
  const CATEGORY_EXTENSIONS = {
    compressed: new Set(["7z", "bz2", "gz", "iso", "rar", "tar", "tgz", "xz", "zip"]),
    programs: new Set(["apk", "appx", "deb", "dmg", "exe", "msi", "msix", "pkg", "rpm"]),
    video: new Set(["avi", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "webm", "wmv"]),
    music: new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"]),
    documents: new Set(["csv", "doc", "docx", "epub", "md", "odt", "pdf", "ppt", "pptx", "rtf", "txt", "xls", "xlsx"])
  };
  const CATEGORY_DIRECTORY_NAMES = {
    compressed: "Compressed",
    programs: "Programs",
    video: "Video",
    music: "Music",
    documents: "Documents",
    general: ""
  };

  const state = {
    downloads: [],
    filter: "active",
    query: "",
    destination: "",
    settings: {
      defaultSegments: 8,
      maxConcurrent: 3,
      downloadDirectory: "",
      serverPort: 17865,
      notifyOnComplete: true
    },
    busyIds: new Set(),
    statsSpeed: null,
    renderQueued: false,
    refreshTimer: null,
    snapshotVersion: 0,
    appliedSnapshotVersion: 0,
    removedRecordIds: new Set(),
    unsubscribers: [],
    confirmResolver: null,
    captureQueue: [],
    activeCapture: null,
    captureBusy: false,
    captureBaseDirectory: "",
    captureDirectoryEdited: false
  };

  const elements = {
    addForm: document.querySelector("#addForm"),
    urlInput: document.querySelector("#urlInput"),
    urlComposer: document.querySelector(".url-composer"),
    urlMessage: document.querySelector("#urlMessage"),
    addButton: document.querySelector("#addButton"),
    segmentsEnabled: document.querySelector("#segmentsEnabled"),
    segmentCount: document.querySelector("#segmentCount"),
    destinationPath: document.querySelector("#destinationPath"),
    chooseDestination: document.querySelector("#chooseDestination"),
    downloadRows: document.querySelector("#downloadRows"),
    downloadTable: document.querySelector(".download-table"),
    emptyState: document.querySelector("#emptyState"),
    emptyTitle: document.querySelector("#emptyTitle"),
    emptyMessage: document.querySelector("#emptyMessage"),
    focusUrl: document.querySelector("#focusUrl"),
    visibleCount: document.querySelector("#visibleCount"),
    activeCount: document.querySelector("#activeCount"),
    completedCount: document.querySelector("#completedCount"),
    allCount: document.querySelector("#allCount"),
    combinedSpeed: document.querySelector("#combinedSpeed"),
    engineSignal: document.querySelector("#engineSignal"),
    engineStatus: document.querySelector("#engineStatus"),
    engineDetail: document.querySelector("#engineDetail"),
    searchInput: document.querySelector("#searchInput"),
    downloadsPanel: document.querySelector("#downloadsPanel"),
    footerDirectory: document.querySelector("#footerDirectory"),
    openSettings: document.querySelector("#openSettings"),
    settingsDialog: document.querySelector("#settingsDialog"),
    settingsForm: document.querySelector("#settingsForm"),
    closeSettings: document.querySelector("#closeSettings"),
    cancelSettings: document.querySelector("#cancelSettings"),
    saveSettings: document.querySelector("#saveSettings"),
    defaultSegments: document.querySelector("#defaultSegments"),
    maxConcurrent: document.querySelector("#maxConcurrent"),
    settingsDirectory: document.querySelector("#settingsDirectory"),
    chooseSettingsDirectory: document.querySelector("#chooseSettingsDirectory"),
    extensionPort: document.querySelector("#extensionPort"),
    notifyOnComplete: document.querySelector("#notifyOnComplete"),
    openExtensionFolder: document.querySelector("#openExtensionFolder"),
    settingsMessage: document.querySelector("#settingsMessage"),
    captureDialog: document.querySelector("#captureDialog"),
    captureForm: document.querySelector("#captureForm"),
    captureClose: document.querySelector("#captureClose"),
    captureUrl: document.querySelector("#captureUrl"),
    captureCategory: document.querySelector("#captureCategory"),
    captureFileIcon: document.querySelector("#captureFileIcon"),
    captureFileSize: document.querySelector("#captureFileSize"),
    captureFileName: document.querySelector("#captureFileName"),
    captureDirectory: document.querySelector("#captureDirectory"),
    captureBrowse: document.querySelector("#captureBrowse"),
    captureRememberFolder: document.querySelector("#captureRememberFolder"),
    captureMessage: document.querySelector("#captureMessage"),
    captureLater: document.querySelector("#captureLater"),
    captureStart: document.querySelector("#captureStart"),
    captureCancel: document.querySelector("#captureCancel"),
    confirmDialog: document.querySelector("#confirmDialog"),
    confirmTitle: document.querySelector("#confirm-title"),
    confirmMessage: document.querySelector("#confirm-message"),
    deleteFileOption: document.querySelector("#deleteFileOption"),
    deleteFileCheckbox: document.querySelector("#deleteFileCheckbox"),
    confirmCancel: document.querySelector("#confirmCancel"),
    confirmAccept: document.querySelector("#confirmAccept"),
    toastRegion: document.querySelector("#toastRegion")
  };

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function asNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getFileName(url, fallback = "Untitled download") {
    try {
      const pathName = new URL(url).pathname;
      const lastPart = pathName.split("/").filter(Boolean).pop();
      return lastPart ? decodeURIComponent(lastPart) : fallback;
    } catch {
      return fallback;
    }
  }

  function getHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url || "Unknown source";
    }
  }

  function normalizeRecord(record) {
    const source = record && typeof record === "object" ? record : {};
    const url = String(source.url ?? source.sourceUrl ?? "");
    const bytesReceived = Math.max(0, asNumber(source.bytesReceived ?? source.downloadedBytes));
    const rawTotal = source.totalBytes ?? source.size;
    const totalBytes = rawTotal === null || rawTotal === undefined ? null : Math.max(0, asNumber(rawTotal));
    const calculatedProgress = totalBytes > 0 ? (bytesReceived / totalBytes) * 100 : 0;
    const progress = clamp(asNumber(source.progress, calculatedProgress), 0, 100);
    const status = String(source.status ?? "queued").toLowerCase();

    return {
      ...source,
      id: String(source.id ?? source.downloadId ?? url),
      url,
      fileName: String(source.fileName ?? source.filename ?? source.name ?? getFileName(url)),
      destination: String(source.destination ?? source.filePath ?? source.path ?? ""),
      status,
      bytesReceived,
      totalBytes,
      speed: Math.max(0, asNumber(source.speed ?? source.bytesPerSecond)),
      eta: source.eta ?? source.etaSeconds ?? null,
      progress: status === "completed" ? 100 : progress,
      segments: source.segments ?? [],
      error: source.error ? String(source.error) : ""
    };
  }

  function normalizeList(result) {
    const records = Array.isArray(result)
      ? result
      : result?.downloads ?? result?.items ?? result?.records ?? [];
    return Array.isArray(records) ? records.map(normalizeRecord) : [];
  }

  function extractPath(result) {
    if (typeof result === "string") return result;
    if (!result || typeof result !== "object") return "";
    if (typeof result.path === "string") return result.path;
    if (typeof result.directory === "string") return result.directory;
    if (typeof result.downloadDirectory === "string") return result.downloadDirectory;
    if (Array.isArray(result.filePaths)) return result.filePaths[0] ?? "";
    return "";
  }

  function splitDestination(destination, fallbackFileName = "") {
    const value = String(destination || "");
    const separatorIndex = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
    if (separatorIndex < 0) {
      return { directory: "", fileName: fallbackFileName || value };
    }
    return {
      directory: value.slice(0, separatorIndex),
      fileName: value.slice(separatorIndex + 1) || fallbackFileName
    };
  }

  function categoryForFile(fileName) {
    const extension = extensionOf(fileName).toLowerCase();
    for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
      if (extensions.has(extension)) return category;
    }
    return "general";
  }

  function categoryFolders() {
    try {
      const value = JSON.parse(localStorage.getItem(CATEGORY_STORAGE_KEY) || "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value)
          .filter(([category, directory]) => (
            Object.hasOwn(CATEGORY_EXTENSIONS, category) || category === "general"
          ) && typeof directory === "string" && directory.trim())
      );
    } catch {
      return {};
    }
  }

  function rememberCategoryFolder(category, directory) {
    try {
      const folders = categoryFolders();
      folders[category] = directory;
      localStorage.setItem(CATEGORY_STORAGE_KEY, JSON.stringify(folders));
      return true;
    } catch {
      return false;
    }
  }

  function joinDirectory(directory, child) {
    const value = String(directory || "").trim();
    if (!value || !child) return value;

    const trimmed = value.replace(/[\\/]+$/, "");
    const currentLeaf = trimmed.split(/[\\/]/).filter(Boolean).pop() ?? "";
    if (currentLeaf.toLocaleLowerCase() === child.toLocaleLowerCase()) return trimmed;

    const separator = value.includes("\\") ? "\\" : "/";
    return `${trimmed || separator}${trimmed ? separator : ""}${child}`;
  }

  function directoryForCategory(category) {
    const remembered = categoryFolders()[category];
    if (remembered) return remembered;
    const folderName = CATEGORY_DIRECTORY_NAMES[category] ?? "";
    return joinDirectory(state.captureBaseDirectory, folderName);
  }

  function applyCaptureCategory(category, { updateDirectory = true } = {}) {
    const nextCategory = Object.hasOwn(CATEGORY_DIRECTORY_NAMES, category) ? category : "general";
    elements.captureCategory.value = nextCategory;
    if (updateDirectory) {
      elements.captureDirectory.value = directoryForCategory(nextCategory);
      state.captureDirectoryEdited = false;
    }
  }

  function normalizeCapture(payload) {
    const source = payload?.capture && typeof payload.capture === "object"
      ? payload.capture
      : payload;
    if (!source || typeof source !== "object") return null;
    const download = normalizeRecord(source.download ?? source.record ?? source);
    const id = String(source.id ?? download.id ?? "");
    if (!id || !download.url) return null;
    return {
      id,
      state: String(source.state ?? "pending").toLowerCase(),
      download
    };
  }

  async function invoke(method, ...args) {
    if (!api || typeof api[method] !== "function") {
      throw new Error("The Bunni desktop bridge is unavailable. Restart the app and try again.");
    }
    return api[method](...args);
  }

  function formatBytes(value) {
    const bytes = Math.max(0, asNumber(value));
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const amount = bytes / 1024 ** index;
    const digits = amount >= 100 || index === 0 ? 0 : amount >= 10 ? 1 : 2;
    return `${amount.toFixed(digits)} ${units[index]}`;
  }

  function formatSpeed(value) {
    return `${formatBytes(value)}/s`;
  }

  function formatEta(value) {
    if (typeof value === "string" && value.trim()) return value;
    const totalSeconds = Math.max(0, Math.round(asNumber(value)));
    if (!totalSeconds) return "Estimating…";
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${minutes}m left`;
    if (minutes) return `${minutes}m ${seconds}s left`;
    return `${seconds}s left`;
  }

  function extensionOf(fileName) {
    const match = String(fileName).match(/\.([a-z0-9]{1,8})(?:$|[?#])/i);
    return match ? match[1].slice(0, 4).toUpperCase() : "FILE";
  }

  function statusLabel(status) {
    return STATUS_LABELS[status] ?? status.replace(/[-_]/g, " ");
  }

  function hasDownloadWork(record) {
    return ACTIVE_STATUSES.has(record.status);
  }

  function filterDownloads() {
    const query = state.query.trim().toLocaleLowerCase();
    return state.downloads.filter((record) => {
      const inFilter = state.filter === "all"
        || (state.filter === "completed" && record.status === "completed")
        || (state.filter === "active" && hasDownloadWork(record));
      if (!inFilter) return false;
      if (!query) return true;
      return [record.fileName, record.url, record.destination, record.status, getHost(record.url)]
        .some((value) => String(value).toLocaleLowerCase().includes(query));
    });
  }

  function actionButton(label, action, record, variant = "") {
    const button = createElement("button", `row-action ${variant}`.trim(), label);
    button.type = "button";
    button.dataset.action = action;
    button.dataset.id = record.id;
    button.title = `${label} ${record.fileName}`;
    button.setAttribute("aria-label", `${label} ${record.fileName}`);
    button.disabled = state.busyIds.has(record.id);
    return button;
  }

  function needsBrowserRecovery(record) {
    if (record.status !== "error" || !record.error) return false;
    const message = String(record.error);
    return /\bhtml\b/i.test(message)
      || /\bweb[\s-]*page\b/i.test(message)
      || /\bbrowser[\s-]*session\b/i.test(message)
      || /\b(?:download[\s-]*)?link\b.{0,80}\bexpired\b/i.test(message)
      || /\bexpired\b.{0,80}\b(?:download[\s-]*)?link\b/i.test(message);
  }

  function conciseTransferError(record) {
    const message = String(record.error || "").replace(/\s+/g, " ").trim();
    if (!message) return "Transfer failed";
    if (needsBrowserRecovery(record)) return "Browser session required";

    const httpMatch = /\bHTTP(?:\s+(?:status|error))?\s*[:=-]?\s*(\d{3})\b/i.exec(message)
      ?? /\bstatus(?:\s+code)?\s*[:=-]?\s*(\d{3})\b/i.exec(message);
    if (httpMatch) {
      const code = Number(httpMatch[1]);
      const reason = {
        400: "bad request",
        401: "sign-in required",
        403: "access denied",
        404: "file not found",
        408: "request timed out",
        409: "server reported a conflict",
        410: "link expired",
        416: "requested byte range rejected",
        429: "server rate limit",
        500: "server error",
        502: "upstream server error",
        503: "server unavailable",
        504: "server timed out"
      }[code] ?? "server rejected the transfer";
      return `HTTP ${code} — ${reason}`;
    }

    if (/\b(?:ENOSPC|not enough (?:disk )?space|disk (?:is )?full)\b/i.test(message)) {
      return "Not enough disk space";
    }
    if (/\b(?:EACCES|EPERM|permission denied|access is denied|could not (?:create|write))\b/i.test(message)) {
      return "Cannot write to this folder";
    }
    if (/\b(?:ETIMEDOUT|timed? out|timeout)\b/i.test(message)) return "Connection timed out";
    if (/\b(?:ENOTFOUND|EAI_AGAIN|DNS)\b/i.test(message)) return "Website could not be reached";

    if (message.length <= 76) return message;
    const candidate = message.slice(0, 73);
    const lastSpace = candidate.lastIndexOf(" ");
    return `${candidate.slice(0, lastSpace > 42 ? lastSpace : candidate.length).trimEnd()}…`;
  }

  function buildSegmentDots(record) {
    const rawSegments = Array.isArray(record.segments) ? record.segments : [];
    const numericCount = Array.isArray(record.segments)
      ? rawSegments.length
      : asNumber(record.segments, 0);
    const count = clamp(Math.round(numericCount), 0, 8);
    if (count < 2) return null;

    const dots = createElement("div", "segment-dots");
    dots.setAttribute("aria-hidden", "true");
    for (let index = 0; index < count; index += 1) {
      const dot = createElement("span");
      const segment = rawSegments[index];
      const segmentStatus = String(segment?.status ?? "").toLowerCase();
      if (segmentStatus === "completed" || segmentStatus === "done") dot.className = "is-done";
      if (segmentStatus === "downloading" || segmentStatus === "active") dot.className = "is-active";
      dots.append(dot);
    }
    return dots;
  }

  function buildRow(record) {
    const row = document.createElement("tr");
    row.dataset.id = record.id;
    row.dataset.status = record.status;

    const fileColumn = createElement("td", "col-file");
    const fileCell = createElement("div", "file-cell");
    const fileType = createElement("span", "file-type", extensionOf(record.fileName));
    if (record.status === "completed") fileType.classList.add("is-complete");
    if (record.status === "error" || record.status === "cancelled") fileType.classList.add("is-error");
    fileType.setAttribute("aria-hidden", "true");
    const fileCopy = createElement("span", "file-copy");
    const fileName = createElement("span", "file-name", record.fileName);
    fileName.title = record.fileName;
    const source = createElement("span", "file-source", getHost(record.url));
    source.title = record.url;
    fileCopy.append(fileName, source);
    fileCell.append(fileType, fileCopy);
    fileColumn.append(fileCell);

    const progressColumn = createElement("td", "col-progress");
    const progressCopy = createElement("div", "progress-copy");
    const percent = createElement("strong", "", `${Math.round(record.progress)}%`);
    const byteText = record.totalBytes > 0
      ? `${formatBytes(record.bytesReceived)} of ${formatBytes(record.totalBytes)}`
      : `${formatBytes(record.bytesReceived)} received`;
    progressCopy.append(percent, createElement("span", "", byteText));
    const progress = createElement("progress", "download-progress");
    progress.max = 100;
    progress.value = record.progress;
    progress.setAttribute("aria-label", `${record.fileName}: ${Math.round(record.progress)} percent`);
    if (record.status === "completed") progress.classList.add("is-complete");
    if (record.status === "error" || record.status === "cancelled") progress.classList.add("is-error");
    progressColumn.append(progressCopy, progress);
    const dots = buildSegmentDots(record);
    if (dots) progressColumn.append(dots);

    const transferColumn = createElement("td", "col-transfer");
    let transferValue = "—";
    let transferMeta = "Waiting";
    if (record.status === "downloading") {
      transferValue = record.speed > 0 ? formatSpeed(record.speed) : "Starting…";
      transferMeta = formatEta(record.eta);
    } else if (record.status === "probing") {
      transferValue = "Checking";
      transferMeta = "Reading file info";
    } else if (record.status === "completed") {
      transferValue = record.totalBytes > 0 ? formatBytes(record.totalBytes) : "Done";
      transferMeta = "Finished";
    } else if (record.status === "paused") {
      transferMeta = "On hold";
    } else if (record.status === "error") {
      transferMeta = needsBrowserRecovery(record) ? "Refresh link in Chrome" : "Retry available";
    } else if (record.status === "cancelled") {
      transferMeta = "Stopped";
    }
    const transferMain = createElement("span", "transfer-value", transferValue);
    if (record.status === "downloading") transferMain.classList.add("is-moving");
    transferColumn.append(transferMain, createElement("span", "transfer-meta", transferMeta));

    const statusColumn = createElement("td", "col-status");
    const badge = createElement("span", "status-badge", statusLabel(record.status));
    badge.dataset.status = record.status;
    statusColumn.append(badge);
    if (record.error) {
      const details = createElement("details", "status-error-details");
      const summary = createElement("summary", "status-error-summary");
      const toggleLabel = createElement("span", "status-error-toggle", "Details");
      summary.append(
        createElement("span", "status-error-label", conciseTransferError(record)),
        toggleLabel
      );
      details.addEventListener("toggle", () => {
        toggleLabel.textContent = details.open ? "Hide details" : "Details";
      });
      const fullMessage = createElement("div", "status-error-message", record.error);
      details.append(summary, fullMessage);
      statusColumn.append(details);
    }

    const actionsColumn = createElement("td", "col-actions");
    const actions = createElement("div", "row-actions");
    if (["queued", "probing", "downloading"].includes(record.status)) {
      actions.append(
        actionButton("Pause", "pause", record, "is-primary"),
        actionButton("Cancel", "cancel", record, "is-danger")
      );
    } else if (record.status === "paused") {
      actions.append(
        actionButton("Resume", "resume", record, "is-primary"),
        actionButton("Cancel", "cancel", record, "is-danger")
      );
    } else if (record.status === "completed") {
      actions.append(
        actionButton("Open", "open-file", record, "is-primary"),
        actionButton("Folder", "open-folder", record),
        actionButton("Remove", "remove", record, "is-danger")
      );
    } else {
      if (record.status === "error") {
        actions.append(needsBrowserRecovery(record)
          ? actionButton("Open in Chrome", "open-in-browser", record, "is-primary")
          : actionButton("Retry", "resume", record, "is-primary"));
      }
      if (record.destination) actions.append(actionButton("Folder", "open-folder", record));
      actions.append(actionButton("Remove", "remove", record, "is-danger"));
    }
    actionsColumn.append(actions);

    row.append(fileColumn, progressColumn, transferColumn, statusColumn, actionsColumn);
    return row;
  }

  function setEmptyState(visibleRecords) {
    const empty = visibleRecords.length === 0;
    elements.downloadTable.hidden = empty;
    elements.emptyState.hidden = !empty;
    if (!empty) return;

    const hasAny = state.downloads.length > 0;
    const hasSearch = Boolean(state.query.trim());
    elements.focusUrl.hidden = hasAny || hasSearch;
    if (hasSearch) {
      elements.emptyTitle.textContent = "No matching downloads";
      elements.emptyMessage.textContent = "Try another file name, website, or status.";
    } else if (state.filter === "completed" && hasAny) {
      elements.emptyTitle.textContent = "Nothing finished yet";
      elements.emptyMessage.textContent = "Completed downloads will collect here.";
    } else if (state.filter === "active" && hasAny) {
      elements.emptyTitle.textContent = "All caught up";
      elements.emptyMessage.textContent = "There are no active downloads right now.";
    } else if (hasAny) {
      elements.emptyTitle.textContent = "Nothing to show";
      elements.emptyMessage.textContent = "Change the current filter to see your downloads.";
    } else {
      elements.emptyTitle.textContent = "The runway is clear";
      elements.emptyMessage.textContent = "Paste a link above and Bunni will take it from there.";
    }
  }

  function updateSummary(visibleRecords) {
    const active = state.downloads.filter(hasDownloadWork);
    const downloading = state.downloads.filter((record) => record.status === "downloading");
    const completed = state.downloads.filter((record) => record.status === "completed");
    const computedSpeed = downloading.reduce((sum, record) => sum + record.speed, 0);
    const speed = state.statsSpeed === null ? computedSpeed : state.statsSpeed;

    elements.activeCount.textContent = String(active.length);
    elements.completedCount.textContent = String(completed.length);
    elements.allCount.textContent = String(state.downloads.length);
    elements.visibleCount.textContent = String(visibleRecords.length);
    elements.visibleCount.setAttribute("aria-label", `${visibleRecords.length} visible downloads`);
    elements.combinedSpeed.textContent = formatSpeed(speed);

    elements.engineSignal.classList.remove("is-idle", "is-error");
    if (!api) {
      elements.engineSignal.classList.add("is-error");
      elements.engineStatus.textContent = "Engine unavailable";
      elements.engineDetail.textContent = "Restart Bunni to reconnect";
    } else if (downloading.length > 0) {
      elements.engineStatus.textContent = `${downloading.length} ${downloading.length === 1 ? "download" : "downloads"} moving`;
      elements.engineDetail.textContent = formatSpeed(speed);
    } else {
      elements.engineSignal.classList.add("is-idle");
      elements.engineStatus.textContent = "Ready for links";
      elements.engineDetail.textContent = active.length ? `${active.length} waiting or paused` : "No active transfers";
    }
  }

  function render() {
    state.renderQueued = false;
    const visibleRecords = filterDownloads();
    const fragment = document.createDocumentFragment();
    visibleRecords.forEach((record) => fragment.append(buildRow(record)));
    elements.downloadRows.replaceChildren(fragment);
    setEmptyState(visibleRecords);
    updateSummary(visibleRecords);
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(render);
  }

  function rememberRemovedRecord(id) {
    const normalizedId = String(id ?? "");
    if (!normalizedId) return;
    state.removedRecordIds.delete(normalizedId);
    state.removedRecordIds.add(normalizedId);
    if (state.removedRecordIds.size > 1_000) {
      state.removedRecordIds.delete(state.removedRecordIds.values().next().value);
    }
  }

  function removeRecordLocally(id) {
    const normalizedId = String(id ?? "");
    if (!normalizedId) return;
    rememberRemovedRecord(normalizedId);
    state.downloads = state.downloads.filter((record) => record.id !== normalizedId);
    scheduleRender();
  }

  function upsertRecord(rawRecord) {
    const record = normalizeRecord(rawRecord);
    if (!record.id || state.removedRecordIds.has(record.id)) return;
    const index = state.downloads.findIndex((item) => item.id === record.id);
    if (index >= 0) state.downloads[index] = record;
    else state.downloads.unshift(record);
    scheduleRender();
  }

  function applyAuthoritativeDownloads(result, version) {
    if (version !== state.snapshotVersion) return false;

    const records = normalizeList(result);
    const nextIds = new Set(records.map((record) => record.id));
    state.downloads.forEach((record) => {
      if (!nextIds.has(record.id)) rememberRemovedRecord(record.id);
    });
    records.forEach((record) => state.removedRecordIds.delete(record.id));
    state.downloads = records;
    state.appliedSnapshotVersion = version;
    scheduleRender();
    return true;
  }

  function setPanelBusy(busy) {
    elements.downloadsPanel.setAttribute("aria-busy", String(busy));
  }

  async function loadDownloads({ quiet = false } = {}) {
    const version = ++state.snapshotVersion;
    if (!quiet) setPanelBusy(true);
    try {
      const result = await invoke("list");
      const applied = applyAuthoritativeDownloads(result, version);
      return applied || state.appliedSnapshotVersion > version;
    } catch (error) {
      if (!quiet) showToast("Could not load downloads", friendlyError(error), "error");
      updateSummary(filterDownloads());
      return false;
    } finally {
      if (!quiet) setPanelBusy(false);
    }
  }

  function scheduleRefresh(delay = 180) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = null;
      void loadDownloads({ quiet: true });
    }, delay);
  }

  function refreshDownloadsNow() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
    return loadDownloads({ quiet: true });
  }

  function handleChanged(payload) {
    if (Array.isArray(payload) || Array.isArray(payload?.downloads) || Array.isArray(payload?.items)) {
      const version = ++state.snapshotVersion;
      const records = normalizeList(payload);
      applyAuthoritativeDownloads(records, version);
      if (records.some((record) => record.status === "error")) scheduleRefresh();
      return;
    }

    const type = String(payload?.type ?? "").toLowerCase();
    const removedId = payload?.removedId ?? (type === "removed" ? payload?.id : null);
    if (removedId !== null && removedId !== undefined) {
      state.snapshotVersion += 1;
      removeRecordLocally(removedId);
      void refreshDownloadsNow();
      return;
    }

    const record = payload?.record ?? payload?.download ?? payload?.item ?? payload;
    if (record && typeof record === "object" && record.id !== undefined && (record.status || record.url || record.fileName)) {
      // A single-record event can arrive after a remove. Only a fresh full list
      // can prove that it still belongs in the manager.
      void refreshDownloadsNow();
      return;
    }
    scheduleRefresh();
  }

  function handleStats(stats) {
    const candidate = stats?.totalSpeed ?? stats?.combinedSpeed ?? stats?.aggregateSpeed ?? stats?.speed;
    if (candidate !== undefined && candidate !== null) {
      state.statsSpeed = Math.max(0, asNumber(candidate));
      updateSummary(filterDownloads());
    }
  }

  function normalizeUrl(value) {
    let candidate = value.trim();
    if (!candidate) throw new Error("Paste a download URL first.");
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("That does not look like a valid download URL.");
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error("Bunni accepts HTTP and HTTPS download links.");
    }
    return parsed.href;
  }

  function setAddBusy(busy) {
    elements.addButton.disabled = busy;
    elements.urlInput.disabled = busy;
    elements.addButton.querySelector("span:first-child").textContent = busy ? "Adding…" : "Add download";
  }

  async function addDownload(event) {
    event.preventDefault();
    elements.urlMessage.textContent = "";
    elements.urlComposer.classList.remove("is-invalid");

    let url;
    try {
      url = normalizeUrl(elements.urlInput.value);
    } catch (error) {
      elements.urlMessage.textContent = friendlyError(error);
      elements.urlComposer.classList.add("is-invalid");
      elements.urlInput.focus();
      return;
    }

    const segments = elements.segmentsEnabled.checked
      ? clamp(Math.round(asNumber(elements.segmentCount.value, state.settings.defaultSegments)), 1, 32)
      : 1;
    const input = { url, segments };
    if (state.destination) input.directory = state.destination;

    setAddBusy(true);
    try {
      const result = await invoke("add", input);
      const rawRecord = result && typeof result === "object"
        ? result.record ?? result.download ?? result
        : null;
      const record = rawRecord ? normalizeRecord(rawRecord) : null;
      if (record) upsertRecord(record);

      if (record?.status === "error") {
        const message = record.error || "Bunni could not start this download.";
        elements.urlMessage.textContent = message;
        elements.urlComposer.classList.add("is-invalid");
        if (needsBrowserRecovery(record)) {
          showToast(
            "This link needs Chrome",
            "Use Open in Chrome on the failed row, then click the website download button so the extension can pass your browser session to Bunni.",
            "error"
          );
        } else {
          showToast("Download could not start", message, "error");
        }
        scheduleRefresh();
        return;
      }

      elements.urlInput.value = "";
      showToast("Added to the queue", getFileName(url), "success");
      scheduleRefresh();
      elements.urlInput.focus();
    } catch (error) {
      elements.urlMessage.textContent = friendlyError(error);
      elements.urlComposer.classList.add("is-invalid");
      showToast("Could not add download", friendlyError(error), "error");
    } finally {
      setAddBusy(false);
    }
  }

  async function chooseDirectory(target) {
    try {
      const result = await invoke("chooseDownloadDirectory");
      const directory = extractPath(result);
      if (!directory) return;
      if (target === "settings") {
        elements.settingsDirectory.value = directory;
      } else if (target === "capture") {
        elements.captureDirectory.value = directory;
        state.captureDirectoryEdited = true;
      } else {
        state.destination = directory;
        updateDestinationDisplay();
      }
    } catch (error) {
      showToast("Could not choose a folder", friendlyError(error), "error");
    }
  }

  function updateDestinationDisplay() {
    const directory = state.destination || state.settings.downloadDirectory;
    elements.destinationPath.textContent = state.destination
      ? directory
      : directory || "Default download folder";
    elements.destinationPath.title = directory || "Use the default download folder";
    elements.footerDirectory.textContent = directory
      ? `Saving to ${directory}`
      : "Saving to your default download folder";
  }

  function friendlyError(error) {
    if (typeof error === "string") return error;
    return error?.message || "Something unexpected happened. Please try again.";
  }

  function showToast(title, message, type = "success") {
    const toast = createElement("div", `toast ${type === "error" ? "is-error" : ""}`.trim());
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    const icon = createElement("span", "toast-icon", type === "error" ? "!" : "✓");
    icon.setAttribute("aria-hidden", "true");
    const copy = createElement("span", "toast-copy");
    copy.append(createElement("strong", "", title), createElement("span", "", message));
    const close = createElement("button", "toast-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Dismiss notification");
    close.addEventListener("click", () => toast.remove());
    toast.append(icon, copy, close);
    elements.toastRegion.append(toast);
    window.setTimeout(() => toast.remove(), type === "error" ? 6500 : 4000);
  }

  function openDialog(dialog) {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog(dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function setCaptureBusy(value, action = "start") {
    state.captureBusy = value;
    elements.captureForm.setAttribute("aria-busy", String(value));
    elements.captureStart.disabled = value;
    elements.captureLater.disabled = value;
    elements.captureCancel.disabled = value;
    elements.captureClose.disabled = value;
    elements.captureBrowse.disabled = value;
    elements.captureFileName.disabled = value;
    elements.captureCategory.disabled = value;
    elements.captureRememberFolder.disabled = value;
    elements.captureStart.textContent = value && action === "start" ? "Starting…" : "Start download";
    elements.captureLater.textContent = value && action === "later" ? "Saving…" : "Later";
    elements.captureCancel.textContent = value && action === "cancel" ? "Cancelling…" : "Cancel";
  }

  function updateCaptureFileDetails() {
    elements.captureFileIcon.textContent = extensionOf(elements.captureFileName.value);
    if (elements.captureCategory.dataset.edited === "true") return;

    const category = categoryForFile(elements.captureFileName.value);
    if (category !== elements.captureCategory.value) {
      applyCaptureCategory(category, { updateDirectory: !state.captureDirectoryEdited });
    }
  }

  function showNextCapture() {
    if (state.activeCapture || state.captureQueue.length === 0) return;
    if (elements.settingsDialog.open || elements.confirmDialog.open || elements.captureDialog.open) return;

    const capture = state.captureQueue.shift();
    if (!capture || capture.state !== "pending") {
      window.queueMicrotask(showNextCapture);
      return;
    }
    state.activeCapture = capture;
    const record = capture.download;
    const destination = splitDestination(record.destination, record.fileName);
    const category = categoryForFile(record.fileName);
    state.captureBaseDirectory = destination.directory || state.settings.downloadDirectory;
    state.captureDirectoryEdited = false;

    elements.captureUrl.value = record.url;
    elements.captureUrl.title = record.url;
    elements.captureCategory.dataset.edited = "false";
    elements.captureFileName.value = record.fileName;
    applyCaptureCategory(category);
    elements.captureFileSize.textContent = record.totalBytes === null
      ? "Unknown size"
      : formatBytes(record.totalBytes);
    elements.captureRememberFolder.checked = false;
    elements.captureMessage.textContent = "";
    updateCaptureFileDetails();
    setCaptureBusy(false);
    openDialog(elements.captureDialog);
    window.setTimeout(() => {
      elements.captureFileName.focus();
      elements.captureFileName.select();
    }, 0);
  }

  function handleCaptureRequested(payload) {
    const capture = normalizeCapture(payload);
    if (!capture || capture.state !== "pending") return;
    if (state.activeCapture?.id === capture.id) return;
    if (state.captureQueue.some((item) => item.id === capture.id)) return;
    state.captureQueue.push(capture);
    // The broker's list is the source of truth. Rendering the event payload
    // here used to resurrect captures that had already failed and been removed.
    void refreshDownloadsNow();
    showNextCapture();
  }

  async function respondToCapture(action) {
    const capture = state.activeCapture;
    if (!capture || state.captureBusy) return;

    const fileName = elements.captureFileName.value.trim();
    const directory = elements.captureDirectory.value.trim();
    if (action !== "cancel") {
      if (!fileName) {
        elements.captureMessage.textContent = "Enter a file name.";
        elements.captureFileName.focus();
        return;
      }
      if (!directory) {
        elements.captureMessage.textContent = "Choose a destination folder.";
        return;
      }
    }

    elements.captureMessage.textContent = "";
    setCaptureBusy(true, action);
    try {
      const request = { id: capture.id, action };
      if (action !== "cancel") {
        request.fileName = fileName;
        request.directory = directory;
      }
      const result = await invoke("respondToCapture", request);
      const updatedCapture = normalizeCapture(result);
      if (!updatedCapture) {
        throw new Error("Bunni did not confirm the browser download. Please try again.");
      }
      const finalState = updatedCapture.state;
      if (finalState === "pending") {
        throw new Error("The browser download is still waiting for a response. Please try again.");
      }

      const accepted = finalState === "accepted" || finalState === "accepted-paused";
      const rejected = finalState === "rejected";
      const failed = finalState === "error";
      if (!accepted && !rejected && !failed) {
        throw new Error("Bunni returned an unknown browser download state.");
      }

      const shouldRemember = accepted && elements.captureRememberFolder.checked;
      const rememberedFolder = !shouldRemember
        || rememberCategoryFolder(elements.captureCategory.value, directory);

      closeDialog(elements.captureDialog);
      state.activeCapture = null;
      state.captureBaseDirectory = "";
      state.captureDirectoryEdited = false;
      setCaptureBusy(false);

      if (finalState === "accepted") {
        showToast("Download started", fileName);
      } else if (finalState === "accepted-paused") {
        showToast("Saved for later", `${fileName} is paused in your queue.`);
      } else if (failed) {
        const message = updatedCapture.download.error
          || "The browser download could not be prepared. Chrome will keep the original when available.";
        showToast("Download could not start", message, "error");
      } else if (action === "cancel") {
        showToast("Download cancelled", "Chrome will keep the original download when available.");
      } else {
        showToast(
          "Browser download expired",
          "It was no longer waiting for a response, so Chrome will keep the original when available.",
          "error"
        );
      }
      if (!rememberedFolder) {
        showToast("Folder preference was not saved", "This download will still use the folder you chose.", "error");
      }

      if (accepted) {
        upsertRecord(updatedCapture.download);
      } else {
        removeRecordLocally(capture.id);
      }
      void refreshDownloadsNow();
      window.queueMicrotask(showNextCapture);
    } catch (error) {
      const message = friendlyError(error);

      // A failed capture transition removes its prepared manager record in the
      // main process. Clear it optimistically, then reconcile before deciding
      // whether this dialog can still be retried.
      removeRecordLocally(capture.id);
      const refreshed = await refreshDownloadsNow();
      const stillExists = state.downloads.some((record) => record.id === capture.id);
      if (refreshed && !stillExists) {
        closeDialog(elements.captureDialog);
        if (state.activeCapture?.id === capture.id) state.activeCapture = null;
        state.captureBaseDirectory = "";
        state.captureDirectoryEdited = false;
        setCaptureBusy(false);
        showToast(
          action === "cancel" ? "Download cancelled" : "Download could not start",
          message,
          action === "cancel" ? "success" : "error"
        );
        window.queueMicrotask(showNextCapture);
      } else {
        elements.captureMessage.textContent = message;
        setCaptureBusy(false);
      }
    }
  }

  function askForConfirmation({ title, message, acceptLabel, allowDeleteFile = false }) {
    if (state.confirmResolver) state.confirmResolver({ confirmed: false, deleteFile: false });
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmAccept.textContent = acceptLabel;
    elements.deleteFileOption.hidden = !allowDeleteFile;
    elements.deleteFileCheckbox.checked = false;
    openDialog(elements.confirmDialog);
    return new Promise((resolve) => {
      state.confirmResolver = resolve;
    });
  }

  function resolveConfirmation(confirmed) {
    if (!state.confirmResolver) return;
    const resolve = state.confirmResolver;
    state.confirmResolver = null;
    const deleteFile = confirmed && !elements.deleteFileOption.hidden && elements.deleteFileCheckbox.checked;
    closeDialog(elements.confirmDialog);
    resolve({ confirmed, deleteFile });
  }

  async function performRowAction(action, id) {
    const record = state.downloads.find((item) => item.id === id);
    if (!record || state.busyIds.has(id)) return;

    if (action === "cancel") {
      const answer = await askForConfirmation({
        title: "Cancel this download?",
        message: `${record.fileName} will stop downloading. You can remove it from the queue afterward.`,
        acceptLabel: "Cancel download"
      });
      if (!answer.confirmed) return;
    }

    let deleteFile = false;
    if (action === "remove") {
      const answer = await askForConfirmation({
        title: "Remove from Bunni?",
        message: `${record.fileName} will disappear from your download history.`,
        acceptLabel: "Remove",
        allowDeleteFile: record.status === "completed"
      });
      if (!answer.confirmed) return;
      deleteFile = answer.deleteFile;
    }

    state.busyIds.add(id);
    scheduleRender();
    try {
      if (action === "pause") await invoke("pause", id);
      if (action === "resume") await invoke("resume", id);
      if (action === "cancel") await invoke("cancel", id);
      if (action === "remove") await invoke("remove", id, deleteFile);
      if (action === "open-file") await invoke("openFile", id);
      if (action === "open-folder") await invoke("openFolder", id);
      if (action === "open-in-browser") await invoke("openInBrowser", id);

      if (action === "remove") {
        state.downloads = state.downloads.filter((item) => item.id !== id);
        showToast("Removed from the list", deleteFile ? "The downloaded file was deleted too." : record.fileName);
      } else if (action === "cancel") {
        showToast("Download cancelled", record.fileName);
      } else if (action === "pause") {
        showToast("Download paused", record.fileName);
      } else if (action === "resume") {
        showToast("Download resumed", record.fileName);
      } else if (action === "open-in-browser") {
        showToast(
          "Opened in Chrome",
          "Click the download there; the Bunni extension should recapture it."
        );
      }
      scheduleRefresh();
    } catch (error) {
      showToast(`Could not ${action.replace("-", " ")}`, friendlyError(error), "error");
    } finally {
      state.busyIds.delete(id);
      scheduleRender();
    }
  }

  function settingsFromResult(result) {
    const source = result && typeof result === "object" ? result : {};
    return {
      defaultSegments: clamp(Math.round(asNumber(source.defaultSegments, state.settings.defaultSegments)), 1, 32),
      maxConcurrent: clamp(Math.round(asNumber(source.maxConcurrent, state.settings.maxConcurrent)), 1, 10),
      downloadDirectory: String(source.downloadDirectory ?? source.downloadDir ?? state.settings.downloadDirectory ?? ""),
      serverPort: clamp(
        Math.round(asNumber(source.serverPort ?? source.extensionServerPort ?? source.extensionPort, state.settings.serverPort)),
        1024,
        65535
      ),
      notifyOnComplete: typeof source.notifyOnComplete === "boolean"
        ? source.notifyOnComplete
        : state.settings.notifyOnComplete
    };
  }

  function populateSettingsForm() {
    elements.defaultSegments.value = String(state.settings.defaultSegments);
    elements.maxConcurrent.value = String(state.settings.maxConcurrent);
    elements.settingsDirectory.value = state.settings.downloadDirectory;
    elements.extensionPort.value = String(state.settings.serverPort);
    elements.notifyOnComplete.checked = state.settings.notifyOnComplete;
    elements.settingsMessage.textContent = "";
  }

  async function loadSettings({ quiet = true } = {}) {
    try {
      const result = await invoke("getSettings");
      state.settings = settingsFromResult(result);
      if (!elements.segmentCount.dataset.edited) {
        elements.segmentCount.value = String(state.settings.defaultSegments);
      }
      updateDestinationDisplay();
      return true;
    } catch (error) {
      if (!quiet) showToast("Could not load settings", friendlyError(error), "error");
      updateDestinationDisplay();
      return false;
    }
  }

  async function openSettingsDialog() {
    await loadSettings({ quiet: true });
    populateSettingsForm();
    openDialog(elements.settingsDialog);
    window.setTimeout(() => elements.defaultSegments.focus(), 0);
  }

  async function saveSettings(event) {
    event.preventDefault();
    elements.settingsMessage.textContent = "";
    if (!elements.settingsForm.checkValidity()) {
      elements.settingsForm.reportValidity();
      return;
    }

    const patch = {
      defaultSegments: clamp(Math.round(asNumber(elements.defaultSegments.value, 8)), 1, 32),
      maxConcurrent: clamp(Math.round(asNumber(elements.maxConcurrent.value, 3)), 1, 10),
      downloadDirectory: elements.settingsDirectory.value.trim(),
      serverPort: clamp(Math.round(asNumber(elements.extensionPort.value, 17865)), 1024, 65535),
      notifyOnComplete: elements.notifyOnComplete.checked
    };

    elements.saveSettings.disabled = true;
    elements.saveSettings.textContent = "Saving…";
    try {
      const result = await invoke("updateSettings", patch);
      state.settings = settingsFromResult(result && typeof result === "object" ? result : patch);
      if (!elements.segmentCount.dataset.edited) {
        elements.segmentCount.value = String(state.settings.defaultSegments);
      }
      updateDestinationDisplay();
      closeDialog(elements.settingsDialog);
      showToast("Settings saved", "New downloads will use your updated preferences.");
    } catch (error) {
      elements.settingsMessage.textContent = friendlyError(error);
    } finally {
      elements.saveSettings.disabled = false;
      elements.saveSettings.textContent = "Save changes";
    }
  }

  function bindEvents() {
    elements.addForm.addEventListener("submit", addDownload);
    elements.urlInput.addEventListener("input", () => {
      elements.urlMessage.textContent = "";
      elements.urlComposer.classList.remove("is-invalid");
    });
    elements.segmentsEnabled.addEventListener("change", () => {
      elements.segmentCount.disabled = !elements.segmentsEnabled.checked;
    });
    elements.segmentCount.addEventListener("input", () => {
      elements.segmentCount.dataset.edited = "true";
    });
    elements.chooseDestination.addEventListener("click", () => chooseDirectory("quick-add"));
    elements.chooseSettingsDirectory.addEventListener("click", () => chooseDirectory("settings"));
    elements.focusUrl.addEventListener("click", () => {
      elements.urlInput.scrollIntoView({ behavior: "smooth", block: "center" });
      elements.urlInput.focus();
    });

    document.querySelectorAll(".filter-tab").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        document.querySelectorAll(".filter-tab").forEach((tab) => {
          const selected = tab === button;
          tab.classList.toggle("is-active", selected);
          tab.setAttribute("aria-pressed", String(selected));
        });
        scheduleRender();
      });
    });

    elements.searchInput.addEventListener("input", () => {
      state.query = elements.searchInput.value;
      scheduleRender();
    });

    elements.downloadRows.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      performRowAction(button.dataset.action, button.dataset.id);
    });

    elements.openSettings.addEventListener("click", openSettingsDialog);
    elements.closeSettings.addEventListener("click", () => closeDialog(elements.settingsDialog));
    elements.cancelSettings.addEventListener("click", () => closeDialog(elements.settingsDialog));
    elements.settingsForm.addEventListener("submit", saveSettings);
    elements.settingsDialog.addEventListener("close", () => window.queueMicrotask(showNextCapture));

    elements.captureForm.addEventListener("submit", (event) => {
      event.preventDefault();
      respondToCapture("start");
    });
    elements.captureLater.addEventListener("click", () => respondToCapture("later"));
    elements.captureCancel.addEventListener("click", () => respondToCapture("cancel"));
    elements.captureClose.addEventListener("click", () => respondToCapture("cancel"));
    elements.captureBrowse.addEventListener("click", () => chooseDirectory("capture"));
    elements.captureFileName.addEventListener("input", updateCaptureFileDetails);
    elements.captureCategory.addEventListener("change", () => {
      elements.captureCategory.dataset.edited = "true";
      applyCaptureCategory(elements.captureCategory.value);
    });
    elements.captureDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      respondToCapture("cancel");
    });

    elements.confirmCancel.addEventListener("click", () => resolveConfirmation(false));
    elements.confirmAccept.addEventListener("click", () => resolveConfirmation(true));
    elements.confirmDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      resolveConfirmation(false);
    });
    elements.confirmDialog.addEventListener("close", () => {
      if (state.confirmResolver) {
        const resolve = state.confirmResolver;
        state.confirmResolver = null;
        resolve({ confirmed: false, deleteFile: false });
      }
      window.queueMicrotask(showNextCapture);
    });

    const extensionFolderMethod = ["openExtensionFolder", "openChromeExtensionFolder"]
      .find((method) => api && typeof api[method] === "function");
    if (extensionFolderMethod) {
      elements.openExtensionFolder.hidden = false;
      elements.openExtensionFolder.addEventListener("click", async () => {
        try {
          await invoke(extensionFolderMethod);
        } catch (error) {
          showToast("Could not open extension folder", friendlyError(error), "error");
        }
      });
    }
  }

  function subscribe() {
    if (!api) return;
    try {
      if (typeof api.onChanged === "function") {
        const unsubscribe = api.onChanged(handleChanged);
        if (typeof unsubscribe === "function") state.unsubscribers.push(unsubscribe);
      }
      if (typeof api.onStats === "function") {
        const unsubscribe = api.onStats(handleStats);
        if (typeof unsubscribe === "function") state.unsubscribers.push(unsubscribe);
      }
      if (typeof api.onCommand === "function") {
        const unsubscribe = api.onCommand((command) => {
          if (command !== "add") return;
          elements.urlInput.scrollIntoView({ behavior: "smooth", block: "center" });
          elements.urlInput.focus();
        });
        if (typeof unsubscribe === "function") state.unsubscribers.push(unsubscribe);
      }
      if (typeof api.onCaptureRequested === "function") {
        const unsubscribe = api.onCaptureRequested(handleCaptureRequested);
        if (typeof unsubscribe === "function") state.unsubscribers.push(unsubscribe);
      }
    } catch (error) {
      showToast("Live updates are unavailable", friendlyError(error), "error");
    }
  }

  async function initialize() {
    bindEvents();
    subscribe();
    render();
    await Promise.all([
      loadDownloads(),
      loadSettings({ quiet: true })
    ]);
  }

  window.addEventListener("beforeunload", () => {
    window.clearTimeout(state.refreshTimer);
    state.unsubscribers.forEach((unsubscribe) => {
      try {
        unsubscribe();
      } catch {
        // The app is already closing; there is nothing left to clean up.
      }
    });
  });

  initialize();
})();
