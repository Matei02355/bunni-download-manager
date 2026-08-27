const DEFAULT_SETTINGS = { autoIntercept: true, port: 17_865, segments: 8 };
const GOFILE_PERMISSION = {
  permissions: ["cookies"],
  origins: ["https://gofile.io/*", "https://*.gofile.io/*"],
};

const elements = {
  captureCard: document.querySelector("#captureCard"),
  captureDetail: document.querySelector("#captureDetail"),
  captureTitle: document.querySelector("#captureTitle"),
  captureToggle: document.querySelector("#captureToggle"),
  currentButton: document.querySelector("#currentButton"),
  currentTabLabel: document.querySelector("#currentTabLabel"),
  feedback: document.querySelector("#feedback"),
  healthButton: document.querySelector("#healthButton"),
  healthDetail: document.querySelector("#healthDetail"),
  healthTitle: document.querySelector("#healthTitle"),
  gofileEnableButton: document.querySelector("#gofileEnableButton"),
  gofileOptionsButton: document.querySelector("#gofileOptionsButton"),
  gofileAccessText: document.querySelector("#gofileAccessText"),
  gofileWarning: document.querySelector("#gofileWarning"),
  gofileWarningText: document.querySelector("#gofileWarningText"),
  gofileWarningTitle: document.querySelector("#gofileWarningTitle"),
  segmentBadge: document.querySelector("#segmentBadge"),
  sendButton: document.querySelector("#sendButton"),
  settingsButton: document.querySelector("#settingsButton"),
  urlForm: document.querySelector("#urlForm"),
  urlInput: document.querySelector("#urlInput"),
};

let currentTabUrl = "";
let currentTabIncognito = false;
let currentTabIsGoFile = false;
let goFileAccessEnabled = false;
let busy = false;

document.addEventListener("DOMContentLoaded", () => {
  initialize().catch((error) => showFeedback(errorMessage(error), "error"));
});

elements.currentButton.addEventListener("click", () => {
  startDownload(currentTabUrl, "popup-current-tab");
});

elements.urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  startDownload(elements.urlInput.value, "popup-pasted-url");
});

elements.healthButton.addEventListener("click", refreshHealth);
elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
elements.gofileOptionsButton.addEventListener("click", handleGoFileAccessClick);
elements.gofileEnableButton.addEventListener("click", requestGoFileAccess);
elements.captureToggle.addEventListener("change", saveCaptureSetting);

async function initialize() {
  const [settings, , goFileAccess] = await Promise.all([
    chrome.storage.local.get(DEFAULT_SETTINGS),
    loadCurrentTab(),
    hasGoFileAccess(),
  ]);
  const segments = clampSegments(settings.segments);
  elements.segmentBadge.textContent = `${segments} ${segments === 1 ? "part" : "parts"}`;
  setCaptureState(Boolean(settings.autoIntercept));
  setGoFileAccessState(goFileAccess);
  await refreshHealth();
}

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    elements.currentTabLabel.textContent = "No active browser tab was found.";
    return;
  }

  try {
    currentTabUrl = normalizeHttpUrl(tab.url);
    currentTabIncognito = Boolean(tab.incognito);
    currentTabIsGoFile = isGoFileUrl(currentTabUrl);
    elements.currentTabLabel.textContent = tab.title ? `${tab.title} — ${friendlyUrl(currentTabUrl)}` : friendlyUrl(currentTabUrl);
    elements.currentButton.disabled = false;
  } catch {
    currentTabUrl = "";
    currentTabIncognito = false;
    currentTabIsGoFile = false;
    elements.currentTabLabel.textContent = "This browser page is not an HTTP or HTTPS link.";
    elements.currentButton.disabled = true;
  }
}

async function saveCaptureSetting() {
  const enabled = elements.captureToggle.checked;
  setCaptureState(enabled);
  try {
    await chrome.storage.local.set({ autoIntercept: enabled });
    showFeedback(
      enabled ? "Automatic capture is on." : "Automatic capture is off; Chrome will keep downloads.",
      "success",
    );
  } catch (error) {
    setCaptureState(!enabled);
    showFeedback(errorMessage(error), "error");
  }
}

function setCaptureState(enabled) {
  elements.captureToggle.checked = enabled;
  elements.captureCard.className = `capture-card is-${enabled ? "on" : "off"}`;
  elements.captureTitle.textContent = `Automatic capture: ${enabled ? "ON" : "OFF"}`;
  elements.captureDetail.textContent = enabled
    ? "New Chrome downloads pause while you choose in Bunni."
    : "Chrome keeps downloads until you turn this on.";
}

async function hasGoFileAccess() {
  try {
    return Boolean(await chrome.permissions.contains(GOFILE_PERMISSION));
  } catch {
    return false;
  }
}

function setGoFileAccessState(enabled) {
  goFileAccessEnabled = Boolean(enabled);
  elements.gofileOptionsButton.className = `gofile-status is-${enabled ? "enabled" : "disabled"}`;
  elements.gofileAccessText.textContent = enabled
    ? currentTabIsGoFile
      ? "GoFile access: ON · reliable 1-connection mode"
      : "GoFile access: ON · manage in Settings"
    : "GoFile access: OFF · click to enable";
  updateGoFileGuidance();
}

function handleGoFileAccessClick() {
  if (goFileAccessEnabled) {
    chrome.runtime.openOptionsPage();
    return;
  }
  requestGoFileAccess();
}

async function requestGoFileAccess() {
  if (currentTabIncognito && currentTabIsGoFile) {
    showFeedback("GoFile handoff is unavailable in Incognito. Retry from a regular Chrome window.", "error");
    return;
  }
  if (!chrome.permissions?.request) {
    showFeedback("Open Bunni Settings and enable GoFile support, then click the website Download button again.", "error");
    return;
  }

  setGoFilePermissionBusy(true);
  showFeedback("Waiting for Chrome’s GoFile permission prompt…", "");
  try {
    const granted = await chrome.permissions.request(GOFILE_PERMISSION);
    const enabled = Boolean(granted && await hasGoFileAccess());
    setGoFileAccessState(enabled);
    showFeedback(
      enabled
        ? "GoFile access is ON. Return to the GoFile page and click Download again."
        : "GoFile access is still OFF. Chrome will keep protected GoFile downloads.",
      enabled ? "success" : "error",
    );
  } catch (error) {
    setGoFileAccessState(await hasGoFileAccess());
    showFeedback(errorMessage(error), "error");
  } finally {
    setGoFilePermissionBusy(false);
  }
}

function setGoFilePermissionBusy(value) {
  elements.gofileOptionsButton.disabled = value;
  elements.gofileEnableButton.disabled = value;
  if (value) elements.gofileEnableButton.textContent = "Waiting for Chrome…";
  else elements.gofileEnableButton.textContent = "Enable GoFile access";
}

function updateGoFileGuidance() {
  const showWarning = currentTabIsGoFile && (!goFileAccessEnabled || currentTabIncognito);
  elements.gofileWarning.hidden = !showWarning;
  if (!showWarning) {
    elements.currentButton.disabled = busy || !currentTabUrl;
    return;
  }

  if (currentTabIncognito) {
    elements.gofileWarningTitle.textContent = "GoFile handoff is unavailable in Incognito";
    elements.gofileWarningText.textContent = "Open this GoFile page in a regular Chrome window, then click its Download button again.";
    elements.gofileEnableButton.hidden = true;
  } else {
    elements.gofileWarningTitle.textContent = "GoFile access is OFF";
    elements.gofileWarningText.textContent = "Enable access only for GoFile, then click Download again. Bunni will use one connection to avoid GoFile rate limits.";
    elements.gofileEnableButton.hidden = false;
  }
  elements.currentButton.disabled = true;
}

async function refreshHealth() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const port = clampPort(settings.port);
  setHealth("checking", "Desktop app: CHECKING", `Looking at 127.0.0.1:${port}`);
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_HEALTH" });
    if (!result?.ok) throw new Error(result?.error || "The Bunni app did not answer.");
    setHealth("online", "Desktop app: CONNECTED", `Port ${result.port} · answered in ${result.latencyMs} ms`);
  } catch (error) {
    setHealth("offline", "Desktop app: OFFLINE", `${errorMessage(error)} Click to retry.`);
  }
}

async function startDownload(rawUrl, source) {
  if (busy) return;

  let url;
  try {
    url = normalizeHttpUrl(rawUrl);
  } catch (error) {
    showFeedback(errorMessage(error), "error");
    elements.urlInput.focus();
    return;
  }

  if (isGoFileUrl(url) && (!goFileAccessEnabled || currentTabIncognito)) {
    updateGoFileGuidance();
    showFeedback(
      currentTabIncognito
        ? "GoFile handoff is unavailable in Incognito. Retry from a regular Chrome window."
        : "GoFile access is OFF. Enable it above, then click the website Download button again.",
      "error",
    );
    return;
  }

  setBusy(true);
  showFeedback("Opening confirmation in Bunni…", "");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "CREATE_CAPTURE",
      url,
      source,
      referrer: currentTabUrl,
      incognito: currentTabIncognito,
    });
    if (!response?.ok) throw new Error(response?.error || "Bunni did not accept the link.");
    showFeedback("Ready—review it in the Bunni app, then choose Start, Later, or Cancel.", "success");
    if (source === "popup-pasted-url") elements.urlInput.value = "";
  } catch (error) {
    showFeedback(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  busy = value;
  elements.currentButton.disabled = value || !currentTabUrl || (currentTabIsGoFile && (!goFileAccessEnabled || currentTabIncognito));
  elements.sendButton.disabled = value;
  elements.urlInput.disabled = value;
  elements.sendButton.textContent = value ? "Opening…" : "Review in Bunni";
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

function setHealth(state, title, detail) {
  elements.healthButton.className = `health-card is-${state}`;
  elements.healthTitle.textContent = title;
  elements.healthDetail.textContent = detail;
}

function showFeedback(message, kind) {
  elements.feedback.className = `feedback${kind ? ` is-${kind}` : ""}`;
  elements.feedback.textContent = message;
}

function normalizeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Paste a link first.");
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter a complete HTTP or HTTPS address.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Bunni only accepts HTTP and HTTPS links.");
  }
  return parsed.href;
}

function clampSegments(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(32, Math.max(1, parsed)) : DEFAULT_SETTINGS.segments;
}

function clampPort(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65_535
    ? parsed
    : DEFAULT_SETTINGS.port;
}

function friendlyUrl(value) {
  const parsed = new URL(value);
  const compact = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  return compact.length > 62 ? `${compact.slice(0, 61)}…` : compact;
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : "Something unexpected happened.";
}
