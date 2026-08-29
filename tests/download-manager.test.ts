import * as assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DownloadManager,
  type DownloadManagerOptions,
  type DownloadRecord,
} from "../src/main/download-manager";

interface TestServer {
  server: http.Server;
  url: string;
}

test("downloads and combines parallel byte ranges", async () => {
  const source = patternedBuffer(768 * 1024);
  const remote = await startRangeServer(source, 0, "range-result.bin");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-range-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );

    assert.equal(completed.fileName, "range-result.bin");
    assert.equal(completed.status, "completed");
    assert.equal(completed.progress, 100);
    assert.equal(completed.bytesReceived, source.length);
    assert.equal(completed.totalBytes, source.length);
    assert.equal(completed.segments.length, 4);
    assert.ok(completed.segments.every((segment) => segment.status === "completed"));
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("GoFile serializes ranges and survives more than the normal HTTP 429 retry limit", async () => {
  const source = patternedBuffer(768 * 1024);
  let rateLimits = 0;
  let activeTransfers = 0;
  let peakTransfers = 0;
  const server = http.createServer((request, response) => {
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=gofile-rate.bin",
      ETag: '"gofile-rate-v1"',
    };
    if (request.method === "HEAD") {
      response.writeHead(200, { ...headers, "Content-Length": source.length });
      response.end();
      return;
    }
    const range = parseRange(request.headers.range, source.length);
    assert.ok(range);
    const isAdmissionProbe = range.start === 0 && range.end === 0;
    if (!isAdmissionProbe && rateLimits < 5) {
      rateLimits += 1;
      response.writeHead(429, { "Retry-After": "0", "Content-Length": 0 });
      response.end();
      return;
    }
    const body = source.subarray(range.start, range.end + 1);
    if (!isAdmissionProbe) {
      activeTransfers += 1;
      peakTransfers = Math.max(peakTransfers, activeTransfers);
      response.once("finish", () => {
        activeTransfers -= 1;
      });
    }
    response.writeHead(206, {
      ...headers,
      "Content-Length": body.length,
      "Content-Range": `bytes ${range.start}-${range.end}/${source.length}`,
    });
    if (isAdmissionProbe) response.end(body);
    else setTimeout(() => response.end(body), 15);
  });
  const remote = await listen(server);
  const goFileUrl = new URL(remote.url);
  goFileUrl.hostname = "store1.gofile.io";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-gofile-rate-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await withLocalGoFileDns(async () => {
      await manager.init();
      const added = await manager.add({ url: goFileUrl.toString(), segments: 4 });
      const completed = await waitForRecord(
        manager,
        added.id,
        (record) => record.status === "completed",
      );
      assert.equal(rateLimits, 5, "429 responses beyond the normal retry limit should recover");
      assert.equal(peakTransfers, 1, "GoFile range bodies must never overlap");
      assert.equal(completed.segments.length, 4, "serialization must not collapse topology");
      assert.deepEqual(await fs.readFile(completed.destination), source);
    });
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a verified GoFile orphan keeps its partial topology across a one-part recapture", async () => {
  const source = patternedBuffer(2 * 1024 * 1024);
  const remote = await startRangeServer(source, 2, "gofile-orphan.bin");
  const goFileUrl = new URL(remote.url);
  goFileUrl.hostname = "store1.gofile.io";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-gofile-orphan-"));
  const dataDir = path.join(root, "state");
  const originalDirectory = path.join(root, "destination-drive");
  const recaptureDirectory = path.join(root, "new-default-directory");
  let manager = new DownloadManager({
    dataDir,
    downloadDir: originalDirectory,
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await withLocalGoFileDns(async () => {
      await manager.init();
      const original = await manager.add({ url: goFileUrl.toString(), segments: 4 });
      await waitForRecord(
        manager,
        original.id,
        (record) => record.status === "downloading" && record.bytesReceived >= 64 * 1024,
      );
      const paused = await manager.pause(original.id);
      assert.equal(paused.segments.length, 4);
      const partialBytes = paused.bytesReceived;
      assert.ok(partialBytes > 0);
      await manager.shutdown();

      const task = path.join(originalDirectory, ".bunni-parts", original.id);
      const legacyTask = path.join(dataDir, ".bunni", original.id);
      await fs.mkdir(path.dirname(legacyTask), { recursive: true });
      await fs.rename(task, legacyTask);
      const emptyState = '{\n  "version": 1,\n  "entries": []\n}\n';
      await fs.writeFile(path.join(dataDir, "downloads.json"), emptyState, "utf8");
      await fs.writeFile(path.join(dataDir, "downloads.json.bak"), emptyState, "utf8");

      manager = new DownloadManager({
        dataDir,
        downloadDir: recaptureDirectory,
        maxConcurrent: 1,
        defaultSegments: 1,
      });
      await manager.init();
      const adopted = await manager.add({
        url: goFileUrl.toString(),
        directory: recaptureDirectory,
        segments: 1,
        startPaused: true,
      });
      assert.equal(adopted.id, original.id);
      assert.equal(adopted.destination, original.destination);
      assert.equal(adopted.segments.length, 4);
      assert.ok(adopted.bytesReceived >= partialBytes);
      const confirmed = await manager.retarget(adopted.id, {
        fileName: adopted.fileName,
        directory: path.dirname(adopted.destination),
      });
      assert.equal(confirmed.id, adopted.id);

      await manager.resume(adopted.id);
      const completed = await waitForRecord(
        manager,
        adopted.id,
        (record) => record.status === "completed",
      );
      assert.equal(completed.segments.length, 4);
      assert.deepEqual(await fs.readFile(completed.destination), source);
      await assert.rejects(fs.stat(legacyTask), { code: "ENOENT" });
    });
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("falls back to a single stream when Range is ignored", async () => {
  const source = patternedBuffer(257 * 1024 + 13);
  const remote = await startNonRangeServer(source);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-single-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 6,
  });

  try {
    await manager.init();
    const added = await manager.add({
      url: remote.url,
      fileName: "single.bin",
      segments: 6,
    });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );

    assert.equal(completed.segments.length, 1);
    assert.equal(completed.totalBytes, source.length);
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("treats a server that advertises but ignores ranges as a single stream", async () => {
  const source = patternedBuffer(193 * 1024 + 7);
  const remote = await startNonRangeServer(source, true);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-false-range-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 6,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, fileName: "false-range.bin" });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );

    assert.equal(completed.segments.length, 1);
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("falls back safely when the range probe has an invalid Content-Range", async () => {
  const source = patternedBuffer(129 * 1024 + 3);
  const server = http.createServer((request, response) => {
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      ETag: '"malformed-range"',
    };
    if (request.method === "HEAD") {
      response.writeHead(200, { ...headers, "Content-Length": source.length });
      response.end();
    } else if (request.headers.range) {
      response.writeHead(206, {
        ...headers,
        "Content-Length": 1,
        // The request is bytes=0-0; this range is deliberately outside it.
        "Content-Range": `bytes 1-1/${source.length}`,
      });
      response.end(source.subarray(1, 2));
    } else {
      response.writeHead(200, { ...headers, "Content-Length": source.length });
      response.end(source);
    }
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-invalid-range-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, fileName: "invalid-range.bin" });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.equal(completed.segments.length, 1);
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("downloads an empty file", async () => {
  const remote = await startRangeServer(Buffer.alloc(0), 0, "empty.bin");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-empty-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.equal(completed.totalBytes, 0);
    assert.equal(completed.bytesReceived, 0);
    assert.equal(completed.progress, 100);
    assert.equal((await fs.stat(completed.destination)).size, 0);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("startPaused admits a download without starting it until resume", async () => {
  const source = patternedBuffer(384 * 1024 + 17);
  const requests: Array<{ method?: string; range?: string }> = [];
  const remote = await startRangeServer(source, 0, "later-result.bin", (request) => {
    requests.push({ method: request.method, range: request.headers.range });
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-start-paused-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, startPaused: true });

    assert.equal(added.status, "paused");
    assert.equal(added.fileName, "later-result.bin");
    assert.equal(added.totalBytes, source.length);
    assert.equal(added.mime, "application/octet-stream");
    assert.equal(added.bytesReceived, 0);
    assert.deepEqual(added.segments, []);
    const admissionRequests = requests.length;
    assert.ok(admissionRequests >= 2, "admission should validate HEAD and GET");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(
      requests.length,
      admissionRequests,
      "a paused admission must not start transfer requests",
    );
    await assert.rejects(fs.stat(added.destination), { code: "ENOENT" });

    await manager.resume(added.id);
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.ok(requests.length > admissionRequests);
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("retarget changes an unstarted paused destination and rejects a started record", async () => {
  const source = patternedBuffer(160 * 1024 + 29);
  const remote = await startRangeServer(source, 0, "original.bin");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-retarget-"));
  const downloadDir = path.join(root, "downloads");
  const selectedDirectory = path.join(root, "selected", "nested");
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir,
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, startPaused: true });
    await fs.mkdir(selectedDirectory, { recursive: true });
    await fs.writeFile(path.join(selectedDirectory, "renamed_.bin"), "occupied", "utf8");

    const retargeted = await manager.retarget(added.id, {
      fileName: "../renamed?.bin",
      directory: selectedDirectory,
    });
    assert.equal(retargeted.status, "paused");
    assert.equal(retargeted.fileName, "renamed_ (1).bin");
    assert.equal(
      retargeted.destination,
      path.join(selectedDirectory, "renamed_ (1).bin"),
    );

    const metadata = await fs.readFile(path.join(root, "state", "downloads.json"), "utf8");
    assert.match(metadata, /renamed_ \(1\)\.bin/);

    await manager.resume(added.id);
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.equal(completed.destination, retargeted.destination);
    assert.deepEqual(await fs.readFile(completed.destination), source);
    await assert.rejects(
      manager.retarget(added.id, { fileName: "too-late.bin" }),
      /paused, unstarted/i,
    );
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bounds the admission probe below the Chrome handoff timeout", async () => {
  let requests = 0;
  const server = http.createServer(() => {
    requests += 1;
    // Deliberately never send response headers.
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-probe-timeout-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const startedAt = Date.now();
    const added = await manager.add({ url: remote.url, fileName: "stalled.bin" });
    const elapsed = Date.now() - startedAt;

    assert.equal(added.status, "error");
    assert.match(added.error ?? "", /initial download check timed out/i);
    assert.ok(elapsed < 10_000, `admission took ${elapsed}ms`);
    assert.equal(requests, 1, "the bounded admission gate must not retry");
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects a GoFile-like binary URL that redirects to an HTML landing page", async () => {
  const landingPage = Buffer.from("<!doctype html><title>Download page</title>");
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/download/web/")) {
      response.writeHead(302, { Location: "/d/shared-folder" });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": landingPage.length,
    });
    if (request.method === "HEAD") response.end();
    else response.end(landingPage);
  });
  const remote = await listen(server);
  const directUrl = new URL(
    "/download/web/shared-folder/archive.rar",
    remote.url,
  ).toString();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-html-fallback-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: directUrl, startPaused: true });
    assert.equal(added.status, "error");
    assert.match(added.error ?? "", /web page.*expired.*browser session/i);
    assert.equal(added.fileName, "archive.rar");
    await assert.rejects(fs.stat(added.destination), { code: "ENOENT" });
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects HTML returned after a binary non-range HEAD probe", async () => {
  const expectedLength = 256 * 1024;
  const landingPage = Buffer.from("<!doctype html><title>Session required</title>");
  const server = http.createServer((request, response) => {
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": expectedLength,
      });
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Content-Length": landingPage.length,
    });
    response.end(landingPage);
  });
  const remote = await listen(server);
  const fileUrl = new URL("/payload.bin", remote.url).toString();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-head-html-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 1,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: fileUrl, segments: 1 });
    assert.equal(added.status, "error", "add() must reject before browser hand-off");
    assert.match(added.error ?? "", /web page.*expired.*browser session/i);
    assert.equal(added.totalBytes, expectedLength);
    assert.equal(added.bytesReceived, 0);
    await assert.rejects(fs.stat(added.destination), { code: "ENOENT" });
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not let a successful HEAD mask GET authorization failures", async () => {
  for (const status of [401, 403]) {
    const server = http.createServer((request, response) => {
      if (request.method === "HEAD") {
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": 64 * 1024,
        });
        response.end();
        return;
      }
      response.writeHead(status, { "Content-Type": "text/plain", "Content-Length": 0 });
      response.end();
    });
    const remote = await listen(server);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `bunni-get-${status}-`));
    const manager = new DownloadManager({
      dataDir: path.join(root, "state"),
      downloadDir: path.join(root, "downloads"),
      maxConcurrent: 1,
      defaultSegments: 1,
    });
    try {
      await manager.init();
      const added = await manager.add({
        url: new URL("/protected.bin", remote.url).toString(),
        segments: 1,
      });
      assert.equal(added.status, "error");
      assert.match(added.error ?? "", new RegExp(`HTTP ${status}`));
    } finally {
      await manager.shutdown();
      await closeServer(server);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("validates a full GET after the server rejects the range probe", async () => {
  const source = patternedBuffer(48 * 1024 + 3);
  const server = http.createServer((request, response) => {
    const commonHeaders = {
      "Content-Type": "application/octet-stream",
      "Content-Length": source.length,
    };
    if (request.method === "HEAD") {
      response.writeHead(200, commonHeaders);
      response.end();
    } else if (request.headers.range) {
      response.writeHead(400, { "Content-Length": 0 });
      response.end();
    } else {
      response.writeHead(200, commonHeaders);
      response.end(source);
    }
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-range-reject-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });
  try {
    await manager.init();
    const added = await manager.add({
      url: new URL("/range-rejected.bin", remote.url).toString(),
    });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.equal(completed.segments.length, 1);
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preserves and validates a known non-range size", async () => {
  const expectedLength = 128 * 1024;
  const replacement = patternedBuffer(4 * 1024);
  const server = http.createServer((request, response) => {
    const length = request.method === "HEAD" ? expectedLength : replacement.length;
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": length,
    });
    if (request.method === "HEAD") response.end();
    else response.end(replacement);
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-size-change-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 1,
  });

  try {
    await manager.init();
    const added = await manager.add({
      url: new URL("/payload.bin", remote.url).toString(),
      segments: 1,
    });
    const failed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "error",
    );
    assert.match(failed.error ?? "", /returned 4096 bytes; expected 131072/i);
    assert.equal(failed.totalBytes, expectedLength);
    assert.equal(failed.bytesReceived, 0);
    await assert.rejects(fs.stat(failed.destination), { code: "ENOENT" });
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("allows a genuine HTML download", async () => {
  const page = Buffer.from("<!doctype html><html><body>Bunni page</body></html>");
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": page.length,
    });
    if (request.method === "HEAD") response.end();
    else response.end(page);
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-html-page-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({
      url: new URL("/article.html", remote.url).toString(),
    });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.equal(completed.mime, "text/html");
    assert.deepEqual(await fs.readFile(completed.destination), page);
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects a final redirect that differs from the probe", async () => {
  const source = patternedBuffer(32 * 1024);
  let sourceGets = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/mirror-a.bin" || request.url === "/mirror-b.bin") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": source.length,
      });
      if (request.method === "HEAD") response.end();
      else response.end(source);
      return;
    }
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": source.length,
      });
      response.end();
      return;
    }
    sourceGets += 1;
    response.writeHead(302, {
      // Admission and the run-time probe agree on A; only the actual transfer
      // changes to B, which must be rejected before publication.
      Location: sourceGets < 3 ? "/mirror-a.bin" : "/mirror-b.bin",
    });
    response.end();
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-redirect-change-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 1,
  });

  try {
    await manager.init();
    const added = await manager.add({
      url: new URL("/payload.bin", remote.url).toString(),
      segments: 1,
    });
    const failed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "error",
    );
    assert.match(failed.error ?? "", /redirected to a different resource/i);
    await assert.rejects(fs.stat(failed.destination), { code: "ENOENT" });
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("protects credentials across restart and restores them for segmented resume", async () => {
  const source = patternedBuffer(4 * 1024 * 1024);
  const cookie = "session=restart-secret";
  const remote = await startCookieRangeServer(source, cookie, 3);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-protected-restart-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  const protection = fakeCredentialProtection();
  let manager = new DownloadManager({
    dataDir,
    downloadDir,
    maxConcurrent: 1,
    defaultSegments: 4,
    ...protection,
  });

  try {
    await manager.init();
    const added = await manager.add({
      url: remote.url,
      fileName: "protected-resume.bin",
      segments: 4,
      headers: { Cookie: cookie },
    });
    await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "downloading" && record.bytesReceived >= 128 * 1024,
    );
    const paused = await manager.pause(added.id);
    assert.equal(paused.status, "paused");
    await manager.shutdown();

    const metadataPath = path.join(dataDir, "downloads.json");
    const beforeRestart = await fs.readFile(metadataPath, "utf8");
    assert.doesNotMatch(beforeRestart, /restart-secret/);
    const persisted = JSON.parse(beforeRestart) as {
      entries: Array<{ protectedHeaders?: string; headers: Record<string, string> }>;
    };
    assert.match(persisted.entries[0]?.protectedHeaders ?? "", /^fake-sealed:/);
    assert.equal(persisted.entries[0]?.headers.Cookie, undefined);

    manager = new DownloadManager({
      dataDir,
      downloadDir,
      maxConcurrent: 1,
      defaultSegments: 4,
      ...protection,
    });
    await manager.init();
    const restored = manager.list().find((record) => record.id === added.id);
    assert.ok(restored);
    assert.equal(restored.status, "paused");
    await manager.resume(added.id);
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
      20_000,
    );
    assert.deepEqual(await fs.readFile(completed.destination), source);
    await manager.shutdown();

    const afterCompletion = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
      entries: Array<{ protectedHeaders?: string }>;
    };
    assert.equal(afterCompletion.entries[0]?.protectedHeaders, undefined);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("preserves protected credentials for a startPaused download across restart", async () => {
  const source = patternedBuffer(320 * 1024 + 7);
  const cookie = "session=later-secret";
  let requestCount = 0;
  const remote = await startCookieRangeServer(source, cookie, 0, () => {
    requestCount += 1;
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-protected-later-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  const protection = fakeCredentialProtection();
  let manager = new DownloadManager({
    dataDir,
    downloadDir,
    maxConcurrent: 1,
    defaultSegments: 4,
    ...protection,
  });

  try {
    await manager.init();
    const added = await manager.add({
      url: remote.url,
      fileName: "protected-later.bin",
      headers: { Cookie: cookie },
      segments: 4,
      startPaused: true,
    });
    assert.equal(added.status, "paused");
    const admissionRequests = requestCount;
    await manager.shutdown();

    const metadataPath = path.join(dataDir, "downloads.json");
    const metadata = await fs.readFile(metadataPath, "utf8");
    assert.doesNotMatch(metadata, /later-secret/);
    const persisted = JSON.parse(metadata) as {
      entries: Array<{ protectedHeaders?: string; headers: Record<string, string> }>;
    };
    assert.match(persisted.entries[0]?.protectedHeaders ?? "", /^fake-sealed:/);
    assert.equal(persisted.entries[0]?.headers.Cookie, undefined);

    manager = new DownloadManager({
      dataDir,
      downloadDir,
      maxConcurrent: 1,
      defaultSegments: 4,
      ...protection,
    });
    await manager.init();
    const restored = manager.list().find((record) => record.id === added.id);
    assert.ok(restored);
    assert.equal(restored.status, "paused");
    assert.equal(restored.bytesReceived, 0);
    assert.deepEqual(restored.segments, []);
    assert.equal(requestCount, admissionRequests, "restart must not start a Later download");

    await manager.resume(added.id);
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.ok(requestCount > admissionRequests);
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fails closed when protected credential metadata is corrupt", async () => {
  const source = patternedBuffer(3 * 1024 * 1024);
  const cookie = "session=corruption-secret";
  let requestCount = 0;
  const remote = await startCookieRangeServer(source, cookie, 3, () => {
    requestCount += 1;
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-protected-corrupt-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  const protection = fakeCredentialProtection();
  let manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1, ...protection });

  try {
    await manager.init();
    const added = await manager.add({
      url: remote.url,
      fileName: "corrupt-resume.bin",
      segments: 4,
      headers: { Cookie: cookie },
    });
    await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "downloading" && record.bytesReceived >= 64 * 1024,
    );
    await manager.pause(added.id);
    await manager.shutdown();

    const metadataPath = path.join(dataDir, "downloads.json");
    const backupPath = `${metadataPath}.bak`;
    const corrupt = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
      entries: Array<{ protectedHeaders?: string }>;
    };
    assert.ok(corrupt.entries[0]);
    corrupt.entries[0].protectedHeaders = "corrupt-payload";
    const corruptText = `${JSON.stringify(corrupt, null, 2)}\n`;
    await fs.writeFile(metadataPath, corruptText, "utf8");
    await fs.writeFile(backupPath, corruptText, "utf8");

    requestCount = 0;
    manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1, ...protection });
    await manager.init();
    const restored = manager.list().find((record) => record.id === added.id);
    assert.ok(restored);
    assert.equal(restored.status, "error");
    assert.match(restored.error ?? "", /credentials could not be restored/i);
    assert.equal(requestCount, 0, "corrupt credentials must never start a request");
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rolls back an add when credential protection fails", async () => {
  const source = patternedBuffer(16 * 1024);
  const remote = await startNonRangeServer(source);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-protect-failure-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    protectSensitiveHeaders() {
      throw new Error("fake encryption unavailable");
    },
    unprotectSensitiveHeaders() {
      return {};
    },
  });
  try {
    await manager.init();
    await assert.rejects(
      manager.add({
        url: remote.url,
        fileName: "protected.bin",
        headers: { Cookie: "session=must-not-queue" },
      }),
      /could not be protected/i,
    );
    assert.deepEqual(manager.list(), []);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("uses in-memory credentials for ranges but never persists or reloads them", async () => {
  const source = patternedBuffer(384 * 1024 + 17);
  const requiredCookie = "session=secret-cookie-value";
  const observedHeaders: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((request, response) => {
    observedHeaders.push({ ...request.headers });
    if (request.headers.cookie !== requiredCookie) {
      const denied = Buffer.from("<!doctype html><title>Sign in</title>");
      response.writeHead(401, {
        "Content-Type": "text/html",
        "Content-Length": denied.length,
      });
      if (request.method === "HEAD") response.end();
      else response.end(denied);
      return;
    }

    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=private.bin",
      "Content-Length": source.length,
      ETag: '"private-v1"',
    };
    if (request.method === "HEAD") {
      response.writeHead(200, commonHeaders);
      response.end();
      return;
    }
    const range = parseRange(request.headers.range, source.length);
    if (!range) {
      response.writeHead(200, commonHeaders);
      response.end(source);
      return;
    }
    const body = source.subarray(range.start, range.end + 1);
    response.writeHead(206, {
      ...commonHeaders,
      "Content-Length": body.length,
      "Content-Range": `bytes ${range.start}-${range.end}/${source.length}`,
    });
    response.end(body);
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-private-headers-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  let manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1 });

  try {
    await manager.init();
    const added = await manager.add({
      url: new URL("/private.bin", remote.url).toString(),
      segments: 4,
      headers: {
        Cookie: requiredCookie,
        Authorization: "Bearer secret-authorization-value",
        "Proxy-Authorization": "Basic secret-proxy-value",
        "X-Bunni-Test": "safe-to-persist",
      },
    });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.equal(completed.segments.length, 4);
    assert.deepEqual(await fs.readFile(completed.destination), source);
    assert.ok(observedHeaders.some((headers) => headers.cookie === requiredCookie));
    assert.ok(
      observedHeaders.some(
        (headers) => headers.authorization === "Bearer secret-authorization-value",
      ),
    );

    await manager.shutdown();
    const metadataPath = path.join(dataDir, "downloads.json");
    const backupPath = `${metadataPath}.bak`;
    for (const metadataFile of [metadataPath, backupPath]) {
      const text = await fs.readFile(metadataFile, "utf8");
      assert.doesNotMatch(text, /cookie|authorization|secret-cookie|secret-proxy/i);
      assert.match(text, /safe-to-persist/);
    }

    const legacy = JSON.parse(await fs.readFile(metadataPath, "utf8")) as {
      entries: Array<{
        record: { status: string; error: string | null };
        headers: Record<string, string>;
      }>;
    };
    assert.ok(legacy.entries[0]);
    legacy.entries[0].record.status = "error";
    legacy.entries[0].record.error = "retry legacy entry";
    Object.assign(legacy.entries[0].headers, {
      Cookie: "legacy-cookie-secret",
      Authorization: "Bearer legacy-auth-secret",
      "Proxy-Authorization": "Basic legacy-proxy-secret",
    });
    const contaminated = `${JSON.stringify(legacy, null, 2)}\n`;
    await fs.writeFile(metadataPath, contaminated, "utf8");
    await fs.writeFile(backupPath, contaminated, "utf8");

    observedHeaders.length = 0;
    manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1 });
    await manager.init();
    for (const metadataFile of [metadataPath, backupPath]) {
      const text = await fs.readFile(metadataFile, "utf8");
      assert.doesNotMatch(text, /cookie|authorization|legacy-.*-secret/i);
      assert.match(text, /safe-to-persist/);
    }

    await manager.resume(added.id);
    const rejected = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "error",
    );
    assert.match(rejected.error ?? "", /HTTP 401|web page/i);
    assert.ok(observedHeaders.length > 0);
    assert.ok(
      observedHeaders.every(
        (headers) =>
          headers.cookie === undefined &&
          headers.authorization === undefined &&
          headers["proxy-authorization"] === undefined,
      ),
    );
    assert.ok(observedHeaders.some((headers) => headers["x-bunni-test"] === "safe-to-persist"));
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not leak credentials across redirects", async () => {
  const source = patternedBuffer(192 * 1024 + 11);
  const targetRequests: http.IncomingHttpHeaders[] = [];
  const target = await startRangeServer(source, 0, "redirected.bin", (request) => {
    targetRequests.push({ ...request.headers });
  });
  const redirectRequests: http.IncomingHttpHeaders[] = [];
  const redirectServer = http.createServer((request, response) => {
    redirectRequests.push({ ...request.headers });
    response.writeHead(302, { Location: target.url });
    response.end();
  });
  const redirect = await listen(redirectServer);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-redirect-headers-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({
      url: redirect.url,
      fileName: "redirected.bin",
      segments: 4,
      headers: {
        Cookie: "redirect-cookie-secret",
        Authorization: "Bearer redirect-auth-secret",
        "Proxy-Authorization": "Basic redirect-proxy-secret",
      },
    });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    assert.deepEqual(await fs.readFile(completed.destination), source);
    assert.ok(redirectRequests.some((headers) => headers.cookie === "redirect-cookie-secret"));
    assert.ok(targetRequests.length > 0);
    assert.ok(
      targetRequests.every(
        (headers) =>
          headers.cookie === undefined &&
          headers.authorization === undefined &&
          headers["proxy-authorization"] === undefined,
      ),
    );
  } finally {
    await manager.shutdown();
    await closeServer(redirectServer);
    await closeServer(target.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persists a paused ranged download and resumes it after restart", async () => {
  const source = patternedBuffer(8 * 1024 * 1024);
  const remote = await startRangeServer(source, 4, "restart.bin");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-resume-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  let manager = new DownloadManager({
    dataDir,
    downloadDir,
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, segments: 4 });
    const inProgress = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "downloading" && record.bytesReceived >= 128 * 1024,
    );
    assert.ok(inProgress.bytesReceived < source.length);

    const paused = await manager.pause(added.id);
    assert.equal(paused.status, "paused");
    assert.ok(paused.bytesReceived > 0);
    assert.ok(paused.bytesReceived < source.length);
    const receivedBeforeRestart = paused.bytesReceived;
    const targetTask = path.join(downloadDir, ".bunni-parts", added.id);
    const legacyTask = path.join(dataDir, ".bunni", added.id);
    assert.ok((await fs.stat(targetTask)).isDirectory(), "parts should use the destination drive");
    await assert.rejects(fs.stat(legacyTask), { code: "ENOENT" });
    await manager.shutdown();

    // Simulate an upgrade from the legacy userData location, including an
    // interrupted migration where one destination part is shorter and another
    // is already larger than its legacy counterpart.
    await fs.mkdir(path.dirname(legacyTask), { recursive: true });
    await fs.rename(targetTask, legacyTask);
    const partNames = (await fs.readdir(legacyTask))
      .filter((name) => /^\d+\.part$/.test(name));
    assert.ok(partNames.length >= 2);
    const firstLegacy = await fs.readFile(path.join(legacyTask, partNames[0]));
    const secondFull = await fs.readFile(path.join(legacyTask, partNames[1]));
    assert.ok(firstLegacy.length > 1 && secondFull.length > 1);
    await fs.mkdir(targetTask, { recursive: true });
    await fs.writeFile(
      path.join(targetTask, partNames[0]),
      firstLegacy.subarray(0, Math.floor(firstLegacy.length / 2)),
    );
    await fs.writeFile(path.join(targetTask, partNames[1]), secondFull);
    await fs.truncate(
      path.join(legacyTask, partNames[1]),
      Math.floor(secondFull.length / 2),
    );

    manager = new DownloadManager({
      dataDir,
      downloadDir,
      maxConcurrent: 1,
      defaultSegments: 4,
    });
    await manager.init();
    const restored = manager.list().find((record) => record.id === added.id);
    assert.ok(restored);
    assert.equal(restored.status, "paused");
    assert.ok(restored.bytesReceived >= receivedBeforeRestart);
    assert.deepEqual(await fs.readFile(path.join(targetTask, partNames[0])), firstLegacy);
    assert.deepEqual(await fs.readFile(path.join(targetTask, partNames[1])), secondFull);
    await assert.rejects(fs.stat(legacyTask), { code: "ENOENT" });

    await manager.resume(added.id);
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
      20_000,
    );
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a resume requested during pause is not lost", async () => {
  const source = patternedBuffer(8 * 1024 * 1024);
  const remote = await startRangeServer(source, 4, "rapid-resume.bin");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-rapid-resume-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url });
    await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "downloading" && record.bytesReceived > 0,
    );

    const pausing = manager.pause(added.id);
    const resuming = manager.resume(added.id);
    await Promise.all([pausing, resuming]);

    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
      20_000,
    );
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("discards partial ranges when the resource validator disappears", async () => {
  const original = patternedBuffer(8 * 1024 * 1024);
  const replacement = Buffer.alloc(original.length, 0xa5);
  let content = original;
  let etag: string | undefined = '"mutable-v1"';
  const server = http.createServer((request, response) => {
    const commonHeaders: http.OutgoingHttpHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      ...(etag ? { ETag: etag } : {}),
    };
    if (request.method === "HEAD") {
      response.writeHead(200, { ...commonHeaders, "Content-Length": content.length });
      response.end();
      return;
    }
    const range = parseRange(request.headers.range, content.length);
    if (!range) {
      response.writeHead(200, { ...commonHeaders, "Content-Length": content.length });
      void writeBuffer(response, content, 3);
      return;
    }
    const body = content.subarray(range.start, range.end + 1);
    response.writeHead(206, {
      ...commonHeaders,
      "Content-Length": body.length,
      "Content-Range": `bytes ${range.start}-${range.end}/${content.length}`,
    });
    void writeBuffer(response, body, 3);
  });
  const remote = await listen(server);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-validator-change-"));
  const manager = new DownloadManager({
    dataDir: path.join(root, "state"),
    downloadDir: path.join(root, "downloads"),
    maxConcurrent: 1,
    defaultSegments: 4,
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, fileName: "mutable.bin" });
    await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "downloading" && record.bytesReceived >= 128 * 1024,
    );
    const paused = await manager.pause(added.id);
    assert.ok(paused.bytesReceived > 0 && paused.bytesReceived < original.length);

    content = replacement;
    etag = undefined;
    await manager.resume(added.id);
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
      20_000,
    );
    assert.deepEqual(await fs.readFile(completed.destination), replacement);
  } finally {
    await manager.shutdown();
    await closeServer(server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("does not report a truncated completed file as healthy after restart", async () => {
  const source = patternedBuffer(96 * 1024 + 5);
  const remote = await startNonRangeServer(source);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-truncated-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  let manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1 });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, fileName: "truncated.bin" });
    const completed = await waitForRecord(
      manager,
      added.id,
      (record) => record.status === "completed",
    );
    await manager.shutdown();
    await fs.truncate(completed.destination, 17);

    manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1 });
    await manager.init();
    const restored = manager.list().find((record) => record.id === added.id);
    assert.ok(restored);
    assert.equal(restored.status, "error");
    assert.match(restored.error ?? "", /17 bytes; expected/);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovers queue metadata from the last complete backup", async () => {
  const source = patternedBuffer(64 * 1024 + 9);
  const remote = await startNonRangeServer(source);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-metadata-backup-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  let manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1 });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, fileName: "backup.bin" });
    await waitForRecord(manager, added.id, (record) => record.status === "completed");
    await manager.shutdown();

    await fs.writeFile(path.join(dataDir, "downloads.json"), "{not-json", "utf8");
    manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1 });
    await manager.init();
    const restored = manager.list().find((record) => record.id === added.id);
    assert.ok(restored);
    assert.equal(restored.status, "completed");
    assert.deepEqual(await fs.readFile(restored.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("falls back to copying when hardlinking is unsupported (EXDEV)", async (context) => {
  const source = patternedBuffer(32 * 1024);
  const remote = await startNonRangeServer(source);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bunni-exdev-"));
  const dataDir = path.join(root, "state");
  const downloadDir = path.join(root, "downloads");
  const manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 1 });

  const originalLink = fs.link;
  context.mock.method(fs, "link", async () => {
    const error = new Error("Cross-device link") as NodeJS.ErrnoException;
    error.code = "EXDEV";
    throw error;
  });

  try {
    await manager.init();
    const added = await manager.add({ url: remote.url, fileName: "exdev.bin" });
    const completed = await waitForRecord(manager, added.id, (record) => record.status === "completed");
    assert.equal(completed.status, "completed");
    assert.deepEqual(await fs.readFile(completed.destination), source);
  } finally {
    await manager.shutdown();
    await closeServer(remote.server);
    await fs.rm(root, { recursive: true, force: true });
  }
});


function fakeCredentialProtection(): Pick<
  DownloadManagerOptions,
  "protectSensitiveHeaders" | "unprotectSensitiveHeaders"
> {
  return {
    protectSensitiveHeaders(headers) {
      return `fake-sealed:${Buffer.from(JSON.stringify(headers), "utf8").toString("base64")}`;
    },
    unprotectSensitiveHeaders(opaque) {
      if (!opaque.startsWith("fake-sealed:")) throw new Error("corrupt fake credential payload");
      const decoded = Buffer.from(opaque.slice("fake-sealed:".length), "base64").toString("utf8");
      return JSON.parse(decoded) as Record<string, string>;
    },
  };
}

async function startCookieRangeServer(
  content: Buffer,
  requiredCookie: string,
  delayPerChunkMs: number,
  onRequest?: (request: http.IncomingMessage) => void,
): Promise<TestServer> {
  const server = http.createServer((request, response) => {
    onRequest?.(request);
    if (request.headers.cookie !== requiredCookie) {
      response.writeHead(401, { "Content-Type": "text/plain", "Content-Length": 0 });
      response.end();
      return;
    }
    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": content.length,
      ETag: '"credential-test-v1"',
    };
    if (request.method === "HEAD") {
      response.writeHead(200, commonHeaders);
      response.end();
      return;
    }
    const range = parseRange(request.headers.range, content.length);
    if (!range) {
      response.writeHead(200, commonHeaders);
      void writeBuffer(response, content, delayPerChunkMs);
      return;
    }
    const body = content.subarray(range.start, range.end + 1);
    response.writeHead(206, {
      ...commonHeaders,
      "Content-Length": body.length,
      "Content-Range": `bytes ${range.start}-${range.end}/${content.length}`,
    });
    void writeBuffer(response, body, delayPerChunkMs);
  });
  return listen(server);
}

async function startRangeServer(
  content: Buffer,
  delayPerChunkMs: number,
  fileName: string,
  onRequest?: (request: http.IncomingMessage) => void,
): Promise<TestServer> {
  const server = http.createServer((request, response) => {
    onRequest?.(request);
    const commonHeaders = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      ETag: '"test-content-v1"',
    };
    if (request.method === "HEAD") {
      response.writeHead(200, { ...commonHeaders, "Content-Length": content.length });
      response.end();
      return;
    }

    const range = parseRange(request.headers.range, content.length);
    if (!range) {
      response.writeHead(200, { ...commonHeaders, "Content-Length": content.length });
      void writeBuffer(response, content, delayPerChunkMs);
      return;
    }
    if (range.start >= content.length || range.end < range.start) {
      response.writeHead(416, { "Content-Range": `bytes */${content.length}` });
      response.end();
      return;
    }
    const body = content.subarray(range.start, range.end + 1);
    response.writeHead(206, {
      ...commonHeaders,
      "Content-Length": body.length,
      "Content-Range": `bytes ${range.start}-${range.end}/${content.length}`,
    });
    void writeBuffer(response, body, delayPerChunkMs);
  });
  return listen(server);
}

async function startNonRangeServer(
  content: Buffer,
  advertiseRanges = false,
): Promise<TestServer> {
  const server = http.createServer((request, response) => {
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": content.length,
      ...(advertiseRanges ? { "Accept-Ranges": "bytes" } : {}),
    };
    if (request.method === "HEAD") {
      response.writeHead(200, headers);
      response.end();
      return;
    }
    // Deliberately ignore Range and return a normal 200 response.
    response.writeHead(200, headers);
    response.end(content);
  });
  return listen(server);
}

async function listen(server: http.Server): Promise<TestServer> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}/download` };
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function withLocalGoFileDns<T>(operation: () => Promise<T>): Promise<T> {
  const options = http.globalAgent.options as unknown as Record<string, unknown>;
  const hadLookup = Object.hasOwn(options, "lookup");
  const previousLookup = options.lookup;
  options.lookup = (
    _hostname: string,
    lookupOptions: unknown,
    callback: (...args: unknown[]) => void,
  ): void => {
    const all =
      typeof lookupOptions === "object" &&
      lookupOptions !== null &&
      "all" in lookupOptions &&
      (lookupOptions as { all?: unknown }).all === true;
    if (all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
    else callback(null, "127.0.0.1", 4);
  };
  try {
    return await operation();
  } finally {
    if (hadLookup) options.lookup = previousLookup;
    else delete options.lookup;
  }
}

function parseRange(value: string | undefined, length: number): { start: number; end: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : length - 1;
  return { start, end: Math.min(length - 1, requestedEnd) };
}

async function writeBuffer(
  response: http.ServerResponse,
  content: Buffer,
  delayPerChunkMs: number,
): Promise<void> {
  const chunkSize = 16 * 1024;
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    if (response.destroyed) return;
    const chunk = content.subarray(offset, Math.min(content.length, offset + chunkSize));
    if (!response.write(chunk)) {
      await new Promise<void>((resolve) => response.once("drain", resolve));
    }
    if (delayPerChunkMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayPerChunkMs));
    }
  }
  if (!response.destroyed) response.end();
}

function patternedBuffer(length: number): Buffer {
  const result = Buffer.allocUnsafe(length);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = (index * 31 + Math.floor(index / 251)) & 0xff;
  }
  return result;
}

async function waitForRecord(
  manager: DownloadManager,
  id: string,
  predicate: (record: DownloadRecord) => boolean,
  timeoutMs = 10_000,
): Promise<DownloadRecord> {
  const current = manager.list().find((record) => record.id === id);
  if (current && predicate(current)) return current;

  return new Promise<DownloadRecord>((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("changed", onChanged);
      const latest = manager.list().find((record) => record.id === id);
      reject(new Error(`Timed out waiting for download; latest=${JSON.stringify(latest)}`));
    }, timeoutMs);
    const onChanged = (record: DownloadRecord): void => {
      if (record.id !== id || !predicate(record)) return;
      clearTimeout(timer);
      manager.off("changed", onChanged);
      resolve(record);
    };
    manager.on("changed", onChanged);
  });
}
