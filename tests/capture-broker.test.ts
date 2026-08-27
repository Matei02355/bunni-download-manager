import assert from "node:assert/strict";
import { test } from "node:test";
import { CaptureBroker } from "../src/main/capture-broker";

interface Request {
  url: string;
}

interface Download {
  id: string;
  status: string;
  fileName: string;
  destination: string;
  error: string | null;
}

function download(id: string): Download {
  return {
    id,
    status: "paused",
    fileName: `${id}.zip`,
    destination: `C:\\Downloads\\${id}.zip`,
    error: null
  };
}

function harness(overrides: Partial<{
  maxEntries: number;
  pendingTtlMs: number;
  terminalTtlMs: number;
}> = {}) {
  let nextId = 1;
  const calls: string[] = [];
  const requested: string[] = [];
  const records = new Map<string, Download>();
  const broker = new CaptureBroker<Request, Download>({
    ...overrides,
    createPaused: async () => {
      const record = download(`capture-${nextId++}`);
      records.set(record.id, record);
      calls.push(`create:${record.id}`);
      return record;
    },
    retarget: async (id, target) => {
      calls.push(`retarget:${id}`);
      const record = records.get(id)!;
      if (target.fileName) record.fileName = target.fileName;
      if (target.directory) record.destination = `${target.directory}\\${record.fileName}`;
      return { ...record };
    },
    resume: async (id) => {
      calls.push(`resume:${id}`);
      const record = records.get(id)!;
      record.status = "queued";
      return { ...record };
    },
    remove: async (id) => {
      calls.push(`remove:${id}`);
      records.delete(id);
    },
    onRequested: (capture) => requested.push(capture.id)
  });
  return { broker, calls, records, requested };
}

test("create prepares and emits a pending capture", async () => {
  const { broker, calls, requested } = harness();
  const capture = await broker.create({ url: "https://example.com/file.zip" });
  assert.equal(capture.state, "pending");
  assert.equal(capture.download.status, "paused");
  assert.deepEqual(calls, ["create:capture-1"]);
  assert.deepEqual(requested, ["capture-1"]);
  await broker.shutdown();
});

test("failed admission is reported but removed from the manager queue", async () => {
  const calls: string[] = [];
  const failed = { ...download("capture-failed"), status: "error", error: "session required" };
  const broker = new CaptureBroker<Request, Download>({
    createPaused: async () => failed,
    retarget: async () => failed,
    resume: async () => failed,
    remove: async (id) => { calls.push(`remove:${id}`); },
    onRequested: () => { throw new Error("failed captures must not open a dialog"); }
  });

  const capture = await broker.create({ url: "https://example.com/protected.zip" });
  assert.equal(capture.state, "error");
  assert.equal(capture.download.error, "session required");
  assert.deepEqual(calls, ["remove:capture-failed"]);
  await broker.shutdown();
});

test("start retargets before resuming and marks the capture accepted", async () => {
  const { broker, calls } = harness();
  const pending = await broker.create({ url: "https://example.com/file.zip" });
  const accepted = await broker.respond({
    id: pending.id,
    action: "start",
    fileName: "chosen.zip",
    directory: "D:\\Files"
  });
  assert.equal(accepted?.state, "accepted");
  assert.equal(accepted?.download.status, "queued");
  assert.equal(accepted?.download.fileName, "chosen.zip");
  assert.deepEqual(calls, [
    "create:capture-1",
    "retarget:capture-1",
    "resume:capture-1"
  ]);
  await broker.shutdown();
});

test("later retargets but leaves the prepared download paused", async () => {
  const { broker, calls } = harness();
  const pending = await broker.create({ url: "https://example.com/file.zip" });
  const accepted = await broker.respond({ id: pending.id, action: "later" });
  assert.equal(accepted?.state, "accepted-paused");
  assert.equal(accepted?.download.status, "paused");
  assert.deepEqual(calls, ["create:capture-1", "retarget:capture-1"]);
  await broker.shutdown();
});

test("cancel removes the prepared download and marks the capture rejected", async () => {
  const { broker, calls, records } = harness();
  const pending = await broker.create({ url: "https://example.com/file.zip" });
  const rejected = await broker.reject(pending.id);
  assert.equal(rejected?.state, "rejected");
  assert.equal(records.has(pending.id), false);
  assert.deepEqual(calls, ["create:capture-1", "remove:capture-1"]);
  await broker.shutdown();
});

test("a response failure becomes terminal error and cleans up the paused entry", async () => {
  const calls: string[] = [];
  const broker = new CaptureBroker<Request, Download>({
    createPaused: async () => download("capture-error"),
    retarget: async () => {
      calls.push("retarget");
      throw new Error("destination unavailable");
    },
    resume: async () => {
      calls.push("resume");
      return download("capture-error");
    },
    remove: async () => { calls.push("remove"); },
    onRequested: () => undefined
  });
  await broker.create({ url: "https://example.com/file.zip" });
  await assert.rejects(
    broker.respond({ id: "capture-error", action: "start" }),
    /destination unavailable/
  );
  assert.equal(broker.get("capture-error")?.state, "error");
  assert.deepEqual(calls, ["retarget", "remove"]);
  await broker.shutdown();
});

test("the first concurrent decision wins", async () => {
  let releaseRetarget!: () => void;
  const gate = new Promise<void>((resolve) => { releaseRetarget = resolve; });
  const calls: string[] = [];
  const record = download("capture-race");
  const broker = new CaptureBroker<Request, Download>({
    createPaused: async () => record,
    retarget: async () => {
      calls.push("retarget");
      await gate;
      return record;
    },
    resume: async () => {
      calls.push("resume");
      return { ...record, status: "queued" };
    },
    remove: async () => { calls.push("remove"); },
    onRequested: () => undefined
  });
  await broker.create({ url: "https://example.com/file.zip" });
  const start = broker.respond({ id: record.id, action: "start" });
  const cancel = broker.reject(record.id);
  releaseRetarget();
  const [started, cancelled] = await Promise.all([start, cancel]);
  assert.equal(started?.state, "accepted");
  assert.equal(cancelled?.state, "accepted");
  assert.deepEqual(calls, ["retarget", "resume"]);
  await broker.shutdown();
});

test("capacity evicts the oldest pending capture safely", async () => {
  const { broker, calls } = harness({ maxEntries: 1 });
  const first = await broker.create({ url: "https://example.com/one.zip" });
  const second = await broker.create({ url: "https://example.com/two.zip" });
  assert.equal(broker.get(first.id), undefined);
  assert.equal(broker.get(second.id)?.state, "pending");
  assert.deepEqual(calls, [
    "create:capture-1",
    "remove:capture-1",
    "create:capture-2"
  ]);
  await broker.shutdown();
});

test("pending captures expire by rejecting the prepared download", async () => {
  const { broker, calls } = harness({ pendingTtlMs: 5, terminalTtlMs: 50 });
  const capture = await broker.create({ url: "https://example.com/file.zip" });
  await waitFor(() => broker.get(capture.id)?.state === "rejected");
  assert.equal(calls.includes(`remove:${capture.id}`), true);
  await broker.shutdown();
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for capture state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
