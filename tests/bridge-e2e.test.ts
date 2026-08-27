import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DownloadManager, type DownloadRecord } from "../src/main/download-manager";
import { IntegrationServer } from "../src/main/integration-server";

const payload = Buffer.allocUnsafe(384 * 1024);
for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 31 + 17) % 256;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForCompletion(manager: DownloadManager, id: string): Promise<DownloadRecord> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const record = manager.list().find((candidate) => candidate.id === id);
    if (!record) throw new Error("Download disappeared from the queue.");
    if (record.status === "completed") return record;
    if (record.status === "error") throw new Error(record.error ?? "Download failed.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for bridge download to complete.");
}

test("Chrome bridge request completes through the segmented engine", async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "bunni-bridge-e2e-"));
  const source = createServer((request, response) => {
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Disposition", "attachment; filename=bridge-test.bin");

    if (request.method === "HEAD") {
      response.setHeader("Content-Length", payload.length);
      response.end();
      return;
    }

    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (match) {
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), payload.length - 1);
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${payload.length}`);
      response.setHeader("Content-Length", end - start + 1);
      response.end(payload.subarray(start, end + 1));
      return;
    }

    response.setHeader("Content-Length", payload.length);
    response.end(payload);
  });
  const sourcePort = await listen(source);
  const manager = new DownloadManager({
    dataDir: path.join(workspace, "state"),
    downloadDir: path.join(workspace, "files"),
    maxConcurrent: 1,
    defaultSegments: 4
  });
  await manager.init();
  const bridge = new IntegrationServer({
    port: 0,
    addDownload: (input) => manager.add(input),
    listDownloads: () => manager.list()
  });
  await bridge.start();

  context.after(async () => {
    await bridge.stop();
    await manager.shutdown();
    await close(source);
    await rm(workspace, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${bridge.port}/api/downloads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bunni-Client": "chrome-extension",
      Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
    },
    body: JSON.stringify({
      url: `http://127.0.0.1:${sourcePort}/artifact`,
      segments: 4,
      source: "test"
    })
  });
  assert.equal(response.status, 202);
  const accepted = await response.json() as { download: DownloadRecord };
  const completed = await waitForCompletion(manager, accepted.download.id);
  assert.equal(completed.fileName, "bridge-test.bin");
  assert.equal(completed.segments.length, 4);
  assert.deepEqual(await readFile(completed.destination), payload);
});
