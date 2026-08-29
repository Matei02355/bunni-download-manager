import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext, type Context } from "node:vm";

const workerSource = readFileSync("extension/service-worker.js", "utf8");
const CAPTURE_ID = "lifecycle-capture";

interface PendingRecord {
  downloadId: number;
  captureId: string;
  acceptedState?: "" | "accepted" | "accepted-paused";
  createdAt: number;
  deadlineAt: number;
  nextPollAt: number;
  pollFailures: number;
  recoveryAttempts?: number;
  resolution: "awaiting" | "cancel" | "resume";
  notificationOutcome?: string;
  label: string;
  port: number;
}

interface DownloadItem {
  id: number;
  state: "in_progress" | "interrupted" | "complete";
  paused: boolean;
}

interface WorkerContext extends Context {
  recoverPendingInterceptions: () => Promise<void>;
}

function pendingRecord(
  downloadId: number,
  changes: Partial<PendingRecord> = {},
): PendingRecord {
  const now = Date.now();
  return {
    downloadId,
    captureId: CAPTURE_ID,
    createdAt: now,
    deadlineAt: now + 60_000,
    nextPollAt: now,
    pollFailures: 0,
    resolution: "awaiting",
    label: "lifecycle-test.zip",
    port: 17_865,
    ...changes,
  };
}

function captureResponse(state: "pending" | "rejected" = "pending") {
  return new Response(JSON.stringify({
    ok: true,
    capture: {
      id: CAPTURE_ID,
      state,
      download: { id: "prepared-download" },
    },
  }), {
    status: state === "pending" ? 202 : 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(options: {
  cancelFailures?: number;
  fetchFailure?: boolean;
  resumeFailures?: number;
  storageSetFailures?: number;
} = {}) {
  let remainingCancelFailures = options.cancelFailures ?? 0;
  let remainingResumeFailures = options.resumeFailures ?? 0;
  let remainingStorageSetFailures = options.storageSetFailures ?? 0;
  const localState: Record<string, unknown> = {
    autoIntercept: true,
    pendingInterceptions: {},
    port: 17_865,
    segments: 8,
  };
  const downloads = new Map<number, DownloadItem>();
  const notifications: Array<{ id?: string; title: string; message: string }> = [];
  const requests: Array<{ url: string; method: string }> = [];
  const calls = {
    alarmClear: 0,
    alarmCreate: 0,
    alarmWhens: [] as number[],
    cancel: 0,
    erase: 0,
    resume: 0,
  };

  const chrome = {
    alarms: {
      async clear() {
        calls.alarmClear += 1;
        return true;
      },
      create(_name: string, details?: { when?: number }) {
        calls.alarmCreate += 1;
        if (Number.isFinite(details?.when)) calls.alarmWhens.push(details!.when!);
      },
      onAlarm: { addListener() {} },
    },
    contextMenus: {
      create() {},
      onClicked: { addListener() {} },
      async removeAll() {},
    },
    cookies: { async getAll() { return []; } },
    downloads: {
      async cancel(downloadId: number) {
        calls.cancel += 1;
        if (remainingCancelFailures > 0) {
          remainingCancelFailures -= 1;
          throw new Error("Chrome is shutting down");
        }
        const item = downloads.get(downloadId);
        if (item) {
          item.state = "interrupted";
          item.paused = false;
        }
      },
      async erase({ id }: { id: number }) {
        calls.erase += 1;
        downloads.delete(id);
      },
      onCreated: { addListener() {} },
      async pause() {},
      async resume(downloadId: number) {
        calls.resume += 1;
        if (remainingResumeFailures > 0) {
          remainingResumeFailures -= 1;
          throw new Error("Chrome is shutting down");
        }
        const item = downloads.get(downloadId);
        if (item) item.paused = false;
      },
      async search({ id }: { id: number }) {
        const item = downloads.get(id);
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
        notifications.push({
          ...notification,
          id: typeof idOrNotification === "string" ? idOrNotification : undefined,
        });
      },
    },
    permissions: { async contains() { return false; } },
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} },
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
            Object.hasOwn(localState, key) ? localState[key] : fallback,
          ]));
        },
        async set(values: Record<string, unknown>) {
          if (remainingStorageSetFailures > 0) {
            remainingStorageSetFailures -= 1;
            throw new Error("Chrome storage is shutting down");
          }
          Object.assign(localState, values);
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
    fetch: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ url: String(url), method });
      if (options.fetchFailure) throw new TypeError("connection refused");
      return method === "DELETE" ? captureResponse("rejected") : captureResponse("pending");
    },
    performance,
    setTimeout() { return 1; },
  }) as WorkerContext;
  runInContext(workerSource, context, { filename: "extension/service-worker.js" });

  function store(record: PendingRecord) {
    localState.pendingInterceptions = { [String(record.downloadId)]: record };
  }

  return { calls, context, downloads, localState, notifications, requests, store };
}

function pendingCount(localState: Record<string, unknown>) {
  return Object.keys(localState.pendingInterceptions as object).length;
}

async function settleWorkerBootstrap() {
  // service-worker.js performs one recovery pass as soon as it is evaluated.
  // Let that empty bootstrap pass finish before arranging each lifecycle state.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("restart silently forgets an awaiting capture when Chrome's download vanished", async () => {
  const harness = createHarness();
  await settleWorkerBootstrap();
  harness.store(pendingRecord(501));

  await harness.context.recoverPendingInterceptions();
  await harness.context.recoverPendingInterceptions();

  assert.equal(pendingCount(harness.localState), 0, "no stale recovery record may survive");
  assert.equal(harness.notifications.length, 0, "a vanished Chrome record is not a new user-facing error");
  assert.equal(harness.calls.resume, 0, "there is no Chrome download left to resume");
  assert.ok(harness.calls.alarmClear > 0, "the recovery alarm is cleared after cleanup");
});

test("interrupted and completed Chrome downloads are terminal, quiet cleanup states", async (t) => {
  for (const state of ["interrupted", "complete"] as const) {
    await t.test(state, async () => {
      const harness = createHarness();
      await settleWorkerBootstrap();
      harness.downloads.set(502, { id: 502, state, paused: false });
      harness.store(pendingRecord(502));

      await harness.context.recoverPendingInterceptions();
      await harness.context.recoverPendingInterceptions();

      assert.equal(pendingCount(harness.localState), 0);
      assert.equal(harness.notifications.length, 0);
      assert.equal(harness.calls.resume, 0);
      assert.equal(harness.calls.cancel, 0);
    });
  }
});

test("an already-unpaused Chrome download is no longer owned by the capture", async () => {
  const harness = createHarness();
  await settleWorkerBootstrap();
  harness.downloads.set(506, { id: 506, state: "in_progress", paused: false });
  harness.store(pendingRecord(506));

  await harness.context.recoverPendingInterceptions();
  await harness.context.recoverPendingInterceptions();

  assert.equal(pendingCount(harness.localState), 0);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.calls.resume, 0);
  assert.equal(harness.calls.cancel, 0);
});

test("a live paused original remains recoverable while Bunni's choice is pending", async () => {
  const harness = createHarness();
  await settleWorkerBootstrap();
  harness.downloads.set(503, { id: 503, state: "in_progress", paused: true });
  harness.store(pendingRecord(503));

  await harness.context.recoverPendingInterceptions();
  await harness.context.recoverPendingInterceptions();

  assert.equal(pendingCount(harness.localState), 1);
  assert.equal(harness.downloads.get(503)?.paused, true);
  assert.equal(harness.notifications.length, 0);
  assert.ok(harness.calls.alarmCreate > 0);
});

test("desktop outage resumes once and repeated recovery cannot repeat its error", async () => {
  const harness = createHarness({ fetchFailure: true });
  await settleWorkerBootstrap();
  harness.downloads.set(504, { id: 504, state: "in_progress", paused: true });
  harness.store(pendingRecord(504, { pollFailures: 3 }));

  await harness.context.recoverPendingInterceptions();
  await harness.context.recoverPendingInterceptions();
  await harness.context.recoverPendingInterceptions();

  assert.equal(harness.downloads.get(504)?.paused, false, "Chrome must never stay paused");
  assert.equal(pendingCount(harness.localState), 0, "successful resume durably removes recovery state");
  assert.equal(harness.calls.resume, 1);
  assert.ok(harness.notifications.length <= 1, "repeated alarms must not repeat the same notification");
});

test("a transient Chrome resume failure stays durable until a later alarm succeeds", async () => {
  const harness = createHarness({ resumeFailures: 1 });
  await settleWorkerBootstrap();
  harness.downloads.set(505, { id: 505, state: "in_progress", paused: true });
  harness.store(pendingRecord(505, { captureId: "", resolution: "resume" }));

  await harness.context.recoverPendingInterceptions();
  assert.equal(pendingCount(harness.localState), 1, "failed resume must remain recoverable");
  assert.equal(harness.downloads.get(505)?.paused, true);
  assert.ok(harness.calls.alarmCreate > 0);

  (harness.localState.pendingInterceptions as Record<string, PendingRecord>)["505"].nextPollAt = 0;
  await harness.context.recoverPendingInterceptions();
  await harness.context.recoverPendingInterceptions();
  assert.equal(pendingCount(harness.localState), 0);
  assert.equal(harness.downloads.get(505)?.paused, false);
  assert.equal(harness.calls.resume, 2);
  assert.equal(harness.notifications.length, 0, "background resume retries stay quiet");
});

test("resume recovery alarms honor their persisted retry time instead of hot-looping", async () => {
  const harness = createHarness({ resumeFailures: 1 });
  await settleWorkerBootstrap();
  harness.downloads.set(508, { id: 508, state: "in_progress", paused: true });
  harness.store(pendingRecord(508, { captureId: "", resolution: "resume" }));

  await harness.context.recoverPendingInterceptions();

  const stored = (harness.localState.pendingInterceptions as Record<string, PendingRecord>)["508"];
  assert.ok(stored, "failed recovery remains durable");
  assert.ok(harness.calls.alarmWhens.length > 0);
  assert.ok(
    harness.calls.alarmWhens.every((when) => when >= stored.nextPollAt),
    "every re-armed alarm must respect the 15-second recovery backoff",
  );
});

test("an accepted Bunni decision never downgrades to resume when Chrome cancellation fails", async () => {
  const harness = createHarness({ cancelFailures: 1 });
  await settleWorkerBootstrap();
  harness.downloads.set(508, { id: 508, state: "in_progress", paused: true });
  harness.store(pendingRecord(508, {
    acceptedState: "accepted-paused",
    captureId: CAPTURE_ID,
    nextPollAt: 0,
    resolution: "cancel",
  }));

  await harness.context.recoverPendingInterceptions();
  const pending = (harness.localState.pendingInterceptions as Record<string, PendingRecord>)["508"];
  assert.equal(pending.resolution, "cancel");
  assert.equal(pending.acceptedState, "accepted-paused");
  assert.equal(harness.calls.resume, 0, "accepted downloads must never restore Chrome's duplicate");
  assert.equal(harness.calls.cancel, 1);

  pending.nextPollAt = 0;
  await harness.context.recoverPendingInterceptions();
  assert.equal(pendingCount(harness.localState), 0);
  assert.equal(harness.calls.cancel, 2);
  assert.equal(harness.calls.erase, 1);
  assert.equal(harness.calls.resume, 0);
  assert.match(harness.notifications.at(-1)?.title ?? "", /later/i);
  assert.equal(
    new Set(harness.notifications.map((notification) => notification.id)).size,
    1,
    "failure and recovery update one stable notification instead of stacking IDs",
  );
});

test("shutdown-time storage failures cannot replay the same recovery notification", async () => {
  const harness = createHarness({ fetchFailure: true, storageSetFailures: 2 });
  await settleWorkerBootstrap();
  harness.downloads.set(507, { id: 507, state: "in_progress", paused: true });
  harness.store(pendingRecord(507, { pollFailures: 3 }));

  // Simulate Chrome beginning shutdown: the original is restored, but both
  // writes that would mark/forget the record fail before the worker is killed.
  await harness.context.recoverPendingInterceptions();
  assert.equal(harness.downloads.get(507)?.paused, false);
  assert.equal(harness.notifications.length, 1);
  assert.equal(pendingCount(harness.localState), 1);

  // A restarted worker sees the stale record. It must reconcile the already
  // unpaused Chrome item and clean up without replaying the same error.
  await harness.context.recoverPendingInterceptions();
  await harness.context.recoverPendingInterceptions();
  assert.equal(pendingCount(harness.localState), 0);
  assert.ok(harness.notifications.length <= 1, "one incident produces at most one visible notification");
});
