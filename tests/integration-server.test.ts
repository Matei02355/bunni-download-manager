import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  IntegrationServer,
  type ExtensionCapture,
  type ExtensionDownloadRequest
} from "../src/main/integration-server";

const added: ExtensionDownloadRequest[] = [];
const capturedInputs: ExtensionDownloadRequest[] = [];
const captures = new Map<string, ExtensionCapture>();
const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
let nextCapture = 1;

const server = new IntegrationServer({
  port: 0,
  addDownload: async (input) => {
    added.push(input);
    return { id: "test-download", status: "queued", ...input };
  },
  listDownloads: () => [],
  createCapture: async (input) => {
    capturedInputs.push(input);
    const id = `capture-${nextCapture++}`;
    const capture: ExtensionCapture = {
      id,
      state: "pending",
      download: {
        id,
        status: "paused",
        url: input.url,
        fileName: input.fileName ?? "download",
        headers: input.headers,
        protectedHeaders: "must-not-be-returned"
      }
    };
    captures.set(id, capture);
    return capture;
  },
  getCapture: (id) => captures.get(id),
  rejectCapture: async (id) => {
    const capture = captures.get(id);
    if (capture?.state === "pending") capture.state = "rejected";
    return capture;
  }
});

before(async () => server.start());
after(async () => server.stop());

function extensionHeaders(contentType = false): Record<string, string> {
  return {
    Origin: extensionOrigin,
    "X-Bunni-Client": "chrome-extension",
    ...(contentType ? { "Content-Type": "application/json" } : {})
  };
}

test("health endpoint is available on loopback", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; name: string; port: number };
  assert.equal(body.ok, true);
  assert.equal(body.name, "Bunni Download Manager");
  assert.equal(body.port, server.port);
});

test("web page and lookalike extension origins are rejected", async (context) => {
  for (const origin of ["https://example.com", `${extensionOrigin}.example.com`]) {
    await context.test(origin, async () => {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
        headers: { Origin: origin }
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    });
  }
});

test("valid extension preflights include capture methods and narrow headers", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/captures`, {
    method: "OPTIONS",
    headers: {
      Origin: extensionOrigin,
      "Access-Control-Request-Method": "DELETE",
      "Access-Control-Request-Headers": "content-type,x-bunni-client"
    }
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), extensionOrigin);
  assert.match(response.headers.get("access-control-allow-methods") ?? "", /DELETE/);
  assert.match(response.headers.get("access-control-allow-headers") ?? "", /X-Bunni-Client/i);
});

test("extension can still add a validated HTTP download directly", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/downloads`, {
    method: "POST",
    headers: extensionHeaders(true),
    body: JSON.stringify({
      url: "https://example.com/file.zip",
      filename: "file.zip",
      referrer: "https://example.com/downloads",
      segments: 6
    })
  });
  assert.equal(response.status, 202);
  assert.equal(added.at(-1)?.segments, 6);
  assert.equal(added.at(-1)?.fileName, "file.zip");
  assert.equal(added.at(-1)?.headers?.Referer, "https://example.com/downloads");
});

test("POST /api/captures validates input and returns the exact pending envelope", async () => {
  const secret = "browser-cookie-secret";
  const response = await fetch(`http://127.0.0.1:${server.port}/api/captures`, {
    method: "POST",
    headers: extensionHeaders(true),
    body: JSON.stringify({
      url: `https://user:password@example.com/archive.rar?accountToken=${secret}`,
      filename: "archive.rar",
      referrer: "https://example.com/files",
      segments: 8,
      headers: { Cookie: `accountToken=${secret}`, "X-Safe": "value" }
    })
  });

  assert.equal(response.status, 202);
  const body = await response.json() as { ok: boolean; capture: ExtensionCapture };
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.capture).sort(), ["download", "id", "state"]);
  assert.equal(body.capture.state, "pending");
  assert.equal((body.capture.download as Record<string, unknown>).status, "paused");
  assert.equal("headers" in (body.capture.download as Record<string, unknown>), false);
  assert.equal("protectedHeaders" in (body.capture.download as Record<string, unknown>), false);
  assert.doesNotMatch(JSON.stringify(body.capture), /browser-cookie-secret|password/);

  const captured = capturedInputs.at(-1);
  assert.equal(captured?.fileName, "archive.rar");
  assert.equal(captured?.segments, 8);
  assert.equal(captured?.headers?.Cookie, `accountToken=${secret}`);
  assert.equal(captured?.headers?.Referer, "https://example.com/files");
});

test("GET reports capture state without returning credentials", async () => {
  const id = [...captures.keys()].at(-1)!;
  const response = await fetch(`http://127.0.0.1:${server.port}/api/captures/${id}`, {
    headers: extensionHeaders()
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; capture: ExtensionCapture };
  assert.equal(body.ok, true);
  assert.equal(body.capture.id, id);
  assert.equal(body.capture.state, "pending");
  assert.equal("headers" in (body.capture.download as Record<string, unknown>), false);
});

test("DELETE safely rejects a pending capture and is idempotent", async () => {
  const id = [...captures.keys()].at(-1)!;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/captures/${id}`, {
      method: "DELETE",
      headers: extensionHeaders()
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { ok: boolean; capture: ExtensionCapture };
    assert.equal(body.ok, true);
    assert.equal(body.capture.state, "rejected");
  }
});

test("DELETE cannot overwrite an already accepted decision", async () => {
  const capture: ExtensionCapture = {
    id: "capture-accepted",
    state: "accepted",
    download: { id: "capture-accepted", status: "queued" }
  };
  captures.set(capture.id, capture);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/captures/${capture.id}`, {
    method: "DELETE",
    headers: extensionHeaders()
  });
  assert.equal(response.status, 409);
  const body = await response.json() as { ok: boolean; error: string; capture: ExtensionCapture };
  assert.equal(body.ok, false);
  assert.equal(body.error, "Capture is no longer pending.");
  assert.equal(body.capture.state, "accepted");
});

test("missing captures and malformed capture identifiers are rejected", async (context) => {
  await context.test("missing", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/captures/capture-missing`, {
      headers: extensionHeaders()
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: "Capture not found." });
  });
  await context.test("malformed", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/captures/bad%20id`, {
      headers: extensionHeaders()
    });
    assert.equal(response.status, 400);
  });
});

test("capture routes require the extension client header", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/captures`, {
    method: "POST",
    headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/file.zip" })
  });
  assert.equal(response.status, 403);
});

test("capture and direct-download routes share strict input validation", async (context) => {
  const invalidInputs = [
    { url: "file:///C:/Windows/win.ini" },
    { url: "https://example.com/file.zip", segments: 2.5 },
    { url: "https://example.com/file.zip", headers: { Cookie: "bad\r\nInjected: yes" } },
    { url: "https://example.com/file.zip", fileName: "x".repeat(1_025) }
  ];
  for (const endpoint of ["downloads", "captures"]) {
    await context.test(endpoint, async () => {
      for (const input of invalidInputs) {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/${endpoint}`, {
          method: "POST",
          headers: extensionHeaders(true),
          body: JSON.stringify(input)
        });
        assert.equal(response.status, 400);
      }
    });
  }
});

test("oversized capture bodies receive a 413 response", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/captures`, {
    method: "POST",
    headers: extensionHeaders(true),
    body: JSON.stringify({ url: "https://example.com/file.zip", padding: "x".repeat(65 * 1024) })
  });
  assert.equal(response.status, 413);
});

test("a prepared download that failed is not reported as pending", async () => {
  const failingServer = new IntegrationServer({
    port: 0,
    addDownload: async () => ({ status: "error" }),
    listDownloads: () => [],
    createCapture: async () => ({
      id: "capture-error",
      state: "error",
      download: { id: "capture-error", status: "error", error: "The remote server refused the request." }
    })
  });
  await failingServer.start();
  try {
    const response = await fetch(`http://127.0.0.1:${failingServer.port}/api/captures`, {
      method: "POST",
      headers: extensionHeaders(true),
      body: JSON.stringify({ url: "https://example.com/private.zip" })
    });
    assert.equal(response.status, 422);
    const body = await response.json() as { ok: boolean; error: string; capture: ExtensionCapture };
    assert.equal(body.ok, false);
    assert.equal(body.error, "The remote server refused the request.");
    assert.equal(body.capture.state, "error");
  } finally {
    await failingServer.stop();
  }
});

test("internal capture failures are returned as generic server errors", async (context) => {
  const log = context.mock.method(console, "error", () => undefined);
  const failingServer = new IntegrationServer({
    port: 0,
    addDownload: async () => ({ status: "queued" }),
    listDownloads: () => [],
    createCapture: async () => { throw new Error("sensitive local path details"); }
  });
  await failingServer.start();
  try {
    const response = await fetch(`http://127.0.0.1:${failingServer.port}/api/captures`, {
      method: "POST",
      headers: extensionHeaders(true),
      body: JSON.stringify({ url: "https://example.com/file.zip" })
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Bunni could not process the request." });
    assert.equal(log.mock.callCount(), 1);
  } finally {
    await failingServer.stop();
  }
});

test("redacts multiple and duplicate sensitive query parameters safely", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/captures`, {
    method: "POST",
    headers: extensionHeaders(true),
    body: JSON.stringify({
      url: "https://user:pass@example.com/file.bin?token=123&token=456&sig=abc&other=normal",
      fileName: "file.bin"
    })
  });
  assert.equal(response.status, 202);
  const body = await response.json() as { ok: boolean; capture: ExtensionCapture };
  assert.equal(body.ok, true);
  const url = (body.capture.download as Record<string, unknown>).url as string;
  assert.equal(url, "https://example.com/file.bin?token=%5Bredacted%5D&sig=%5Bredacted%5D&other=normal");
});

