import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext, type Context } from "node:vm";

const workerSource = readFileSync("extension/service-worker.js", "utf8");
const popupSource = readFileSync("extension/popup.js", "utf8");

interface WorkerContext extends Context {
  initializeSettings: () => Promise<void>;
}

function createWorkerHarness(initial: Record<string, unknown> = {}) {
  const localState: Record<string, unknown> = {
    pendingInterceptions: {},
    port: 17_865,
    segments: 8,
    ...initial,
  };
  const badges: string[] = [];
  const badgeColors: string[] = [];
  const titles: string[] = [];
  const installedListeners: Array<() => void> = [];
  const startupListeners: Array<() => void> = [];
  const downloadCreatedListeners: Array<(item: unknown) => void> = [];
  const storageListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];

  const chrome = {
    action: {
      async setBadgeBackgroundColor({ color }: { color: string }) { badgeColors.push(color); },
      async setBadgeText({ text }: { text: string }) { badges.push(text); },
      async setBadgeTextColor() {},
      async setTitle({ title }: { title: string }) { titles.push(title); },
    },
    alarms: {
      async clear() { return true; },
      create() {},
      onAlarm: { addListener() {} },
    },
    contextMenus: {
      create() {},
      onClicked: { addListener() {} },
      async removeAll() {},
    },
    cookies: { async getAll() { return []; } },
    downloads: {
      onCreated: {
        addListener(listener: (item: unknown) => void) { downloadCreatedListeners.push(listener); },
      },
      async search() { return []; },
    },
    extension: { inIncognitoContext: false },
    notifications: { async create() {} },
    permissions: { async contains() { return false; } },
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      onInstalled: { addListener(listener: () => void) { installedListeners.push(listener); } },
      onMessage: { addListener() {} },
      onStartup: { addListener(listener: () => void) { startupListeners.push(listener); } },
    },
    storage: {
      local: {
        async get(keys: string | string[] | Record<string, unknown>) {
          if (typeof keys === "string") return { [keys]: localState[keys] };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, localState[key]]));
          }
          return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.prototype.hasOwnProperty.call(localState, key) ? localState[key] : fallback,
          ]));
        },
        async set(values: Record<string, unknown>) { Object.assign(localState, values); },
      },
      onChanged: {
        addListener(listener: (changes: Record<string, unknown>, area: string) => void) {
          storageListeners.push(listener);
        },
      },
    },
  };

  const context = createContext({
    AbortController,
    URL,
    chrome,
    clearTimeout() {},
    console,
    fetch: async () => { throw new Error("Unexpected fetch"); },
    performance,
    setTimeout() { return 1; },
  }) as WorkerContext;
  runInContext(workerSource, context, { filename: "extension/service-worker.js" });

  return {
    badgeColors,
    badges,
    context,
    downloadCreatedListeners,
    installedListeners,
    localState,
    startupListeners,
    storageListeners,
    titles,
  };
}

class FakeElement {
  checked = false;
  className = "";
  disabled = false;
  hidden = false;
  textContent = "";
  value = "";
  listeners = new Map<string, Array<(event?: { preventDefault(): void }) => void>>();

  addEventListener(name: string, listener: (event?: { preventDefault(): void }) => void) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  focus() {}
}

interface PopupContext extends Context {
  initialize: () => Promise<void>;
  requestGoFileAccess: () => Promise<void>;
  startDownload: (url: string, source: string) => Promise<void>;
}

function createPopupHarness(options: { autoIntercept?: boolean; permission?: boolean } = {}) {
  const ids = [
    "captureCard", "captureDetail", "captureTitle", "captureToggle", "currentButton",
    "currentTabLabel", "feedback", "healthButton", "healthDetail", "healthTitle",
    "gofileEnableButton", "gofileOptionsButton", "gofileAccessText", "gofileWarning",
    "gofileWarningText", "gofileWarningTitle", "segmentBadge", "sendButton",
    "settingsButton", "urlForm", "urlInput",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()])) as Record<string, FakeElement>;
  const localState: Record<string, unknown> = {
    autoIntercept: options.autoIntercept ?? true,
    port: 17_865,
    segments: 8,
  };
  let permission = options.permission ?? false;
  const permissionRequests: unknown[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const documentListeners = new Map<string, () => void>();
  const document = {
    addEventListener(name: string, listener: () => void) { documentListeners.set(name, listener); },
    querySelector(selector: string) { return elements[selector.replace(/^#/, "")] ?? null; },
  };
  const chrome = {
    permissions: {
      async contains() { return permission; },
      async request(request: unknown) {
        permissionRequests.push(request);
        permission = true;
        return true;
      },
    },
    runtime: {
      async openOptionsPage() {},
      async sendMessage(message: Record<string, unknown>) {
        messages.push(message);
        if (message.type === "GET_HEALTH") {
          return { ok: true, port: 17_865, latencyMs: 4 };
        }
        return { ok: true };
      },
    },
    storage: {
      local: {
        async get(defaults: Record<string, unknown>) {
          return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [
            key,
            Object.prototype.hasOwnProperty.call(localState, key) ? localState[key] : fallback,
          ]));
        },
        async set(values: Record<string, unknown>) { Object.assign(localState, values); },
      },
    },
    tabs: {
      async query() {
        return [{
          id: 7,
          incognito: false,
          title: "GoFile",
          url: "https://gofile.io/d/example",
        }];
      },
    },
  };

  const context = createContext({ URL, chrome, console, document }) as PopupContext;
  runInContext(popupSource, context, { filename: "extension/popup.js" });
  return { context, elements, localState, messages, permissionRequests };
}

test("extension manifest keeps permissions narrow and exposes the diagnostic popup", () => {
  const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8")) as Record<string, unknown>;
  const popupHtml = readFileSync("extension/popup.html", "utf8");

  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.deepEqual(manifest.optional_permissions, ["cookies"]);
  assert.deepEqual(manifest.optional_host_permissions, [
    "https://gofile.io/*",
    "https://*.gofile.io/*",
  ]);
  assert.equal("content_scripts" in manifest, false);
  assert.doesNotMatch(JSON.stringify(manifest), /<all_urls>/i);
  assert.match(popupHtml, /Desktop app: CHECKING/);
  assert.match(popupHtml, /Automatic capture: CHECKING/);
  assert.match(popupHtml, /GoFile access: CHECKING/);
  assert.match(popupHtml, /id="gofileWarning"/);
  assert.match(popupHtml, /Enable GoFile access/);
});

test("toolbar badge follows fresh-install ON and preserves an existing OFF choice", async () => {
  const fresh = createWorkerHarness();
  await fresh.context.initializeSettings();
  assert.equal(fresh.localState.autoIntercept, true);
  assert.equal(fresh.badges.at(-1), "ON");
  assert.equal(fresh.badgeColors.at(-1), "#287d67");
  assert.match(fresh.titles.at(-1) ?? "", /capture ON/);
  assert.equal(fresh.downloadCreatedListeners.length, 1);

  const optedOut = createWorkerHarness({ autoIntercept: false });
  await optedOut.context.initializeSettings();
  assert.equal(optedOut.localState.autoIntercept, false);
  assert.equal(optedOut.badges.at(-1), "OFF");
  assert.equal(optedOut.badgeColors.at(-1), "#b33f4a");
  assert.match(optedOut.titles.at(-1) ?? "", /capture OFF/);

  optedOut.storageListeners[0]?.({ autoIntercept: { oldValue: false, newValue: true } }, "local");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(optedOut.badges.at(-1), "ON");
});

test("GoFile tab shows a blocking explanation and grants only GoFile access", async () => {
  const harness = createPopupHarness({ permission: false });
  await harness.context.initialize();

  assert.equal(harness.elements.captureTitle.textContent, "Automatic capture: ON");
  assert.equal(harness.elements.healthTitle.textContent, "Desktop app: CONNECTED");
  assert.match(harness.elements.gofileAccessText.textContent, /GoFile access: OFF/);
  assert.equal(harness.elements.gofileWarning.hidden, false);
  assert.equal(harness.elements.currentButton.disabled, true);

  await harness.context.startDownload(
    "https://store1.gofile.io/download/web/example/archive.rar",
    "popup-pasted-url",
  );
  assert.match(harness.elements.feedback.textContent, /GoFile access is OFF/i);
  assert.equal(harness.messages.some((message) => message.type === "CREATE_CAPTURE"), false);

  await harness.context.requestGoFileAccess();
  assert.equal(harness.permissionRequests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.permissionRequests[0])), {
    permissions: ["cookies"],
    origins: ["https://gofile.io/*", "https://*.gofile.io/*"],
  });
  assert.match(harness.elements.gofileAccessText.textContent, /GoFile access: ON/);
  assert.equal(harness.elements.gofileWarning.hidden, true);
  assert.equal(harness.elements.currentButton.disabled, false);
  assert.match(harness.elements.feedback.textContent, /click Download again/i);
});
