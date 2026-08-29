const CLIENT_HEADER = "chrome-extension";
const REQUEST_TIMEOUT_MS = 10_000;
const CAPTURE_POLL_INTERVAL_MS = 1_500;
const CAPTURE_STATUS_RETRY_BASE_MS = 2_000;
const MAX_CAPTURE_STATUS_RETRIES = 3;
const PENDING_CAPTURE_TIMEOUT_MS = 5 * 60_000;
const RECOVERY_RETRY_MS = 15_000;
const PENDING_INTERCEPTIONS_KEY = "pendingInterceptions";
const PENDING_CAPTURE_ALARM = "bunni-pending-captures";
const GOFILE_PERMISSION = Object.freeze({
  permissions: ["cookies"],
  origins: ["https://gofile.io/*", "https://*.gofile.io/*"],
});
const GOFILE_ERROR_CODE = "GOFILE_CREDENTIALS_REQUIRED";
const DEFAULT_SETTINGS = Object.freeze({
  autoIntercept: true,
  port: 17_865,
  segments: 8,
});

const MENU_IDS = Object.freeze({
  link: "bunni-download-link",
  page: "bunni-download-page",
  video: "bunni-download-video",
  audio: "bunni-download-audio",
  image: "bunni-download-image",
});

const HTTP_PATTERNS = ["http://*/*", "https://*/*"];
const CAPTURE_STATES = new Set(["pending", "accepted", "accepted-paused", "rejected", "error"]);
const ACCEPTED_STATES = new Set(["accepted", "accepted-paused"]);
const REJECTED_STATES = new Set(["rejected", "error"]);
const interceptionInFlight = new Set();
const pendingProcessing = new Set();
const recentInterceptions = new Map();
const RECURSION_GUARD_MS = 4_000;
let pendingInterceptionMutation = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  initializeSettings().catch(console.error);
  rebuildContextMenus().catch(console.error);
  recoverPendingInterceptions().catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  initializeSettings().catch(console.error);
  rebuildContextMenus().catch(console.error);
  recoverPendingInterceptions().catch(console.error);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab).catch((error) => {
    console.error("Bunni context-menu error", errorMessage(error));
  });
});

chrome.downloads.onCreated.addListener((item) => {
  interceptBrowserDownload(item).catch((error) => {
    console.error("Bunni interception error", errorMessage(error));
  });
});

if (chrome.alarms?.onAlarm?.addListener) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== PENDING_CAPTURE_ALARM) return;
    recoverPendingInterceptions().catch((error) => {
      console.error("Bunni capture recovery error", errorMessage(error));
    });
  });
}

if (chrome.storage?.onChanged?.addListener) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !Object.hasOwn(changes, "autoIntercept")) return;
    updateActionState(Boolean(changes.autoIntercept?.newValue)).catch((error) => {
      console.warn("Bunni could not update its toolbar badge", errorMessage(error));
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return undefined;
  }

  if (message.type === "GET_HEALTH") {
    checkHealth()
      .then(sendResponse)
      .catch((error) => sendResponse(failure(error)));
    return true;
  }

  // START_DOWNLOAD remains accepted for compatibility with an older popup, but
  // both messages create a confirmation capture rather than starting immediately.
  if (message.type === "CREATE_CAPTURE" || message.type === "START_DOWNLOAD") {
    submitCaptureWithNotification(message.url, {
      source: normalizeSource(message.source),
      referrer: message.referrer,
      filename: message.filename,
      incognito: Boolean(message.incognito || sender?.tab?.incognito),
    })
      .then(sendResponse)
      .catch((error) => sendResponse(failure(error)));
    return true;
  }

  return undefined;
});

// A service worker may be stopped at any point in a handoff. The record written
// before Chrome is paused lets a later worker either continue polling the desktop
// decision or restore Chrome's original download.
recoverPendingInterceptions().catch((error) => {
  console.error("Bunni could not recover pending Chrome downloads", errorMessage(error));
});
syncActionState().catch((error) => {
  console.warn("Bunni could not initialize its toolbar badge", errorMessage(error));
});

async function initializeSettings() {
  const current = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const normalized = {
    autoIntercept: Boolean(current.autoIntercept),
    port: clampPort(current.port),
    segments: clampSegments(current.segments),
  };
  await chrome.storage.local.set(normalized);
  await updateActionState(normalized.autoIntercept);
}

async function syncActionState() {
  const settings = await chrome.storage.local.get({ autoIntercept: DEFAULT_SETTINGS.autoIntercept });
  await updateActionState(Boolean(settings.autoIntercept));
}

async function updateActionState(enabled) {
  if (!chrome.action) return;
  const title = enabled
    ? "Bunni — automatic capture ON"
    : "Bunni — automatic capture OFF";
  const operations = [];
  if (typeof chrome.action.setBadgeText === "function") {
    operations.push(chrome.action.setBadgeText({ text: enabled ? "ON" : "OFF" }));
  }
  if (typeof chrome.action.setBadgeBackgroundColor === "function") {
    operations.push(chrome.action.setBadgeBackgroundColor({ color: enabled ? "#287d67" : "#b33f4a" }));
  }
  if (typeof chrome.action.setBadgeTextColor === "function") {
    operations.push(chrome.action.setBadgeTextColor({ color: "#ffffff" }));
  }
  if (typeof chrome.action.setTitle === "function") {
    operations.push(chrome.action.setTitle({ title }));
  }
  await Promise.all(operations);
}

async function rebuildContextMenus() {
  await chrome.contextMenus.removeAll();

  chrome.contextMenus.create({
    id: MENU_IDS.link,
    title: "Download link with Bunni",
    contexts: ["link"],
    targetUrlPatterns: HTTP_PATTERNS,
  });
  chrome.contextMenus.create({
    id: MENU_IDS.page,
    title: "Download this page with Bunni",
    contexts: ["page"],
    documentUrlPatterns: HTTP_PATTERNS,
  });
  chrome.contextMenus.create({
    id: MENU_IDS.video,
    title: "Download video with Bunni",
    contexts: ["video"],
    targetUrlPatterns: HTTP_PATTERNS,
  });
  chrome.contextMenus.create({
    id: MENU_IDS.audio,
    title: "Download audio with Bunni",
    contexts: ["audio"],
    targetUrlPatterns: HTTP_PATTERNS,
  });
  chrome.contextMenus.create({
    id: MENU_IDS.image,
    title: "Download image with Bunni",
    contexts: ["image"],
    targetUrlPatterns: HTTP_PATTERNS,
  });
}

async function handleContextMenuClick(info, tab) {
  const selectedUrl = selectContextUrl(info, tab);
  await submitCaptureWithNotification(selectedUrl, {
    source: `context-menu:${info.menuItemId}`,
    referrer: tab?.url,
    incognito: Boolean(tab?.incognito),
  });
}

function selectContextUrl(info, tab) {
  switch (info.menuItemId) {
    case MENU_IDS.link:
      return info.linkUrl;
    case MENU_IDS.video:
    case MENU_IDS.audio:
    case MENU_IDS.image:
      return info.srcUrl;
    case MENU_IDS.page:
      return info.pageUrl || tab?.url;
    default:
      throw new Error("That Bunni menu action is not supported.");
  }
}

async function checkHealth() {
  const settings = await getSettings();
  const port = settings.port;
  const startedAt = performance.now();
  const response = await fetchWithTimeout(`${serviceOrigin(port)}/api/health`, {
    method: "GET",
    cache: "no-store",
    headers: { "X-Bunni-Client": CLIENT_HEADER },
  }, 3_000);

  if (!response.ok) {
    throw new Error(`Bunni app returned HTTP ${response.status}.`);
  }

  const data = await readResponseBody(response);
  if (
    !data ||
    typeof data !== "object" ||
    data.ok !== true ||
    data.name !== "Bunni Download Manager" ||
    data.port !== port
  ) {
    throw new Error(`Port ${port} answered, but it was not the Bunni desktop app.`);
  }
  return {
    ok: true,
    latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
    port,
    service: data,
  };
}

async function submitCaptureWithNotification(rawUrl, context = {}) {
  try {
    const result = await createCapture(rawUrl, context);
    await showNotification(
      "Review this download in Bunni",
      `${friendlyUrl(result.url)} is waiting for Start, Later, or Cancel in the Bunni app.`,
      "success",
    );
    return result;
  } catch (error) {
    await showNotification(
      "Bunni could not show the download",
      errorMessage(error),
      "error",
    );
    return failure(error);
  }
}

async function createCapture(rawUrl, context = {}) {
  const url = normalizeHttpUrl(rawUrl);
  const settings = await getSettings();
  const payload = {
    url,
    // GoFile rate-limits concurrent byte ranges aggressively. One connection is
    // more reliable there; the user's configured part count still applies to
    // every other host.
    segments: isGoFileUrl(url) ? 1 : settings.segments,
    source: normalizeSource(context.source),
  };

  const referrer = optionalHttpUrl(context.referrer);
  const filename = safeFilename(context.filename);
  if (referrer) payload.referrer = referrer;
  if (filename) payload.filename = filename;

  const credentialHeaders = await goFileCredentialHeaders(url, context);
  if (credentialHeaders) payload.headers = credentialHeaders;

  const response = await fetchWithTimeout(`${serviceOrigin(settings.port)}/api/captures`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Bunni-Client": CLIENT_HEADER,
    },
    body: JSON.stringify(payload),
  }, REQUEST_TIMEOUT_MS);

  const body = await readResponseBody(response);
  if (!response.ok) {
    // A credential-bearing request must never let a reflected server message put
    // cookie material into a Chrome notification or popup response.
    const detail = credentialHeaders ? "" : extractServerMessage(body);
    throw new Error(detail || `Bunni app returned HTTP ${response.status}.`);
  }

  const capture = captureFromEnvelope(body);
  if (REJECTED_STATES.has(capture.state)) {
    throw new Error("Bunni could not prepare that download.");
  }

  return {
    ok: true,
    url,
    capture: publicCaptureRecord(capture),
  };
}

async function getCapture(captureId, port) {
  const response = await fetchWithTimeout(
    `${serviceOrigin(port)}/api/captures/${encodeURIComponent(captureId)}`,
    {
      method: "GET",
      cache: "no-store",
      headers: { "X-Bunni-Client": CLIENT_HEADER },
    },
    REQUEST_TIMEOUT_MS,
  );
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(extractServerMessage(body) || `Bunni app returned HTTP ${response.status}.`);
  }
  return captureFromEnvelope(body);
}

async function deleteCapture(captureId, port) {
  const response = await fetchWithTimeout(
    `${serviceOrigin(port)}/api/captures/${encodeURIComponent(captureId)}`,
    {
      method: "DELETE",
      cache: "no-store",
      headers: { "X-Bunni-Client": CLIENT_HEADER },
    },
    REQUEST_TIMEOUT_MS,
  );
  const body = await readResponseBody(response);
  if (body && typeof body === "object" && body.capture) {
    try {
      return captureFromEnvelope(body);
    } catch {
      // Fall through to the ordinary HTTP error below.
    }
  }
  if (!response.ok) {
    throw new Error(extractServerMessage(body) || `Bunni app returned HTTP ${response.status}.`);
  }
  return null;
}

function captureFromEnvelope(body) {
  const capture = body && typeof body === "object" ? body.capture : null;
  if (
    !capture ||
    typeof capture !== "object" ||
    typeof capture.id !== "string" ||
    !capture.id ||
    capture.id.length > 200 ||
    !CAPTURE_STATES.has(capture.state)
  ) {
    throw new Error("The desktop app returned an unexpected capture response.");
  }
  return capture;
}

async function interceptBrowserDownload(item) {
  const settings = await getSettings();
  if (!settings.autoIntercept) return;

  if (item.byExtensionId === chrome.runtime.id) return;
  if (!Number.isInteger(item.id) || interceptionInFlight.has(item.id)) return;

  let url;
  try {
    url = normalizeHttpUrl(item.finalUrl || item.url);
  } catch {
    return;
  }

  clearExpiredInterceptionGuards();
  const guardKey = `${url}\n${safeFilename(item.filename) || ""}`;
  if ((recentInterceptions.get(guardKey) || 0) > Date.now()) return;

  interceptionInFlight.add(item.id);
  recentInterceptions.set(guardKey, Date.now() + RECURSION_GUARD_MS);
  let captureId = "";
  const now = Date.now();
  const pendingRecord = {
    downloadId: item.id,
    captureId: "",
    createdAt: now,
    deadlineAt: now + PENDING_CAPTURE_TIMEOUT_MS,
    nextPollAt: now,
    pollFailures: 0,
    resolution: "resume",
    label: safeFilename(item.filename) || "Chrome download",
    port: settings.port,
  };

  try {
    // Persist first. If MV3 stops after pause but before the capture ID arrives,
    // recovery sees resolution=resume and restores Chrome.
    await rememberPendingInterception(pendingRecord);
    await chrome.downloads.pause(item.id);
    const [current] = await chrome.downloads.search({ id: item.id });
    if (current?.state !== "in_progress" || current.paused !== true) {
      await resumePendingInterception(item.id);
      await showNotification(
        "Chrome kept this download",
        "Bunni could not safely pause the original, so no confirmation was opened.",
        "error",
      );
      return;
    }

    const result = await createCapture(url, {
      source: "chrome-download-intercept",
      referrer: item.referrer,
      filename: item.filename,
      incognito: Boolean(item.incognito),
    });
    captureId = result.capture.id;
    await updatePendingInterception(item.id, {
      captureId,
      resolution: result.capture.state === "pending" ? "awaiting" : "resume",
      nextPollAt: Date.now() + CAPTURE_POLL_INTERVAL_MS,
      pollFailures: 0,
    });

    if (result.capture.state === "pending") {
      await showNotification(
        "Choose in the Bunni app",
        `${pendingRecord.label} is paused in Chrome while Bunni waits for Start, Later, or Cancel.`,
        "success",
      );
      await schedulePendingAlarm();
      // Fast polling gives a responsive dialog while the alarm/storage record is
      // the durable fallback if Chrome suspends this worker.
      monitorPendingCapture(item.id).catch((error) => {
        console.warn("Bunni capture monitor stopped", errorMessage(error));
      });
      return;
    }

    await applyCaptureDecision(item.id, result.capture);
  } catch (error) {
    if (captureId) {
      await rejectCaptureBestEffort(captureId, settings.port);
    }
    const resumed = await resumePendingInterception(item.id);
    const goFileError = error?.code === GOFILE_ERROR_CODE;
    await showNotification(
      goFileError ? "Chrome kept this GoFile download" : "Bunni is unavailable",
      resumed
        ? `Chrome resumed the original. ${errorMessage(error)}`
        : `Chrome's copy still needs attention in Downloads. ${errorMessage(error)}`,
      "error",
    );
  } finally {
    interceptionInFlight.delete(item.id);
  }
}

async function monitorPendingCapture(downloadId) {
  while (true) {
    const record = await getPendingInterception(downloadId);
    if (!record || record.resolution !== "awaiting") return;
    const waitMs = Math.max(0, Math.min(record.nextPollAt, record.deadlineAt) - Date.now());
    if (waitMs > 0) await delay(waitMs);
    const stillPending = await pollPendingInterception(downloadId);
    if (!stillPending) return;
  }
}

async function pollPendingInterception(downloadId) {
  if (pendingProcessing.has(downloadId)) return true;
  pendingProcessing.add(downloadId);
  try {
    const record = await getPendingInterception(downloadId);
    if (!record) return false;

    if (record.resolution === "cancel") {
      await cancelPendingInterception(downloadId, "accepted");
      return false;
    }
    if (record.resolution === "resume" || !record.captureId) {
      await resumePendingInterception(downloadId);
      return false;
    }
    if (Date.now() >= record.deadlineAt) {
      await expirePendingInterception(record);
      return false;
    }

    let capture;
    try {
      capture = await getCapture(record.captureId, record.port);
    } catch {
      const pollFailures = record.pollFailures + 1;
      if (pollFailures <= MAX_CAPTURE_STATUS_RETRIES && Date.now() < record.deadlineAt) {
        await updatePendingInterception(downloadId, {
          pollFailures,
          nextPollAt: Date.now() + CAPTURE_STATUS_RETRY_BASE_MS * (2 ** (pollFailures - 1)),
          resolution: "awaiting",
        });
        return true;
      }

      await failPendingInterception(record);
      return false;
    }

    return await applyCaptureDecision(downloadId, capture);
  } finally {
    pendingProcessing.delete(downloadId);
    await schedulePendingAlarm().catch((error) => {
      console.warn("Bunni could not schedule capture recovery", errorMessage(error));
    });
  }
}

async function applyCaptureDecision(downloadId, capture) {
  if (capture.state === "pending") {
    await updatePendingInterception(downloadId, {
      nextPollAt: Date.now() + CAPTURE_POLL_INTERVAL_MS,
      pollFailures: 0,
      resolution: "awaiting",
    });
    return true;
  }

  if (ACCEPTED_STATES.has(capture.state)) {
    await updatePendingInterception(downloadId, { resolution: "cancel" });
    await cancelPendingInterception(downloadId, capture.state);
    return false;
  }

  if (REJECTED_STATES.has(capture.state)) {
    const resumed = await resumePendingInterception(downloadId);
    await showNotification(
      capture.state === "rejected" ? "Download kept in Chrome" : "Bunni could not prepare the download",
      resumed
        ? "Chrome resumed the original download."
        : "Chrome's paused copy needs attention in Downloads.",
      capture.state === "rejected" ? "success" : "error",
    );
    return false;
  }

  const resumed = await resumePendingInterception(downloadId);
  if (!resumed) await schedulePendingAlarm();
  return false;
}

async function cancelPendingInterception(downloadId, acceptedState) {
  await updatePendingInterception(downloadId, { resolution: "cancel" });
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (item?.state === "in_progress") {
      await chrome.downloads.cancel(downloadId);
    }
    await chrome.downloads.erase({ id: downloadId }).catch((error) => {
      console.warn("Bunni could not remove the Chrome history entry", errorMessage(error));
    });
    await forgetPendingInterception(downloadId);
    await showNotification(
      acceptedState === "accepted-paused" ? "Saved for later in Bunni" : "Download started in Bunni",
      acceptedState === "accepted-paused"
        ? "Chrome's copy was removed; the download is paused in Bunni."
        : "Chrome's copy was removed after Bunni accepted it.",
      "success",
    );
    return true;
  } catch {
    const resumed = await resumePendingInterception(downloadId);
    await showNotification(
      "Chrome could not remove its copy",
      resumed
        ? "The original Chrome download was resumed and may duplicate Bunni's copy."
        : "Open Chrome Downloads to resolve the paused original.",
      "error",
    );
    return false;
  }
}

async function expirePendingInterception(record) {
  let terminalCapture = null;
  try {
    terminalCapture = await deleteCapture(record.captureId, record.port);
  } catch {
    // The desktop app may have closed. Chrome still must get its original back.
  }

  if (terminalCapture && ACCEPTED_STATES.has(terminalCapture.state)) {
    await applyCaptureDecision(record.downloadId, terminalCapture);
    return;
  }

  const resumed = await resumePendingInterception(record.downloadId);
  await showNotification(
    "Bunni confirmation timed out",
    resumed
      ? "No choice was received in time, so Chrome resumed the original download."
      : "The original is still paused; open Chrome Downloads to resume it.",
    "error",
  );
}

async function failPendingInterception(record) {
  let terminalCapture = null;
  try {
    terminalCapture = await deleteCapture(record.captureId, record.port);
  } catch {
    // Best effort: after bounded status retries Chrome must not remain stranded.
  }

  if (terminalCapture && ACCEPTED_STATES.has(terminalCapture.state)) {
    await applyCaptureDecision(record.downloadId, terminalCapture);
    return;
  }

  const resumed = await resumePendingInterception(record.downloadId);
  await showNotification(
    "Chrome resumed this download",
    resumed
      ? "Bunni stopped answering after several checks, so its confirmation was cancelled and Chrome kept the original."
      : "Bunni stopped answering and Chrome's paused copy needs attention in Downloads.",
    "error",
  );
}

async function rejectCaptureBestEffort(captureId, port) {
  try {
    await deleteCapture(captureId, port);
  } catch {
    // This is cleanup only; the fail-safe Chrome resume still runs.
  }
}

async function resumePendingInterception(downloadId) {
  await updatePendingInterception(downloadId, {
    resolution: "resume",
    nextPollAt: Date.now() + RECOVERY_RETRY_MS,
  }).catch(() => undefined);

  const resumed = await ensureChromeDownloadResumed(downloadId);
  if (resumed) {
    await forgetPendingInterception(downloadId).catch(() => undefined);
  } else {
    await schedulePendingAlarm().catch(() => undefined);
  }
  return resumed;
}

async function ensureChromeDownloadResumed(downloadId) {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item || item.state !== "in_progress" || item.paused !== true) return true;
    await chrome.downloads.resume(downloadId);
    return true;
  } catch (error) {
    console.warn("Bunni could not resume the Chrome download", errorMessage(error));
    return false;
  }
}

async function recoverPendingInterceptions() {
  const records = await readPendingInterceptions();
  await Promise.all(
    Object.values(records).map((record) => pollPendingInterception(record.downloadId)),
  );
  await schedulePendingAlarm();
}

function mutatePendingInterceptions(mutation) {
  const operation = pendingInterceptionMutation.then(async () => {
    const stored = await chrome.storage.local.get(PENDING_INTERCEPTIONS_KEY);
    const records = normalizePendingRecords(stored[PENDING_INTERCEPTIONS_KEY]);
    await mutation(records);
    await chrome.storage.local.set({ [PENDING_INTERCEPTIONS_KEY]: records });
  });
  pendingInterceptionMutation = operation.catch(() => undefined);
  return operation;
}

async function readPendingInterceptions() {
  const stored = await chrome.storage.local.get(PENDING_INTERCEPTIONS_KEY);
  return normalizePendingRecords(stored[PENDING_INTERCEPTIONS_KEY]);
}

async function getPendingInterception(downloadId) {
  const records = await readPendingInterceptions();
  return records[String(downloadId)] || null;
}

function rememberPendingInterception(record) {
  return mutatePendingInterceptions((records) => {
    records[String(record.downloadId)] = sanitizePendingRecord(record);
  });
}

function updatePendingInterception(downloadId, changes) {
  return mutatePendingInterceptions((records) => {
    const key = String(downloadId);
    if (!records[key]) return;
    records[key] = sanitizePendingRecord({ ...records[key], ...changes });
  });
}

function forgetPendingInterception(downloadId) {
  return mutatePendingInterceptions((records) => {
    delete records[String(downloadId)];
  });
}

function normalizePendingRecords(value) {
  const records = {};
  const now = Date.now();

  // Migrate v1.1's numeric ID list. Those records predate capture IDs, so the
  // only safe recovery action is to resume them.
  if (Array.isArray(value)) {
    for (const downloadId of value.filter(Number.isInteger)) {
      records[String(downloadId)] = sanitizePendingRecord({
        downloadId,
        captureId: "",
        createdAt: now,
        deadlineAt: now,
        nextPollAt: now,
        pollFailures: 0,
        resolution: "resume",
        label: "Chrome download",
        port: DEFAULT_SETTINGS.port,
      });
    }
    return records;
  }

  if (!value || typeof value !== "object") return records;
  for (const candidate of Object.values(value)) {
    if (!candidate || typeof candidate !== "object" || !Number.isInteger(candidate.downloadId)) continue;
    records[String(candidate.downloadId)] = sanitizePendingRecord(candidate);
  }
  return records;
}

function sanitizePendingRecord(record) {
  const now = Date.now();
  const createdAt = finiteTimestamp(record.createdAt, now);
  const deadlineAt = finiteTimestamp(record.deadlineAt, createdAt + PENDING_CAPTURE_TIMEOUT_MS);
  return {
    downloadId: record.downloadId,
    captureId: typeof record.captureId === "string" ? record.captureId.slice(0, 200) : "",
    createdAt,
    deadlineAt,
    nextPollAt: finiteTimestamp(record.nextPollAt, now),
    pollFailures: Number.isInteger(record.pollFailures) && record.pollFailures >= 0
      ? Math.min(record.pollFailures, MAX_CAPTURE_STATUS_RETRIES + 1)
      : 0,
    resolution: ["awaiting", "cancel", "resume"].includes(record.resolution)
      ? record.resolution
      : "resume",
    label: safeFilename(record.label) || "Chrome download",
    port: clampPort(record.port),
  };
}

function finiteTimestamp(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function schedulePendingAlarm() {
  if (!chrome.alarms?.create) return;
  const records = Object.values(await readPendingInterceptions());
  if (records.length === 0) {
    await chrome.alarms.clear?.(PENDING_CAPTURE_ALARM);
    return;
  }

  const now = Date.now();
  const nextAt = Math.min(...records.map((record) => {
    if (record.resolution !== "awaiting") return now + 1_000;
    return Math.min(record.nextPollAt, record.deadlineAt);
  }));
  chrome.alarms.create(PENDING_CAPTURE_ALARM, { when: Math.max(now + 1_000, nextAt) });
}

async function goFileCredentialHeaders(url, context = {}) {
  if (!isGoFileUrl(url)) return undefined;

  if (context.incognito || chrome.extension?.inIncognitoContext) {
    throw goFileCredentialError(
      "Bunni does not copy credentials from Incognito. Use Chrome for this download or retry in a regular window.",
    );
  }

  if (!chrome.permissions?.contains || !chrome.cookies?.getAll) {
    throw goFileCredentialError(
      "This Chrome version cannot share GoFile credentials safely. Chrome will keep the original download.",
    );
  }

  let granted = false;
  try {
    granted = await chrome.permissions.contains(GOFILE_PERMISSION);
  } catch {
    throw goFileCredentialError(
      "Bunni could not check GoFile access. Open the extension Options and enable GoFile support, then try again.",
    );
  }
  if (!granted) {
    throw goFileCredentialError(
      "GoFile needs browser credentials. Open the Bunni extension popup, enable GoFile access, then click Download again.",
    );
  }

  let cookies;
  try {
    // Chrome returns only cookies applicable to this exact GoFile request URL.
    cookies = await chrome.cookies.getAll({ url });
  } catch {
    throw goFileCredentialError(
      "Bunni could not read GoFile credentials. Chrome will keep the original download.",
    );
  }
  if (!Array.isArray(cookies) || cookies.some((cookie) => cookie?.partitionKey !== undefined)) {
    throw goFileCredentialError(
      "Bunni cannot safely transfer partitioned GoFile credentials. Chrome will keep the original download.",
    );
  }

  const usable = cookies.filter(isUsableCookie);
  if (!usable.some((cookie) => cookie.name.toLowerCase() === "accounttoken" && cookie.value)) {
    throw goFileCredentialError(
      "No GoFile account credential was available for this exact link. Open the GoFile page in Chrome and try again.",
    );
  }

  return {
    Cookie: usable.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
  };
}

function isGoFileUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      (parsed.hostname === "gofile.io" || parsed.hostname.endsWith(".gofile.io"));
  } catch {
    return false;
  }
}

function isUsableCookie(cookie) {
  return Boolean(
    cookie &&
    typeof cookie.name === "string" &&
    typeof cookie.value === "string" &&
    cookie.name &&
    !/[;\r\n]/.test(cookie.name) &&
    !/[\r\n]/.test(cookie.value),
  );
}

function goFileCredentialError(message) {
  const error = new Error(message);
  error.code = GOFILE_ERROR_CODE;
  return error;
}

function publicCaptureRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const safe = { ...value };
  delete safe.headers;
  delete safe.cookie;
  delete safe.cookies;
  delete safe.authorization;
  if (safe.download) safe.download = publicDownloadRecord(safe.download);
  return safe;
}

function publicDownloadRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const safe = { ...value };
  delete safe.headers;
  delete safe.cookie;
  delete safe.cookies;
  delete safe.authorization;
  return safe;
}

async function showNotification(title, message, kind) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message: truncate(message, 220),
      priority: kind === "error" ? 2 : 0,
    });
  } catch (error) {
    console.warn("Bunni notification could not be displayed", errorMessage(error));
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("The Bunni desktop app took too long to respond.");
    }
    throw new Error("Open the Bunni desktop app, then try again.");
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function extractServerMessage(body) {
  if (typeof body === "string") return truncate(body, 180);
  if (!body || typeof body !== "object") return "";
  const candidate = body.error || body.message || body.detail;
  return typeof candidate === "string" ? truncate(candidate, 180) : "";
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Paste an HTTP or HTTPS link first.");
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("That does not look like a complete web address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Bunni only accepts HTTP and HTTPS links.");
  }
  return parsed.href;
}

function optionalHttpUrl(value) {
  try {
    return normalizeHttpUrl(value);
  } catch {
    return "";
  }
}

function normalizeSource(value) {
  if (typeof value !== "string") return "chrome-extension";
  const cleaned = value.replace(/[^a-z0-9:_-]/gi, "").slice(0, 64);
  return cleaned || "chrome-extension";
}

function safeFilename(value) {
  if (typeof value !== "string") return "";
  return value.split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, "").slice(0, 240);
}

function clampSegments(value) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(32, Math.max(1, number)) : DEFAULT_SETTINGS.segments;
}

function clampPort(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1024 && number <= 65_535
    ? number
    : DEFAULT_SETTINGS.port;
}

async function getSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    autoIntercept: Boolean(settings.autoIntercept),
    port: clampPort(settings.port),
    segments: clampSegments(settings.segments),
  };
}

function serviceOrigin(port) {
  return `http://127.0.0.1:${clampPort(port)}`;
}

function friendlyUrl(value) {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return truncate(`${parsed.hostname}${path}`, 72);
  } catch {
    return truncate(String(value), 72);
  }
}

function clearExpiredInterceptionGuards() {
  const now = Date.now();
  for (const [key, expiresAt] of recentInterceptions) {
    if (expiresAt <= now) recentInterceptions.delete(key);
  }
}

function failure(error) {
  return { ok: false, error: errorMessage(error) };
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : "Something unexpected happened.";
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
