import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext, type Context } from "node:vm";

const serviceWorkerSource = readFileSync("extension/service-worker.js", "utf8");
const CAPTURE_ID = "capture-test-1";

type CaptureState = "pending" | "accepted" | "accepted-paused" | "rejected" | "error";

interface PendingRecord {
  downloadId: number;
  captureId: string;
  createdAt: number;
  deadlineAt: number;
  nextPollAt: number;
  pollFailures?: number;
  resolution: "awaiting" | "cancel" | "resume";
  label: string;
  port: number;
}

interface WorkerContext extends Context {
  handleContextMenuClick: (info: Record<string, unknown>, tab: Record<string, unknown>) => Promise<void>;
  initializeSettings: () => Promise<void>;
  interceptBrowserDownload: (item: Record<string, unknown>) => Promise<void>;
  pollPendingInterception: (downloadId: number) => Promise<boolean>;
  recoverPendingInterceptions: () => Promise<void>;
}

function captureResponse(state: CaptureState, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    ok: true,
    capture: {
      id: CAPTURE_ID,
      state,
      download: { id: "prepared-download", ...extra },
    },
  }), {
    status: state === "pending" ? 202 : 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(options: {
  autoIntercept?: boolean;
  captureState?: CaptureState;
  cookies?: Array<Record<string, unknown>>;
  fetchFailure?: boolean;
  getFailures?: number;
  initialPending?: Record<string, PendingRecord> | number[];
  omitAutoIntercept?: boolean;
  permissionGranted?: boolean;
  segments?: number;
} = {}) {
  let captureState = options.captureState ?? "pending";
  let remainingGetFailures = options.getFailures ?? 0;
  let runtimeMessageListener: (
    message: Record<string, unknown>,
    sender: Record<string, unknown>,
    sendResponse: (response: unknown) => void,
  ) => boolean | undefined = () => undefined;
  const calls = {
    alarms: 0,
    cancel: 0,
    cookieRead: 0,
    erase: 0,
    pause: 0,
    resume: 0,
  };
  const cookieQueries: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const notifications: Array<{ title: string; message: string }> = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const localState: Record<string, unknown> = {
    pendingInterceptions: options.initialPending ?? {},
    port: 17_865,
    segments: options.segments ?? 8,
  };
  if (!options.omitAutoIntercept) localState.autoIntercept = options.autoIntercept ?? true;
  const downloads = new Map<number, { id: number; state: string; paused: boolean }>([
    [42, { id: 42, state: "in_progress", paused: false }],
    [84, { id: 84, state: "in_progress", paused: false }],
    [77, { id: 77, state: "in_progress", paused: true }],
    [78, { id: 78, state: "in_progress", paused: true }],
  ]);
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];

  const chrome = {
    alarms: {
      async clear() { return true; },
      create() { calls.alarms += 1; },
      onAlarm: { addListener(listener: (alarm: { name: string }) => void) { alarmListeners.push(listener); } },
    },
    contextMenus: {
      create() {},
      onClicked: { addListener() {} },
      async removeAll() {},
    },
    cookies: {
      async getAll(query: Record<string, unknown>) {
        calls.cookieRead += 1;
        cookieQueries.push(query);
        return options.cookies ?? [];
      },
    },
    downloads: {
      async cancel(downloadId: number) {
        calls.cancel += 1;
        const item = downloads.get(downloadId);
        if (item) {
          item.state = "interrupted";
          item.paused = false;
        }
      },
      async erase(query: { id: number }) {
        calls.erase += 1;
        downloads.delete(query.id);
      },
      onCreated: { addListener() {} },
      async pause(downloadId: number) {
        calls.pause += 1;
        const item = downloads.get(downloadId);
        if (item) item.paused = true;
      },
      async resume(downloadId: number) {
        calls.resume += 1;
        const item = downloads.get(downloadId);
        if (item) item.paused = false;
      },
      async search(query: { id: number }) {
        const item = downloads.get(query.id);
        return item ? [{ ...item }] : [];
      },
    },
    extension: { inIncognitoContext: false },
    notifications: {
      async create(
        idOrNotification: string | { title: string; message: string },
        maybeNotification?: { title: string; message: string },
      ) {
        const notification = typeof idOrNotification === "string"
          ? maybeNotification!
          : idOrNotification;
        notifications.push(notification);
      },
    },
    permissions: {
      async contains() { return options.permissionGranted ?? false; },
    },
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(listener: typeof runtimeMessageListener) { runtimeMessageListener = listener; },
      },
      onStartup: { addListener() {} },
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
    },
  };

  let nextTimer = 1;
  const context = createContext({
    AbortController,
    URL,
    chrome,
    clearTimeout() {},
    console: {
      error(...values: unknown[]) { logs.push(values.map(String).join(" ")); },
      log(...values: unknown[]) { logs.push(values.map(String).join(" ")); },
      warn(...values: unknown[]) { logs.push(values.map(String).join(" ")); },
    },
    fetch: async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (options.fetchFailure) throw new TypeError("connection refused");
      const method = init?.method ?? "GET";
      if (method === "POST") return captureResponse("pending");
      if (method === "DELETE") {
        captureState = "rejected";
        return captureResponse("rejected");
      }
      if (remainingGetFailures > 0) {
        remainingGetFailures -= 1;
        throw new TypeError("temporary status failure");
      }
      return captureResponse(captureState);
    },
    performance,
    // Capture monitors use timers for responsive polling. Tests drive polling
    // explicitly, so timers remain dormant while alarm creation is still tested.
    setTimeout() { return nextTimer++; },
  }) as WorkerContext;
  runInContext(serviceWorkerSource, context, { filename: "extension/service-worker.js" });

  async function sendWorkerMessage(message: Record<string, unknown>) {
    return await new Promise<unknown>((resolve, reject) => {
      const keptOpen = runtimeMessageListener(message, {}, resolve);
      if (!keptOpen) reject(new Error("The worker did not accept the message."));
    });
  }

  return {
    calls,
    context,
    cookieQueries,
    downloads,
    localState,
    logs,
    notifications,
    requests,
    sendWorkerMessage,
    setCaptureState(state: CaptureState) { captureState = state; },
  };
}

const interceptedItem = {
  id: 42,
  url: "https://example.com/file.zip",
  finalUrl: "https://example.com/file.zip",
  filename: "C:\\Downloads\\file.zip",
  referrer: "https://example.com/",
};

const goFileItem = {
  id: 84,
  url: "https://store1.gofile.io/download/web/example/archive.rar",
  finalUrl: "https://store1.gofile.io/download/web/example/archive.rar",
  filename: "C:\\Downloads\\archive.rar",
  referrer: "https://gofile.io/d/example",
  incognito: false,
};

async function beginPendingCapture(harness: ReturnType<typeof createHarness>, item = interceptedItem) {
  await harness.context.interceptBrowserDownload(item);
  const records = harness.localState.pendingInterceptions as Record<string, PendingRecord>;
  assert.equal(records[String(item.id)]?.captureId, CAPTURE_ID);
  assert.equal(records[String(item.id)]?.resolution, "awaiting");
  // Direct poll calls in these unit tests represent a due alarm/monitor tick.
  records[String(item.id)].nextPollAt = 0;
}

test("fresh installs enable click-to-confirm while an existing off choice is preserved", async () => {
  const fresh = createHarness({ omitAutoIntercept: true });
  await fresh.context.initializeSettings();
  assert.equal(fresh.localState.autoIntercept, true);

  const optedOut = createHarness({ autoIntercept: false });
  await optedOut.context.initializeSettings();
  await optedOut.context.interceptBrowserDownload(interceptedItem);
  assert.equal(optedOut.localState.autoIntercept, false);
  assert.equal(optedOut.calls.pause, 0);
});

test("pending confirmation keeps Chrome paused and does not cancel", async () => {
  const harness = createHarness();
  await beginPendingCapture(harness);

  assert.equal(harness.calls.pause, 1);
  assert.equal(harness.calls.cancel, 0);
  assert.equal(harness.calls.resume, 0);
  assert.equal(harness.calls.erase, 0);
  assert.equal(harness.downloads.get(42)?.paused, true);
  assert.equal(new URL(harness.requests.find((request) => request.init?.method === "POST")!.url).pathname, "/api/captures");
  assert.ok(harness.calls.alarms > 0);
});

test("Start acceptance cancels and erases Chrome only after polling", async () => {
  const harness = createHarness();
  await beginPendingCapture(harness);
  harness.setCaptureState("accepted");

  await harness.context.pollPendingInterception(42);

  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.erase, 1);
  assert.equal(harness.calls.resume, 0);
  assert.equal(harness.downloads.has(42), false);
  assert.equal(Object.keys(harness.localState.pendingInterceptions as object).length, 0);
  assert.match(harness.notifications.at(-1)?.title ?? "", /started in Bunni/i);
});

test("Later acceptance removes Chrome and leaves the Bunni copy paused", async () => {
  const harness = createHarness();
  await beginPendingCapture(harness);
  harness.setCaptureState("accepted-paused");

  await harness.context.pollPendingInterception(42);

  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.erase, 1);
  assert.equal(harness.calls.resume, 0);
  assert.match(harness.notifications.at(-1)?.title ?? "", /later/i);
});

test("Cancel and desktop preparation errors resume Chrome", async (context) => {
  for (const state of ["rejected", "error"] as const) {
    await context.test(state, async () => {
      const harness = createHarness();
      await beginPendingCapture(harness);
      harness.setCaptureState(state);

      await harness.context.pollPendingInterception(42);

      assert.equal(harness.calls.resume, 1);
      assert.equal(harness.calls.cancel, 0);
      assert.equal(harness.calls.erase, 0);
      assert.equal(harness.downloads.get(42)?.paused, false);
      assert.equal(Object.keys(harness.localState.pendingInterceptions as object).length, 0);
    });
  }
});

test("an unavailable app leaves no paused Chrome download", async () => {
  const harness = createHarness({ fetchFailure: true });

  await harness.context.interceptBrowserDownload(interceptedItem);

  assert.equal(harness.calls.pause, 1);
  assert.equal(harness.calls.resume, 1);
  assert.equal(harness.calls.cancel, 0);
  assert.equal(harness.downloads.get(42)?.paused, false);
  assert.equal(Object.keys(harness.localState.pendingInterceptions as object).length, 0);
  assert.match(harness.notifications.at(-1)?.title ?? "", /unavailable/i);
});

test("a transient capture-status failure keeps Chrome paused and recovers", async () => {
  const harness = createHarness({ getFailures: 1 });
  await beginPendingCapture(harness);

  const stillPending = await harness.context.pollPendingInterception(42);
  assert.equal(stillPending, true);
  assert.equal(harness.calls.resume, 0);
  assert.equal(harness.calls.cancel, 0);
  assert.equal(harness.downloads.get(42)?.paused, true);
  const records = harness.localState.pendingInterceptions as Record<string, PendingRecord>;
  assert.equal(records["42"].pollFailures, 1);

  harness.setCaptureState("accepted");
  records["42"].nextPollAt = 0;
  await harness.context.pollPendingInterception(42);
  assert.equal(harness.calls.cancel, 1);
  assert.equal(harness.calls.resume, 0);
});

test("bounded pending timeout rejects the capture and resumes Chrome", async () => {
  const harness = createHarness();
  await beginPendingCapture(harness);
  const records = harness.localState.pendingInterceptions as Record<string, PendingRecord>;
  records["42"].deadlineAt = 0;

  await harness.context.pollPendingInterception(42);

  assert.ok(harness.requests.some((request) => request.init?.method === "DELETE"));
  assert.equal(harness.calls.resume, 1);
  assert.equal(harness.calls.cancel, 0);
  assert.equal(harness.downloads.get(42)?.paused, false);
  assert.match(harness.notifications.at(-1)?.title ?? "", /timed out/i);
});

test("a restarted MV3 worker finishes persisted decisions safely", async (context) => {
  const now = Date.now();
  await context.test("persisted pending capture is polled and accepted", async () => {
    const harness = createHarness({ captureState: "accepted" });
    harness.localState.pendingInterceptions = {
      "77": {
        downloadId: 77,
        captureId: CAPTURE_ID,
        createdAt: now,
        deadlineAt: now + 60_000,
        nextPollAt: now,
        resolution: "awaiting",
        label: "restart.zip",
        port: 17_865,
      },
    };

    await harness.context.recoverPendingInterceptions();
    await Promise.resolve();

    assert.equal(harness.calls.cancel, 1);
    assert.equal(harness.calls.erase, 1);
    assert.equal(harness.downloads.has(77), false);
  });

  await context.test("pre-capture pause is resumed after restart", async () => {
    const harness = createHarness();
    harness.localState.pendingInterceptions = [78];

    await harness.context.recoverPendingInterceptions();
    await Promise.resolve();

    assert.equal(harness.calls.resume, 1);
    assert.equal(harness.downloads.get(78)?.paused, false);
    assert.equal(Object.keys(harness.localState.pendingInterceptions as object).length, 0);
  });
});

test("GoFile credentials are exact-URL scoped and never persisted or displayed", async () => {
  const token = "secret-account-token";
  const harness = createHarness({
    cookies: [
      { name: "accountToken", value: token },
      { name: "downloadPreference", value: "fast" },
    ],
    permissionGranted: true,
  });

  await beginPendingCapture(harness, goFileItem);

  assert.equal(harness.calls.cookieRead, 1);
  assert.equal(harness.cookieQueries.length, 1);
  assert.equal(harness.cookieQueries[0]?.url, goFileItem.url);
  const post = harness.requests.find((request) => request.init?.method === "POST");
  const payload = JSON.parse(String(post?.init?.body)) as { headers?: Record<string, string> };
  assert.equal(payload.headers?.Cookie, `accountToken=${token}; downloadPreference=fast`);
  assert.doesNotMatch(JSON.stringify(harness.localState), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(harness.notifications), new RegExp(token));
  assert.doesNotMatch(harness.logs.join("\n"), new RegExp(token));

  harness.setCaptureState("rejected");
  await harness.context.pollPendingInterception(84);
  assert.equal(harness.calls.resume, 1);
});

test("GoFile uses one connection while other hosts retain the configured segment count", async () => {
  const goFile = createHarness({
    cookies: [{ name: "accountToken", value: "segment-test-token" }],
    permissionGranted: true,
    segments: 16,
  });
  await beginPendingCapture(goFile, goFileItem);
  const goFilePost = goFile.requests.find((request) => request.init?.method === "POST");
  const goFilePayload = JSON.parse(String(goFilePost?.init?.body)) as { segments?: number };
  assert.equal(goFilePayload.segments, 1);

  const ordinary = createHarness({ segments: 13 });
  await beginPendingCapture(ordinary, interceptedItem);
  const ordinaryPost = ordinary.requests.find((request) => request.init?.method === "POST");
  const ordinaryPayload = JSON.parse(String(ordinaryPost?.init?.body)) as { segments?: number };
  assert.equal(ordinaryPayload.segments, 13);
});

test("toolbar messages and context menus create confirmations instead of downloads", async () => {
  const harness = createHarness();
  const toolbarResponse = await harness.sendWorkerMessage({
    type: "CREATE_CAPTURE",
    url: "https://example.com/toolbar.zip",
    source: "popup-pasted-url",
  }) as { ok?: boolean };
  await harness.context.handleContextMenuClick({
    menuItemId: "bunni-download-link",
    linkUrl: "https://example.com/context.zip",
  }, {
    url: "https://example.com/",
    incognito: false,
  });

  assert.equal(toolbarResponse.ok, true);
  const posts = harness.requests.filter((request) => request.init?.method === "POST");
  assert.equal(posts.length, 2);
  assert.ok(posts.every((request) => new URL(request.url).pathname === "/api/captures"));
  assert.equal(harness.calls.pause, 0);
  assert.ok(harness.notifications.every((notification) => /Review this download in Bunni/i.test(notification.title)));
});
