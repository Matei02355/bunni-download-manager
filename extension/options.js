const DEFAULT_SETTINGS = { autoIntercept: true, port: 17_865, segments: 8 };
const GOFILE_PERMISSION = {
  permissions: ["cookies"],
  origins: ["https://gofile.io/*", "https://*.gofile.io/*"],
};

const elements = {
  autoIntercept: document.querySelector("#autoIntercept"),
  healthButton: document.querySelector("#healthButton"),
  healthText: document.querySelector("#healthText"),
  gofilePermissionButton: document.querySelector("#gofilePermissionButton"),
  gofilePermissionStatus: document.querySelector("#gofilePermissionStatus"),
  portNumber: document.querySelector("#portNumber"),
  saveButton: document.querySelector("#saveButton"),
  saveStatus: document.querySelector("#saveStatus"),
  segmentsNumber: document.querySelector("#segmentsNumber"),
  segmentsRange: document.querySelector("#segmentsRange"),
  serviceAddress: document.querySelector("#serviceAddress"),
  settingsForm: document.querySelector("#settingsForm"),
  statusDot: document.querySelector("#statusDot"),
};

let goFilePermissionGranted = false;

document.addEventListener("DOMContentLoaded", () => {
  initialize().catch((error) => {
    elements.saveStatus.textContent = errorMessage(error);
  });
});

elements.segmentsRange.addEventListener("input", () => {
  elements.segmentsNumber.value = elements.segmentsRange.value;
});

elements.segmentsNumber.addEventListener("input", () => {
  const segments = clampSegments(elements.segmentsNumber.value);
  elements.segmentsRange.value = String(segments);
});

elements.segmentsNumber.addEventListener("blur", () => {
  const segments = clampSegments(elements.segmentsNumber.value);
  elements.segmentsNumber.value = String(segments);
  elements.segmentsRange.value = String(segments);
});

elements.settingsForm.addEventListener("submit", saveSettings);
elements.healthButton.addEventListener("click", refreshHealth);
elements.gofilePermissionButton.addEventListener("click", toggleGoFilePermission);
elements.portNumber.addEventListener("input", updateServiceAddress);
elements.portNumber.addEventListener("blur", () => {
  elements.portNumber.value = String(clampPort(elements.portNumber.value));
  updateServiceAddress();
});

async function initialize() {
  const [settings, permissionGranted] = await Promise.all([
    chrome.storage.local.get(DEFAULT_SETTINGS),
    hasGoFilePermission(),
  ]);
  const segments = clampSegments(settings.segments);
  const port = clampPort(settings.port);
  elements.segmentsRange.value = String(segments);
  elements.segmentsNumber.value = String(segments);
  elements.portNumber.value = String(port);
  elements.autoIntercept.checked = Boolean(settings.autoIntercept);
  setGoFilePermissionState(permissionGranted);
  updateServiceAddress();
  await refreshHealth();
}

async function toggleGoFilePermission() {
  elements.gofilePermissionButton.disabled = true;
  elements.gofilePermissionStatus.textContent = goFilePermissionGranted
    ? "Removing GoFile access…"
    : "Waiting for Chrome’s GoFile permission prompt…";

  try {
    if (goFilePermissionGranted) {
      const removed = await chrome.permissions.remove(GOFILE_PERMISSION);
      setGoFilePermissionState(removed ? false : await hasGoFilePermission());
      elements.gofilePermissionStatus.textContent = removed
        ? "GoFile access is off. Protected GoFile downloads will stay in Chrome."
        : "Chrome kept the permission. Try again from this button.";
    } else {
      const granted = await chrome.permissions.request(GOFILE_PERMISSION);
      setGoFilePermissionState(granted && await hasGoFilePermission());
      elements.gofilePermissionStatus.textContent = goFilePermissionGranted
        ? "GoFile access is enabled only for GoFile URLs."
        : "Permission was not granted. Protected GoFile downloads will stay in Chrome.";
    }
  } catch (error) {
    setGoFilePermissionState(await hasGoFilePermission());
    elements.gofilePermissionStatus.textContent = errorMessage(error);
  } finally {
    elements.gofilePermissionButton.disabled = false;
  }
}

async function hasGoFilePermission() {
  try {
    return Boolean(await chrome.permissions.contains(GOFILE_PERMISSION));
  } catch {
    return false;
  }
}

function setGoFilePermissionState(enabled) {
  goFilePermissionGranted = Boolean(enabled);
  elements.gofilePermissionButton.textContent = enabled
    ? "Remove GoFile access"
    : "Enable GoFile support";
  elements.gofilePermissionButton.className = `permission-button${enabled ? " is-remove" : ""}`;
  elements.gofilePermissionStatus.className = `permission-status is-${enabled ? "enabled" : "disabled"}`;
  elements.gofilePermissionStatus.textContent = enabled
    ? "Enabled. Bunni may read cookies only for matching GoFile download URLs."
    : "Off. Bunni cannot read GoFile cookies; protected downloads stay in Chrome.";
}

async function saveSettings(event) {
  event.preventDefault();
  elements.saveButton.disabled = true;
  elements.saveStatus.textContent = "Saving…";

  const segments = clampSegments(elements.segmentsNumber.value);
  const port = clampPort(elements.portNumber.value);
  try {
    await chrome.storage.local.set({
      autoIntercept: elements.autoIntercept.checked,
      port,
      segments,
    });
    elements.segmentsRange.value = String(segments);
    elements.segmentsNumber.value = String(segments);
    elements.portNumber.value = String(port);
    updateServiceAddress();
    elements.saveStatus.textContent = "Settings saved. Checking the desktop app…";
    await refreshHealth();
    elements.saveStatus.textContent = "Settings saved.";
  } catch (error) {
    elements.saveStatus.textContent = errorMessage(error);
  } finally {
    elements.saveButton.disabled = false;
  }
}

async function refreshHealth() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const port = clampPort(settings.port);
  setHealth("checking", `Checking 127.0.0.1:${port}…`);
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_HEALTH" });
    if (!result?.ok) throw new Error(result?.error || "The Bunni app did not answer.");
    setHealth("online", `Connected on port ${result.port} — response in ${result.latencyMs} ms.`);
  } catch (error) {
    setHealth("offline", errorMessage(error));
  }
}

function setHealth(state, message) {
  elements.statusDot.className = `status-dot is-${state}`;
  elements.healthText.textContent = message;
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

function updateServiceAddress() {
  const port = clampPort(elements.portNumber.value);
  elements.serviceAddress.textContent = `http://127.0.0.1:${port}`;
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : "Something unexpected happened.";
}
