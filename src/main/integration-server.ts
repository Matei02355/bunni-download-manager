import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ExtensionDownloadRequest {
  url: string;
  fileName?: string;
  segments?: number;
  headers?: Record<string, string>;
}

export type ExtensionCaptureState =
  | "pending"
  | "accepted"
  | "accepted-paused"
  | "rejected"
  | "error";

export interface ExtensionCapture {
  id: string;
  state: ExtensionCaptureState;
  download: unknown;
}

export interface IntegrationServerOptions {
  port: number;
  addDownload: (input: ExtensionDownloadRequest) => Promise<unknown>;
  listDownloads: () => unknown;
  createCapture?: (input: ExtensionDownloadRequest) => Promise<ExtensionCapture>;
  getCapture?: (id: string) => ExtensionCapture | undefined;
  rejectCapture?: (id: string) => Promise<ExtensionCapture | undefined>;
}

const BODY_LIMIT = 64 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const CAPTURE_ID = /^[a-zA-Z0-9_-]{4,128}$/;
const CAPTURE_STATES = new Set<ExtensionCaptureState>([
  "pending",
  "accepted",
  "accepted-paused",
  "rejected",
  "error"
]);
const SENSITIVE_CAPTURE_KEYS = new Set([
  "accounttoken",
  "authorization",
  "cookie",
  "cookie2",
  "credentials",
  "headers",
  "password",
  "protectedheaders",
  "proxyauthorization",
  "secret",
  "setcookie",
  "token"
]);

class IntegrationRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "IntegrationRequestError";
  }
}

export class IntegrationServer {
  private server: Server | undefined;
  private options: IntegrationServerOptions;

  constructor(options: IntegrationServerOptions) {
    this.options = options;
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address !== "string" ? address.port : this.options.port;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        console.error("Unhandled Bunni extension request error:", error);
        if (!response.headersSent && !response.destroyed) {
          this.json(response, 500, { error: "Bunni could not process the request." });
        } else if (!response.destroyed) {
          response.destroy();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.on("error", (error) => console.error("Bunni extension server error:", error));
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async restart(options: IntegrationServerOptions): Promise<void> {
    await this.stop();
    this.options = options;
    await this.start();
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (origin && !EXTENSION_ORIGIN.test(origin)) {
      this.json(response, 403, { error: "Only the Bunni browser extension may access this service." });
      return;
    }

    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Bunni-Client");
    response.setHeader("Access-Control-Max-Age", "86400");
    response.setHeader("Vary", "Origin");
    response.setHeader("Cache-Control", "no-store");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        this.json(response, 200, {
          ok: true,
          name: "Bunni Download Manager",
          version: 1,
          port: (this.server?.address() as AddressInfo | null)?.port ?? this.options.port
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/downloads") {
        this.json(response, 200, this.options.listDownloads());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/downloads") {
        if (!this.requireExtensionClient(request, response)) return;
        const body = await this.readJson(request);
        const input = this.validateDownload(body);
        const download = await this.options.addDownload(input);
        if (this.downloadFailed(download)) {
          this.json(response, 422, {
            ok: false,
            error: this.downloadError(download),
            download
          });
          return;
        }
        this.json(response, 202, { ok: true, download });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/captures") {
        if (!this.requireExtensionClient(request, response)) return;
        if (!this.options.createCapture) {
          this.json(response, 503, { error: "Browser capture is not available." });
          return;
        }
        const body = await this.readJson(request);
        const input = this.validateDownload(body);
        const capture = this.publicCapture(await this.options.createCapture(input));
        if (capture.state === "error" || this.downloadFailed(capture.download)) {
          this.json(response, 422, {
            ok: false,
            error: this.downloadError(capture.download),
            capture
          });
          return;
        }
        if (capture.state !== "pending") {
          throw new Error("The capture callback did not return a pending capture.");
        }
        this.json(response, 202, { ok: true, capture });
        return;
      }

      const captureId = this.captureId(url.pathname);
      if (captureId !== undefined && request.method === "GET") {
        if (!this.requireExtensionClient(request, response)) return;
        const capture = this.options.getCapture?.(captureId);
        if (!capture) {
          this.json(response, 404, { ok: false, error: "Capture not found." });
          return;
        }
        this.json(response, 200, { ok: true, capture: this.publicCapture(capture) });
        return;
      }

      if (captureId !== undefined && request.method === "DELETE") {
        if (!this.requireExtensionClient(request, response)) return;
        if (!this.options.rejectCapture) {
          this.json(response, 503, { error: "Browser capture is not available." });
          return;
        }
        const value = await this.options.rejectCapture(captureId);
        if (!value) {
          this.json(response, 404, { ok: false, error: "Capture not found." });
          return;
        }
        const capture = this.publicCapture(value);
        if (capture.state === "accepted" || capture.state === "accepted-paused") {
          this.json(response, 409, {
            ok: false,
            error: "Capture is no longer pending.",
            capture
          });
          return;
        }
        this.json(response, 200, { ok: true, capture });
        return;
      }

      this.json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = error instanceof IntegrationRequestError ? error.status : 500;
      const message = status < 500 && error instanceof Error
        ? error.message
        : "Bunni could not process the request.";
      if (status >= 500) console.error("Bunni extension request failed:", error);
      if (!response.headersSent && !response.destroyed) this.json(response, status, { error: message });
    }
  }

  private requireExtensionClient(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.headers["x-bunni-client"] === "chrome-extension") return true;
    this.json(response, 403, { error: "Missing Bunni extension client header." });
    return false;
  }

  private captureId(pathname: string): string | undefined {
    const match = /^\/api\/captures\/([^/]+)$/.exec(pathname);
    if (!match) return undefined;
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      throw new IntegrationRequestError(400, "Capture identifier is invalid.");
    }
    if (!CAPTURE_ID.test(id)) {
      throw new IntegrationRequestError(400, "Capture identifier is invalid.");
    }
    return id;
  }

  private readJson(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const onData = (chunk: Buffer | string) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > BODY_LIMIT) {
          settled = true;
          chunks.length = 0;
          request.off("data", onData);
          request.resume();
          reject(new IntegrationRequestError(413, "Request body is too large."));
          return;
        }
        chunks.push(buffer);
      };
      request.on("data", onData);
      request.on("end", () => {
        if (settled) return;
        settled = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new IntegrationRequestError(400, "Request body must be valid JSON."));
        }
      });
      request.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      request.on("aborted", () => {
        if (settled) return;
        settled = true;
        reject(new IntegrationRequestError(400, "Request body was interrupted."));
      });
    });
  }

  private validateDownload(body: unknown): ExtensionDownloadRequest {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new IntegrationRequestError(400, "A download request is required.");
    }
    const candidate = body as Record<string, unknown>;
    if (typeof candidate.url !== "string") {
      throw new IntegrationRequestError(400, "A URL is required.");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(candidate.url);
    } catch {
      throw new IntegrationRequestError(400, "A valid URL is required.");
    }
    if (!(["http:", "https:"] as string[]).includes(parsedUrl.protocol)) {
      throw new IntegrationRequestError(400, "Only HTTP and HTTPS downloads are supported.");
    }

    if (candidate.url.length > 16_384) {
      throw new IntegrationRequestError(400, "A valid URL is required.");
    }

    const input: ExtensionDownloadRequest = { url: parsedUrl.toString() };
    const requestedFileName = Object.hasOwn(candidate, "fileName")
      ? candidate.fileName
      : candidate.filename;
    if (requestedFileName !== undefined && typeof requestedFileName !== "string") {
      throw new IntegrationRequestError(400, "File name is invalid.");
    }
    if (typeof requestedFileName === "string") {
      if (requestedFileName.length > 1_024) {
        throw new IntegrationRequestError(400, "File name is invalid.");
      }
      if (requestedFileName.trim()) input.fileName = requestedFileName.trim();
    }
    if (candidate.segments !== undefined) {
      const segments = candidate.segments;
      if (typeof segments !== "number" || !Number.isInteger(segments) || segments < 1 || segments > 32) {
        throw new IntegrationRequestError(400, "Segments must be an integer between 1 and 32.");
      }
      input.segments = segments;
    }
    const headers: Record<string, string> = {};
    if (candidate.headers !== undefined) {
      if (!candidate.headers || typeof candidate.headers !== "object" || Array.isArray(candidate.headers)) {
        throw new IntegrationRequestError(400, "Download headers must be a key-value object.");
      }
      const entries = Object.entries(candidate.headers as Record<string, unknown>);
      if (entries.length > 100) {
        throw new IntegrationRequestError(400, "Too many download headers were provided.");
      }
      for (const [key, value] of entries) {
        if (
          typeof value !== "string"
          || !key
          || key.length > 256
          || value.length > 8_192
          || /[\r\n]/.test(key + value)
        ) {
          throw new IntegrationRequestError(400, "Download headers are invalid.");
        }
        headers[key] = value;
      }
    }
    if (typeof candidate.referrer === "string" && !/[\r\n]/.test(candidate.referrer)) {
      try {
        const referrer = new URL(candidate.referrer);
        if (referrer.protocol === "http:" || referrer.protocol === "https:") headers.Referer = referrer.toString();
      } catch {
        // An invalid optional referrer should not prevent the download.
      }
    }
    if (Object.keys(headers).length > 0) input.headers = headers;
    return input;
  }

  private publicCapture(value: ExtensionCapture): ExtensionCapture {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The capture callback returned an invalid result.");
    }
    if (!CAPTURE_ID.test(value.id) || !CAPTURE_STATES.has(value.state)) {
      throw new Error("The capture callback returned an invalid result.");
    }
    if (!value.download || typeof value.download !== "object") {
      throw new Error("The capture callback returned an invalid result.");
    }
    return {
      id: value.id,
      state: value.state,
      download: this.redactCaptureValue(value.download)
    };
  }

  private redactCaptureValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
    if (typeof value === "string") {
      return /^(?:url|finalurl|referrer)$/i.test(key) ? this.redactUrl(value) : value;
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("The capture callback returned a cyclic result.");
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.map((item) => this.redactCaptureValue(item, "", seen));
      seen.delete(value);
      return result;
    }
    const result: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (SENSITIVE_CAPTURE_KEYS.has(normalized)) continue;
      result[name] = this.redactCaptureValue(item, name, seen);
    }
    seen.delete(value);
    return result;
  }

  private redactUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    const paramNames = Array.from(new Set(url.searchParams.keys()));
    for (const name of paramNames) {
      if (/^(?:token|access_?token|account_?token|auth|authorization|api_?key|password|passwd|secret|signature|sig|x-amz-(?:credential|signature|security-token))$/i.test(name)) {
        url.searchParams.set(name, "[redacted]");
      }
    }
    return url.toString();
  }

  private downloadFailed(download: unknown): boolean {
    return Boolean(download && typeof download === "object" && (download as Record<string, unknown>).status === "error");
  }

  private downloadError(download: unknown): string {
    if (download && typeof download === "object") {
      const message = (download as Record<string, unknown>).error;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    return "Bunni could not start this download.";
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const content = Buffer.from(JSON.stringify(body));
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": content.length
    });
    response.end(content);
  }
}
