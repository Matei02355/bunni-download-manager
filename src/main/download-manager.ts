import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  promises as fs,
} from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export type DownloadStatus =
  | "queued"
  | "probing"
  | "downloading"
  | "paused"
  | "completed"
  | "cancelled"
  | "error";

export type DownloadSegmentStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "error";

export interface DownloadSegmentRecord {
  index: number;
  start: number;
  end: number | null;
  bytesReceived: number;
  status: DownloadSegmentStatus;
  retries: number;
}

export interface DownloadRecord {
  id: string;
  url: string;
  fileName: string;
  destination: string;
  status: DownloadStatus;
  bytesReceived: number;
  totalBytes: number | null;
  /** Current transfer rate in bytes per second. */
  speed: number;
  /** Estimated seconds remaining, or null when it cannot be calculated. */
  eta: number | null;
  /** Completion percentage in the inclusive range 0..100. */
  progress: number;
  segments: DownloadSegmentRecord[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  mime?: string;
}

export interface DownloadManagerOptions {
  dataDir: string;
  downloadDir: string;
  maxConcurrent?: number;
  defaultSegments?: number;
  /**
   * Optionally seals browser credentials before queue metadata is written.
   * Both hooks must be supplied together and must complete synchronously.
   */
  protectSensitiveHeaders?: (headers: Record<string, string>) => string;
  /** Restores a payload previously returned by protectSensitiveHeaders. */
  unprotectSensitiveHeaders?: (opaque: string) => Record<string, string>;
}

export interface AddDownloadOptions {
  url: string;
  fileName?: string;
  directory?: string;
  headers?: Record<string, string>;
  segments?: number;
  /** Admit and persist the download without starting its transfer. */
  startPaused?: boolean;
}

export interface RetargetDownloadOptions {
  fileName?: string;
  directory?: string;
}

export interface CancelDownloadOptions {
  /** Delete partial data (and a final file, if one exists). Defaults to true. */
  deleteFiles?: boolean;
}

export interface RemoveDownloadOptions {
  /** Delete the completed destination as well as its queue entry. */
  deleteFile?: boolean;
}

interface ProbeResult {
  finalUrl: string;
  totalBytes: number | null;
  rangeSupported: boolean;
  fileName?: string;
  mime?: string;
  etag?: string;
  lastModified?: string;
  sizeMismatch?: { expected: number; actual: number };
}

interface DownloadEntry {
  record: DownloadRecord;
  headers: Record<string, string>;
  segmentsRequested: number;
  rangeSupported: boolean;
  protectedHeaders?: string;
  finalUrl?: string;
  etag?: string;
  lastModified?: string;
}

interface PersistedState {
  version: 1;
  entries: Array<{
    record: DownloadRecord;
    headers: Record<string, string>;
    protectedHeaders?: string;
    segmentsRequested: number;
    rangeSupported: boolean;
    etag?: string;
    lastModified?: string;
  }>;
}

interface TaskManifest {
  version: 1;
  id: string;
  sourceUrlHash: string;
  finalUrlHash?: string;
  fileName: string;
  destination: string;
  totalBytes: number | null;
  rangeSupported: boolean;
  segmentsRequested: number;
  segments: Array<{ index: number; start: number; end: number | null }>;
  etag?: string;
  lastModified?: string;
}

interface OrphanMatch {
  manifest: TaskManifest;
  directory: string;
}

type ActiveIntent = "running" | "paused" | "cancelled" | "shutdown";

interface ActiveDownload {
  controller: AbortController;
  intent: ActiveIntent;
  promise: Promise<void>;
  ticker?: ReturnType<typeof setInterval>;
  lastTickAt: number;
  lastTickBytes: number;
  persistTick: number;
}

interface OpenedResponse {
  response: http.IncomingMessage;
  finalUrl: string;
}

interface StreamResult {
  headers: http.IncomingHttpHeaders;
  finalUrl: string;
}

interface TransferExpectation {
  sourceUrl: string;
  fileName: string;
  finalUrl?: string;
  mime?: string;
  totalBytes: number | null;
}

const METADATA_VERSION = 1 as const;
const MAX_REDIRECTS = 8;
const MAX_SEGMENTS = 32;
const MAX_RETRIES = 3;
const MAX_RATE_LIMIT_RETRIES = 8;
const MIGRATION_RETRIES = 3;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Chrome's interception hand-off gives the desktop service 20 seconds to
// accept or reject a download. Keep enough headroom for local persistence and
// the loopback response while retaining a network safety gate before Chrome's
// copy is cancelled.
const ADD_PROBE_TIMEOUT_MS = 7_000;
const PROGRESS_INTERVAL_MS = 300;
const HTML_RESPONSE_ERROR =
  "The server returned a web page instead of the requested file. " +
  "The link may be expired or require your browser session.";
const HTML_MIME_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const HTML_CAPABLE_EXTENSIONS = new Set([
  ".asp",
  ".aspx",
  ".cfm",
  ".cgi",
  ".htm",
  ".html",
  ".jsp",
  ".jspx",
  ".php",
  ".phtml",
  ".shtml",
  ".xht",
  ".xhtml",
  ".xml",
]);
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
]);
const PROTECTED_HEADERS_ERROR =
  "Saved browser credentials could not be restored. Capture the download from the browser again.";
const MAX_PROTECTED_HEADERS_LENGTH = 256 * 1024;
const TASK_MANIFEST_NAME = "manifest.json";
const MAX_TASK_MANIFEST_BYTES = 64 * 1024;

class RequestFailure extends Error {
  public readonly transient: boolean;
  public readonly retryAfterMs?: number;
  public readonly statusCode?: number;

  public constructor(
    message: string,
    transient = false,
    retryAfterMs?: number,
    statusCode?: number,
  ) {
    super(message);
    this.name = "RequestFailure";
    this.transient = transient;
    this.retryAfterMs = retryAfterMs;
    this.statusCode = statusCode;
  }
}

/**
 * A persistent, segmented HTTP(S) download queue suitable for Electron's main
 * process. The class intentionally depends only on Node built-ins.
 */
export class DownloadManager extends EventEmitter {
  private readonly dataDir: string;
  private readonly downloadDir: string;
  private readonly metadataPath: string;
  private readonly metadataBackupPath: string;
  private readonly tempRoot: string;
  private readonly defaultSegments: number;
  private readonly protectSensitiveHeaders?: (headers: Record<string, string>) => string;
  private readonly unprotectSensitiveHeaders?: (opaque: string) => Record<string, string>;
  private maxConcurrent: number;
  private readonly entries = new Map<string, DownloadEntry>();
  private readonly active = new Map<string, ActiveDownload>();
  private initialized = false;
  private shuttingDown = false;
  private initPromise: Promise<void> | null = null;
  private persistenceChain: Promise<void> = Promise.resolve();
  private skipNextMetadataBackup = false;

  public constructor(options: DownloadManagerOptions) {
    super();
    if (!options.dataDir || !options.downloadDir) {
      throw new TypeError("dataDir and downloadDir are required");
    }
    if (
      (options.protectSensitiveHeaders === undefined) !==
      (options.unprotectSensitiveHeaders === undefined)
    ) {
      throw new TypeError(
        "protectSensitiveHeaders and unprotectSensitiveHeaders must be provided together",
      );
    }
    if (
      options.protectSensitiveHeaders !== undefined &&
      (typeof options.protectSensitiveHeaders !== "function" ||
        typeof options.unprotectSensitiveHeaders !== "function")
    ) {
      throw new TypeError("Sensitive-header protection hooks must be functions");
    }

    this.dataDir = path.resolve(options.dataDir);
    this.downloadDir = path.resolve(options.downloadDir);
    this.metadataPath = path.join(this.dataDir, "downloads.json");
    this.metadataBackupPath = `${this.metadataPath}.bak`;
    this.tempRoot = path.join(this.dataDir, ".bunni");
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? 3, "maxConcurrent");
    this.defaultSegments = boundedSegments(options.defaultSegments ?? 8);
    this.protectSensitiveHeaders = options.protectSensitiveHeaders;
    this.unprotectSensitiveHeaders = options.unprotectSensitiveHeaders;
  }

  public init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.dataDir, { recursive: true }),
      fs.mkdir(this.downloadDir, { recursive: true }),
    ]);

    this.entries.clear();
    await this.loadMetadata();
    for (const entry of this.entries.values()) {
      await this.recoverEntry(entry);
    }

    await this.persistAndWait();
    this.shuttingDown = false;
    this.initialized = true;
    this.pump();
  }

  public async add(options: AddDownloadOptions): Promise<DownloadRecord> {
    this.assertReady();
    const sourceUrl = validateHttpUrl(options.url).toString();
    const headers = normalizeUserHeaders(options.headers ?? {});
    const segmentsRequested = boundedSegments(options.segments ?? this.defaultSegments);

    let probe: ProbeResult | undefined;
    let probeSnapshot: ProbeResult | undefined;
    let probeError: unknown;
    const probeController = new AbortController();
    const probeTimer = setTimeout(() => {
      probeController.abort(createAbortError("Initial download check timed out"));
    }, ADD_PROBE_TIMEOUT_MS);
    probeTimer.unref?.();
    try {
      // One bounded attempt is deliberate: the browser must receive a
      // definitive answer before its own hand-off request times out.
      probe = await this.probeWithRetries(
        sourceUrl,
        headers,
        segmentsRequested,
        probeController.signal,
        1,
      );
      probeSnapshot = probe;
      assertProbeResponse(
        sourceUrl,
        options.fileName ?? fileNameFromUrl(sourceUrl) ?? probe.fileName,
        probe,
      );
    } catch (error) {
      probe = undefined;
      probeError = probeController.signal.aborted
        ? (probeController.signal.reason ?? error)
        : error;
    } finally {
      clearTimeout(probeTimer);
    }

    // shutdown() may have started while the admission probe was in flight.
    this.assertReady();

    const suggestedName =
      options.fileName ??
      probe?.fileName ??
      fileNameFromUrl(probe?.finalUrl ?? sourceUrl) ??
      "download";
    const fileName = sanitizeFileName(suggestedName);
    const directory = resolveDownloadDirectory(this.downloadDir, options.directory);
    await fs.mkdir(directory, { recursive: true });

    const orphan = probe
      ? await this.findMatchingOrphan(
          sourceUrl,
          fileName,
          directory,
          segmentsRequested,
          probe,
        )
      : undefined;
    const id = orphan?.manifest.id ?? randomUUID();
    const destination = orphan?.manifest.destination ??
      (await this.findAvailableDestination(directory, fileName));
    const orphanSegments = orphan
      ? await orphanSegmentsWithSizes(orphan)
      : [];
    const orphanBytes = orphanSegments.reduce(
      (total, segment) => total + segment.bytesReceived,
      0,
    );
    const now = new Date().toISOString();
    const record: DownloadRecord = {
      id,
      url: sourceUrl,
      fileName: path.basename(destination),
      destination,
      status: probe ? (options.startPaused === true ? "paused" : "queued") : "error",
      bytesReceived: orphanBytes,
      totalBytes: probe?.totalBytes ?? probeSnapshot?.totalBytes ?? null,
      speed: 0,
      eta: null,
      progress:
        probe?.totalBytes && probe.totalBytes > 0
          ? clamp((orphanBytes / probe.totalBytes) * 100, 0, 100)
          : 0,
      segments: orphanSegments,
      createdAt: now,
      updatedAt: now,
      error: probeError ? errorMessage(probeError) : null,
      ...((probe?.mime ?? probeSnapshot?.mime)
        ? { mime: probe?.mime ?? probeSnapshot?.mime }
        : {}),
    };
    const entry: DownloadEntry = {
      record,
      headers,
      segmentsRequested: orphan?.manifest.segmentsRequested ?? segmentsRequested,
      rangeSupported: probe?.rangeSupported ?? false,
      finalUrl: probe?.finalUrl,
      etag: probe?.etag,
      lastModified: probe?.lastModified,
    };

    this.entries.set(id, entry);
    try {
      entry.protectedHeaders = this.protectHeadersForPersistence(headers);
      await this.persistAndWait();
    } catch (error) {
      // A caller must never receive a rejection while an unpersisted queued
      // entry remains eligible for a later pump; the browser may continue its
      // own copy after that rejection.
      this.entries.delete(id);
      throw error;
    }
    this.emit("added", cloneRecord(record));
    this.emitChanged(entry, false, false);
    this.pump();
    return cloneRecord(record);
  }

  /**
   * Changes the reserved destination for a download that has only completed
   * admission. Part files are never relocated by this operation.
   */
  public async retarget(
    id: string,
    options: RetargetDownloadOptions,
  ): Promise<DownloadRecord> {
    this.assertReady();
    const entry = this.requireEntry(id);

    if (!isObject(options)) {
      throw new TypeError("Retarget options are required");
    }
    if (options.fileName !== undefined && typeof options.fileName !== "string") {
      throw new TypeError("Download file name must be a string");
    }
    if (options.directory !== undefined && typeof options.directory !== "string") {
      throw new TypeError("Download directory must be a string");
    }
    if (
      options.directory !== undefined &&
      (options.directory.trim().length === 0 || options.directory.includes("\0"))
    ) {
      throw new TypeError("Download directory is invalid");
    }

    const fileName =
      options.fileName === undefined
        ? entry.record.fileName
        : sanitizeFileName(options.fileName);
    const directory =
      options.directory === undefined
        ? path.dirname(entry.record.destination)
        : resolveDownloadDirectory(this.downloadDir, options.directory);

    const requestedDestination = path.resolve(directory, truncateFileName(fileName));
    if (
      entry.record.status === "paused" &&
      !this.active.has(entry.record.id) &&
      normalizePathForComparison(requestedDestination) ===
        normalizePathForComparison(entry.record.destination)
    ) {
      // Capture confirmation always passes its displayed destination back to
      // the manager. Treat that exact target as a no-op so an authenticated
      // orphan with partial bytes can be resumed without relocating data.
      return cloneRecord(entry.record);
    }

    await fs.mkdir(directory, { recursive: true });
    // Keep a concurrently requested resume from changing the destination of a
    // transfer after it has started.
    this.assertReady();
    this.assertRetargetable(entry);
    const destination = await this.findAvailableDestination(
      directory,
      fileName,
      entry.record.id,
    );
    this.assertReady();
    this.assertRetargetable(entry);

    entry.record.destination = destination;
    entry.record.fileName = path.basename(destination);
    this.emitChanged(entry, false, false);
    await this.persistAndWait();
    return cloneRecord(entry.record);
  }

  private assertRetargetable(entry: DownloadEntry): void {
    if (
      entry.record.status !== "paused" ||
      entry.record.bytesReceived !== 0 ||
      entry.record.segments.length !== 0 ||
      this.active.has(entry.record.id)
    ) {
      throw new Error("Only a paused, unstarted download can be retargeted");
    }
  }

  private protectHeadersForPersistence(
    headers: Record<string, string>,
  ): string | undefined {
    const sensitiveHeaders = sensitiveHeadersOnly(headers);
    if (Object.keys(sensitiveHeaders).length === 0 || !this.protectSensitiveHeaders) {
      return undefined;
    }

    let opaque: unknown;
    try {
      opaque = this.protectSensitiveHeaders({ ...sensitiveHeaders });
    } catch (error) {
      throw new Error("Download credentials could not be protected.", { cause: error });
    }
    if (
      typeof opaque !== "string" ||
      opaque.length === 0 ||
      opaque.length > MAX_PROTECTED_HEADERS_LENGTH
    ) {
      throw new Error("Download credential protection returned an invalid payload.");
    }
    return opaque;
  }

  private clearCredentialHeaders(entry: DownloadEntry): void {
    for (const name of Object.keys(entry.headers)) {
      if (isCredentialHeader(name)) delete entry.headers[name];
    }
    delete entry.protectedHeaders;
  }

  public list(): DownloadRecord[] {
    return [...this.entries.values()]
      .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))
      .map((entry) => cloneRecord(entry.record));
  }

  public async pause(id: string): Promise<DownloadRecord> {
    this.assertReady();
    const entry = this.requireEntry(id);
    if (entry.record.status === "completed" || entry.record.status === "cancelled") {
      return cloneRecord(entry.record);
    }

    const active = this.active.get(id);
    if (active) {
      active.intent = "paused";
      active.controller.abort(createAbortError("Download paused"));
    }
    entry.record.status = "paused";
    entry.record.speed = 0;
    entry.record.eta = null;
    for (const segment of entry.record.segments) {
      if (segment.status !== "completed") segment.status = "paused";
    }
    this.emitChanged(entry);

    if (active) await active.promise;
    // runDownload refreshes part sizes before it settles. Avoid doing that a
    // second time here: a concurrently requested resume may already be using
    // those files again.
    await this.persistAndWait();
    return cloneRecord(entry.record);
  }

  public async resume(id: string): Promise<DownloadRecord> {
    this.assertReady();
    const entry = this.requireEntry(id);
    const active = this.active.get(id);
    if (entry.record.status === "paused" && active?.intent === "paused") {
      await active.promise;
    }
    if (
      entry.record.status === "completed" ||
      entry.record.status === "queued" ||
      entry.record.status === "probing" ||
      entry.record.status === "downloading"
    ) {
      return cloneRecord(entry.record);
    }
    if (entry.record.status === "cancelled") {
      throw new Error("A cancelled download cannot be resumed; add it again instead");
    }

    entry.record.status = "queued";
    entry.record.error = null;
    entry.record.speed = 0;
    entry.record.eta = null;
    for (const segment of entry.record.segments) {
      if (segment.status !== "completed") segment.status = "queued";
    }
    this.emitChanged(entry);
    await this.persistAndWait();
    this.pump();
    return cloneRecord(entry.record);
  }

  public async cancel(
    id: string,
    options: CancelDownloadOptions = {},
  ): Promise<void> {
    this.assertReady();
    const entry = this.requireEntry(id);
    if (entry.record.status === "completed") return;

    const active = this.active.get(id);
    if (active) {
      active.intent = "cancelled";
      active.controller.abort(createAbortError("Download cancelled"));
    }
    entry.record.status = "cancelled";
    this.clearCredentialHeaders(entry);
    entry.record.speed = 0;
    entry.record.eta = null;
    this.emitChanged(entry);
    if (active) await active.promise;

    if (options.deleteFiles ?? true) {
      // A destination can only exist here if completion won a race with the
      // abort above. In that case it is known to be a file we just published.
      const publishedWhileCancelling = this.statusOf(id) === "completed";
      await Promise.all([
        this.removeTaskDirectory(id),
        publishedWhileCancelling
          ? removeIfExists(entry.record.destination)
          : Promise.resolve(),
        removeIfExists(this.assemblyPath(entry)),
      ]);
      entry.record.status = "cancelled";
      entry.record.bytesReceived = 0;
      entry.record.progress = 0;
      entry.record.segments = [];
      this.emitChanged(entry);
    }
    await this.persistAndWait();
    this.pump();
  }

  public async remove(
    id: string,
    options: RemoveDownloadOptions = {},
  ): Promise<void> {
    this.assertReady();
    const entry = this.requireEntry(id);
    const active = this.active.get(id);
    if (active) {
      active.intent = "cancelled";
      active.controller.abort(createAbortError("Download removed"));
      await active.promise;
    }

    await this.removeTaskDirectory(id);
    await removeIfExists(this.assemblyPath(entry));
    // An incomplete record has not published its destination. That path may
    // now belong to another download or to a file created after this record
    // was queued, so it must never be deleted on removal.
    if (options.deleteFile && entry.record.status === "completed") {
      await removeIfExists(entry.record.destination);
    }

    this.entries.delete(id);
    this.emit("removed", cloneRecord(entry.record));
    await this.persistAndWait();
    this.pump();
  }

  public setMaxConcurrent(value: number): void {
    this.maxConcurrent = positiveInteger(value, "maxConcurrent");
    if (this.initialized && !this.shuttingDown) this.pump();
  }

  public async shutdown(): Promise<void> {
    if (!this.initialized && !this.initPromise) return;
    if (this.initPromise) await this.initPromise;
    if (!this.initialized) return;

    this.shuttingDown = true;
    const running = [...this.active.values()];
    for (const active of running) {
      active.intent = "shutdown";
      active.controller.abort(createAbortError("Download manager shutting down"));
    }
    await Promise.allSettled(running.map((active) => active.promise));
    try {
      await this.persistAndWait();
    } finally {
      this.initialized = false;
    }
  }

  private assertReady(): void {
    if (!this.initialized || this.shuttingDown) {
      throw new Error("DownloadManager.init() must complete before this operation");
    }
  }

  private requireEntry(id: string): DownloadEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown download id: ${id}`);
    return entry;
  }

  private statusOf(id: string): DownloadStatus {
    return this.requireEntry(id).record.status;
  }

  private pump(): void {
    if (!this.initialized || this.shuttingDown) return;

    while (this.active.size < this.maxConcurrent) {
      const next = [...this.entries.values()]
        .filter((entry) => entry.record.status === "queued" && !this.active.has(entry.record.id))
        .sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt))[0];
      if (!next) break;
      this.launch(next);
    }
  }

  private launch(entry: DownloadEntry): void {
    const active: ActiveDownload = {
      controller: new AbortController(),
      intent: "running",
      promise: Promise.resolve(),
      lastTickAt: Date.now(),
      lastTickBytes: entry.record.bytesReceived,
      persistTick: 0,
    };
    this.active.set(entry.record.id, active);
    active.promise = this.runDownload(entry, active)
      .catch((error: unknown) => {
        this.emit("manager-error", error);
      })
      .finally(() => {
        this.stopProgressTicker(active);
        this.active.delete(entry.record.id);
        this.pump();
      });
  }

  private async runDownload(entry: DownloadEntry, active: ActiveDownload): Promise<void> {
    const { record } = entry;
    try {
      record.status = "probing";
      record.error = null;
      this.emitChanged(entry);

      const probe = await this.probeWithRetries(
        record.url,
        entry.headers,
        entry.segmentsRequested,
        active.controller.signal,
        isGoFileUrl(record.url) ? MAX_RATE_LIMIT_RETRIES + 1 : 3,
      );
      assertProbeResponse(record.url, record.fileName, probe);
      throwIfAborted(active.controller.signal);
      await this.prepareDownload(entry, probe);
      throwIfAborted(active.controller.signal);
      await this.ensureDestinationSpace(entry);
      throwIfAborted(active.controller.signal);

      record.status = "downloading";
      record.error = null;
      for (const segment of record.segments) {
        if (segment.status !== "completed") segment.status = "queued";
      }
      this.emitChanged(entry);
      this.startProgressTicker(entry, active);

      const ranged =
        entry.rangeSupported && record.totalBytes !== null && record.totalBytes > 0;
      if (ranged) {
        await this.downloadRanged(entry, active.controller.signal);
      } else {
        await this.downloadSingle(entry, active.controller.signal);
      }
      throwIfAborted(active.controller.signal);
      await this.finalize(entry, active.controller.signal);
    } catch (error) {
      await this.refreshPartSizes(entry).catch(() => undefined);
      if (active.intent === "paused") {
        record.status = "paused";
        for (const segment of record.segments) {
          if (segment.status !== "completed") segment.status = "paused";
        }
      } else if (active.intent === "cancelled") {
        record.status = "cancelled";
      } else if (active.intent === "shutdown") {
        record.status = "queued";
        for (const segment of record.segments) {
          if (segment.status !== "completed") segment.status = "queued";
        }
      } else {
        record.status = "error";
        record.error = errorMessage(error);
        for (const segment of record.segments) {
          if (segment.status === "downloading") segment.status = "error";
        }
      }
      record.speed = 0;
      record.eta = null;
      this.updateDerived(record);
      this.emitChanged(entry);
    } finally {
      this.stopProgressTicker(active);
      await this.persistAndWait();
    }
  }

  private async prepareDownload(entry: DownloadEntry, probe: ProbeResult): Promise<void> {
    const { record } = entry;
    await this.migrateLegacyParts(entry);
    const oldTotal = record.totalBytes;
    const oldRangeSupported = entry.rangeSupported;
    const oldFinalUrl = entry.finalUrl;
    const oldEtag = entry.etag;
    const oldLastModified = entry.lastModified;
    const hadPartialData =
      record.bytesReceived > 0 || record.segments.some((segment) => segment.bytesReceived > 0);
    const oldValidator = strongEtag(oldEtag) ?? oldLastModified;
    const newValidator = strongEtag(probe.etag) ?? probe.lastModified;
    const validatorCannotResume =
      hadPartialData &&
      !isGoFileUrl(record.url) &&
      (oldValidator === undefined ||
        newValidator === undefined ||
        oldValidator !== newValidator);
    const resourceChanged =
      (oldTotal !== null && probe.totalBytes !== null && oldTotal !== probe.totalBytes) ||
      (hadPartialData && oldFinalUrl !== undefined && oldFinalUrl !== probe.finalUrl) ||
      validatorCannotResume;

    record.totalBytes = probe.totalBytes;
    if (probe.mime) record.mime = probe.mime;
    else delete record.mime;
    entry.rangeSupported = probe.rangeSupported;
    entry.finalUrl = probe.finalUrl;
    entry.etag = probe.etag;
    entry.lastModified = probe.lastModified;

    const ranged =
      probe.rangeSupported && probe.totalBytes !== null && probe.totalBytes > 0;
    const oldRanged = oldRangeSupported && oldTotal !== null && oldTotal > 0;
    const segmentCount = ranged
      ? Math.max(1, Math.min(entry.segmentsRequested, probe.totalBytes as number))
      : 1;
    const desired = makeSegments(probe.totalBytes, segmentCount, ranged);
    const topologyChanged = !sameTopology(record.segments, desired) || oldRanged !== ranged;

    if (resourceChanged || topologyChanged) {
      await this.removeTaskDirectory(record.id);
      record.segments = desired;
    } else {
      record.segments = record.segments.map((segment) => ({
        ...segment,
        status: segment.status === "completed" ? "completed" : "queued",
      }));
    }

    await fs.mkdir(this.taskDirectory(record.id), { recursive: true });
    await this.refreshPartSizes(entry);

    if (!ranged) {
      const segment = record.segments[0];
      if (segment && segment.bytesReceived > 0) {
        const complete =
          record.totalBytes !== null && segment.bytesReceived === record.totalBytes;
        if (!complete) {
          await removeIfExists(this.partPath(record.id, 0));
          segment.bytesReceived = 0;
          segment.status = "queued";
          record.bytesReceived = 0;
        }
      }
    }
    await this.writeTaskManifest(entry);
    this.updateDerived(record);
    this.emitChanged(entry);
  }

  private async downloadRanged(
    entry: DownloadEntry,
    rootSignal: AbortSignal,
  ): Promise<void> {
    const group = new AbortController();
    const abortGroup = (): void => group.abort(rootSignal.reason);
    rootSignal.addEventListener("abort", abortGroup, { once: true });
    if (rootSignal.aborted) abortGroup();

    try {
      let firstError: unknown;
      const transferSegment = async (segment: DownloadSegmentRecord): Promise<void> => {
          if (segment.status === "completed") return;
          try {
            await this.downloadRangeSegment(entry, segment, group.signal);
          } catch (error) {
            if (firstError === undefined) firstError = error;
            if (!group.signal.aborted) group.abort(error);
            throw error;
          }
      };
      if (isGoFileUrl(entry.record.url)) {
        for (const segment of entry.record.segments) {
          await transferSegment(segment);
        }
      } else {
        await Promise.all(entry.record.segments.map(transferSegment)).catch((error: unknown) => {
          throw firstError ?? error;
        });
      }
    } finally {
      rootSignal.removeEventListener("abort", abortGroup);
    }
  }

  private async downloadRangeSegment(
    entry: DownloadEntry,
    segment: DownloadSegmentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (segment.end === null) throw new Error("Ranged segment is missing an end offset");
    const expectedLength = segment.end - segment.start + 1;
    const partPath = this.partPath(entry.record.id, segment.index);

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      const existing = await fileSize(partPath);
      if (existing === expectedLength) {
        segment.bytesReceived = existing;
        segment.status = "completed";
        this.recalculateBytes(entry.record);
        return;
      }
      if (existing > expectedLength) {
        await removeIfExists(partPath);
        segment.bytesReceived = 0;
      } else {
        segment.bytesReceived = existing;
      }
      this.recalculateBytes(entry.record);
      segment.status = "downloading";
      this.emitChanged(entry);

      const requestStart = segment.start + segment.bytesReceived;
      try {
        await this.streamToPart({
          url: entry.record.url,
          headers: this.transferHeaders(entry, {
            Range: `bytes=${requestStart}-${segment.end}`,
          }),
          signal,
          partPath,
          append: segment.bytesReceived > 0,
          expectedRange: {
            start: requestStart,
            end: segment.end,
            total: entry.record.totalBytes,
          },
          expectedResponse: this.transferExpectation(entry),
          onChunk: (size) => {
            segment.bytesReceived += size;
            entry.record.bytesReceived += size;
            this.updateDerived(entry.record);
          },
        });

        const size = await fileSize(partPath);
        segment.bytesReceived = size;
        this.recalculateBytes(entry.record);
        if (size !== expectedLength) {
          throw new RequestFailure(
            `Segment ${segment.index} ended at ${size} of ${expectedLength} bytes`,
            true,
          );
        }
        segment.status = "completed";
        this.emitChanged(entry);
        return;
      } catch (error) {
        segment.bytesReceived = await fileSize(partPath);
        this.recalculateBytes(entry.record);
        if (isAbort(error, signal)) throw error;
        if (!isTransient(error) || attempt >= retryLimit(error)) {
          segment.status = "error";
          throw error;
        }
        segment.retries += 1;
        segment.status = "queued";
        this.emitChanged(entry);
        await abortableDelay(retryDelay(attempt, error), signal);
      }
    }
  }

  private async downloadSingle(entry: DownloadEntry, signal: AbortSignal): Promise<void> {
    const segment = entry.record.segments[0];
    if (!segment) throw new Error("Download has no output segment");
    const partPath = this.partPath(entry.record.id, 0);

    if (
      entry.record.totalBytes !== null &&
      segment.bytesReceived === entry.record.totalBytes &&
      (await pathExists(partPath)) &&
      (await fileSize(partPath)) === entry.record.totalBytes
    ) {
      segment.status = "completed";
      return;
    }

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      throwIfAborted(signal);
      await removeIfExists(partPath);
      segment.bytesReceived = 0;
      entry.record.bytesReceived = 0;
      segment.status = "downloading";
      this.emitChanged(entry);
      try {
        const expectedTotal = entry.record.totalBytes;
        const result = await this.streamToPart({
          url: entry.record.url,
          headers: this.transferHeaders(entry),
          signal,
          partPath,
          append: false,
          expectedResponse: this.transferExpectation(entry),
          onChunk: (size) => {
            segment.bytesReceived += size;
            entry.record.bytesReceived += size;
            this.updateDerived(entry.record);
          },
        });
        const size = await fileSize(partPath);
        const responseLength = parseNonNegativeInteger(header(result.headers, "content-length"));
        if (responseLength !== null && responseLength !== size) {
          throw new RequestFailure(
            `Response ended at ${size} of ${responseLength} bytes`,
            true,
          );
        }
        if (expectedTotal !== null && size !== expectedTotal) {
          throw new RequestFailure(
            `Response ended at ${size} of ${expectedTotal} expected bytes`,
            false,
          );
        }
        entry.record.totalBytes = expectedTotal ?? size;
        const responseMime = mimeFromHeaders(result.headers);
        if (responseMime) entry.record.mime = responseMime;
        segment.end = size === 0 ? null : size - 1;
        segment.bytesReceived = size;
        segment.status = "completed";
        this.recalculateBytes(entry.record);
        this.emitChanged(entry);
        return;
      } catch (error) {
        segment.bytesReceived = await fileSize(partPath);
        this.recalculateBytes(entry.record);
        if (isAbort(error, signal)) throw error;
        if (!isTransient(error) || attempt >= retryLimit(error)) {
          segment.status = "error";
          throw error;
        }
        segment.retries += 1;
        segment.status = "queued";
        this.emitChanged(entry);
        await abortableDelay(retryDelay(attempt, error), signal);
      }
    }
  }

  private transferHeaders(
    entry: DownloadEntry,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    const headers = mergeHeaders(entry.headers, {
      "Accept-Encoding": "identity",
      ...extra,
    });
    const validator = strongEtag(entry.etag) ?? entry.lastModified;
    if (validator && extra.Range) headers["If-Range"] = validator;
    return headers;
  }

  private transferExpectation(entry: DownloadEntry): TransferExpectation {
    return {
      sourceUrl: entry.record.url,
      fileName: entry.record.fileName,
      finalUrl: entry.finalUrl,
      mime: entry.record.mime,
      totalBytes: entry.record.totalBytes,
    };
  }

  private async streamToPart(options: {
    url: string;
    headers: Record<string, string>;
    signal: AbortSignal;
    partPath: string;
    append: boolean;
    expectedRange?: { start: number; end: number; total: number | null };
    expectedResponse: TransferExpectation;
    onChunk: (size: number) => void;
  }): Promise<StreamResult> {
    const opened = await openResponse(
      options.url,
      "GET",
      options.headers,
      options.signal,
    );
    const { response } = opened;
    const status = response.statusCode ?? 0;

    if (isTransientStatus(status)) {
      const retryAfter = parseRetryAfter(header(response.headers, "retry-after"));
      response.resume();
      throw new RequestFailure(`Server returned HTTP ${status}`, true, retryAfter, status);
    }
    try {
      assertTransferResponse(
        options.expectedResponse,
        response.headers,
        opened.finalUrl,
        options.expectedRange !== undefined,
      );
    } catch (error) {
      response.destroy();
      throw error;
    }
    if (options.expectedRange) {
      if (status !== 206) {
        response.destroy();
        throw new RequestFailure(
          `Server stopped honoring byte ranges (HTTP ${status})`,
          false,
        );
      }
      const range = parseContentRange(header(response.headers, "content-range"));
      if (
        !range ||
        range.start !== options.expectedRange.start ||
        range.end !== options.expectedRange.end ||
        (options.expectedRange.total !== null && range.total !== options.expectedRange.total)
      ) {
        response.destroy();
        throw new RequestFailure("Server returned an invalid Content-Range", false);
      }
      const contentEncoding = header(response.headers, "content-encoding");
      if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        response.destroy();
        throw new RequestFailure("Encoded byte-range responses are not safe to combine", false);
      }
      const responseLength = parseNonNegativeInteger(header(response.headers, "content-length"));
      const expectedLength = range.end - range.start + 1;
      if (responseLength !== null && responseLength !== expectedLength) {
        response.destroy();
        throw new RequestFailure("Byte-range response length is inconsistent", false);
      }
    } else if (status < 200 || status >= 300 || status === 206) {
      response.resume();
      throw new RequestFailure(`Server returned HTTP ${status}`, false);
    }

    await fs.mkdir(path.dirname(options.partPath), { recursive: true });
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        options.onChunk(chunk.length);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        response,
        counter,
        createWriteStream(options.partPath, { flags: options.append ? "a" : "w" }),
        { signal: options.signal },
      );
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      throw networkOrDiskFailure(error);
    }
    return { headers: response.headers, finalUrl: opened.finalUrl };
  }

  private async finalize(entry: DownloadEntry, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const { record } = entry;
    if (!record.segments.every((segment) => segment.status === "completed")) {
      throw new Error("Cannot finalize an incomplete download");
    }

    await fs.mkdir(path.dirname(record.destination), { recursive: true });
    if (await pathExists(record.destination)) {
      const destination = await this.findAvailableDestination(
        path.dirname(record.destination),
        record.fileName,
        record.id,
        true,
      );
      record.destination = destination;
      record.fileName = path.basename(destination);
      await this.writeTaskManifest(entry);
    }

    const assembled = this.assemblyPath(entry);
    await removeIfExists(assembled);
    for (let index = 0; index < record.segments.length; index += 1) {
      throwIfAborted(signal);
      await pipeline(
        createReadStream(this.partPath(record.id, record.segments[index].index)),
        createWriteStream(assembled, { flags: index === 0 ? "w" : "a" }),
        { signal },
      );
    }

    const assembledSize = await fileSize(assembled);
    if (record.totalBytes !== null && assembledSize !== record.totalBytes) {
      throw new Error(
        `Assembled file is ${assembledSize} bytes; expected ${record.totalBytes}`,
      );
    }
    record.totalBytes = assembledSize;
    throwIfAborted(signal);
    record.destination = await this.publishWithoutOverwrite(entry, assembled);
    record.fileName = path.basename(record.destination);
    record.bytesReceived = assembledSize;
    record.status = "completed";
    this.clearCredentialHeaders(entry);
    record.speed = 0;
    record.eta = 0;
    record.progress = 100;
    record.error = null;
    this.emitChanged(entry);

    // Publishing is the commit point. Cleanup failures must not turn a file
    // that is already safely visible at its destination into a failed download
    // (or cause a later resume to publish a duplicate).
    const cleanup = await Promise.allSettled([
      removeIfExists(assembled),
      this.removeTaskDirectory(record.id),
    ]);
    for (const result of cleanup) {
      if (result.status === "rejected") this.emit("manager-error", result.reason);
    }
  }

  private async publishWithoutOverwrite(
    entry: DownloadEntry,
    assembled: string,
  ): Promise<string> {
    let destination = entry.record.destination;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await fs.link(assembled, destination);
        return destination;
      } catch (error) {
        const code = errorCode(error);
        if (code === "EEXIST") {
          destination = await this.findAvailableDestination(
            path.dirname(destination),
            entry.record.fileName,
            entry.record.id,
            true,
          );
          continue;
        }
        if (
          code === "EPERM" ||
          code === "ENOSYS" ||
          code === "EOPNOTSUPP" ||
          code === "EXDEV" ||
          code === "EINVAL" ||
          code === "ENOTSUP"
        ) {
          try {
            await fs.copyFile(assembled, destination, fsConstants.COPYFILE_EXCL);
            return destination;
          } catch (copyError) {
            if (errorCode(copyError) === "EEXIST") {
              destination = await this.findAvailableDestination(
                path.dirname(destination),
                entry.record.fileName,
                entry.record.id,
                true,
              );
              continue;
            }
            throw copyError;
          }
        }
        throw error;
      }
    }
    throw new Error("Could not reserve a collision-free destination");
  }

  private startProgressTicker(entry: DownloadEntry, active: ActiveDownload): void {
    this.stopProgressTicker(active);
    active.lastTickAt = Date.now();
    active.lastTickBytes = entry.record.bytesReceived;
    active.persistTick = 0;
    active.ticker = setInterval(() => {
      if (entry.record.status !== "downloading") return;
      const now = Date.now();
      const elapsed = Math.max(1, now - active.lastTickAt);
      const delta = Math.max(0, entry.record.bytesReceived - active.lastTickBytes);
      const instant = (delta * 1_000) / elapsed;
      entry.record.speed =
        delta === 0
          ? entry.record.speed * 0.7
          : entry.record.speed === 0
            ? instant
            : entry.record.speed * 0.55 + instant * 0.45;
      if (entry.record.speed < 1) entry.record.speed = 0;
      active.lastTickAt = now;
      active.lastTickBytes = entry.record.bytesReceived;
      this.updateDerived(entry.record);
      entry.record.updatedAt = new Date().toISOString();
      const snapshot = cloneRecord(entry.record);
      this.emit("progress", snapshot);
      this.emit("changed", snapshot);
      active.persistTick += 1;
      if (active.persistTick % 3 === 0) this.schedulePersist();
    }, PROGRESS_INTERVAL_MS);
    active.ticker.unref?.();
  }

  private stopProgressTicker(active: ActiveDownload): void {
    if (active.ticker) {
      clearInterval(active.ticker);
      active.ticker = undefined;
    }
  }

  private emitChanged(
    entry: DownloadEntry,
    progress = false,
    persist = true,
  ): void {
    entry.record.updatedAt = new Date().toISOString();
    this.updateDerived(entry.record);
    const snapshot = cloneRecord(entry.record);
    if (progress) this.emit("progress", snapshot);
    this.emit("changed", snapshot);
    if (persist) this.schedulePersist();
  }

  private updateDerived(record: DownloadRecord): void {
    if (record.status === "completed") {
      record.progress = 100;
      record.eta = 0;
      return;
    }
    if (record.totalBytes !== null && record.totalBytes > 0) {
      record.progress = clamp((record.bytesReceived / record.totalBytes) * 100, 0, 100);
      record.eta =
        record.speed > 0
          ? Math.max(0, (record.totalBytes - record.bytesReceived) / record.speed)
          : null;
    } else {
      record.progress = 0;
      record.eta = null;
    }
  }

  private recalculateBytes(record: DownloadRecord): void {
    record.bytesReceived = record.segments.reduce(
      (total, segment) => total + segment.bytesReceived,
      0,
    );
    this.updateDerived(record);
  }

  private async refreshPartSizes(entry: DownloadEntry): Promise<void> {
    for (const segment of entry.record.segments) {
      const size = await fileSize(this.partPath(entry.record.id, segment.index));
      const expected =
        segment.end === null ? null : Math.max(0, segment.end - segment.start + 1);
      if (expected !== null && size > expected) {
        await removeIfExists(this.partPath(entry.record.id, segment.index));
        segment.bytesReceived = 0;
        segment.status = "queued";
      } else {
        segment.bytesReceived = size;
        segment.status = expected !== null && size === expected ? "completed" : "queued";
      }
    }
    this.recalculateBytes(entry.record);
  }

  private async recoverEntry(entry: DownloadEntry): Promise<void> {
    const { record } = entry;
    record.speed = 0;
    record.eta = null;

    if (record.status === "completed") {
      const destinationSize = await regularFileSize(record.destination);
      if (destinationSize === null) {
        record.status = "error";
        record.error = "The completed file is missing or is not a regular file";
        record.bytesReceived = 0;
      } else if (record.totalBytes !== null && destinationSize !== record.totalBytes) {
        record.status = "error";
        record.error =
          `The completed file is ${destinationSize} bytes; expected ${record.totalBytes}`;
        record.bytesReceived = destinationSize;
      } else {
        record.totalBytes = destinationSize;
        record.bytesReceived = destinationSize;
        await this.removeTaskDirectory(record.id);
        await removeIfExists(this.assemblyPath(entry));
      }
      this.updateDerived(record);
      return;
    }

    try {
      await this.migrateLegacyParts(entry);
    } catch (error) {
      record.status = "error";
      record.error =
        "Bunni could not move the saved partial download to the destination drive. " +
        "The original partial data was kept and migration will be retried: " +
        errorMessage(error);
      this.updateDerived(record);
      return;
    }

    if (
      (record.status === "queued" ||
        record.status === "probing" ||
        record.status === "downloading") &&
      (await destinationHasExpectedSize(record)) &&
      !(await pathExists(this.taskDirectory(record.id)))
    ) {
      record.status = "completed";
      record.bytesReceived = record.totalBytes ?? (await fileSize(record.destination));
      record.progress = 100;
      record.eta = 0;
      record.error = null;
      await this.removeTaskDirectory(record.id);
      await removeIfExists(this.assemblyPath(entry));
      return;
    }

    if (record.status === "probing" || record.status === "downloading") {
      record.status = "queued";
    }
    await this.refreshPartSizes(entry);
    await this.writeTaskManifest(entry).catch((error: unknown) => {
      this.emit("manager-error", error);
    });
    if (record.status === "paused") {
      for (const segment of record.segments) {
        if (segment.status !== "completed") segment.status = "paused";
      }
    }
    this.updateDerived(record);
  }

  private async probeWithRetries(
    url: string,
    headers: Record<string, string>,
    desiredSegments: number,
    signal?: AbortSignal,
    attempts = 3,
  ): Promise<ProbeResult> {
    let lastError: unknown;
    const maximumAttempts = Math.max(
      attempts,
      attempts > 1 ? MAX_RATE_LIMIT_RETRIES + 1 : attempts,
    );
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await probeUrl(url, headers, desiredSegments, signal);
      } catch (error) {
        lastError = error;
        const allowedAttempts = isRateLimit(error)
          ? maximumAttempts
          : attempts;
        if (!isTransient(error) || attempt + 1 >= allowedAttempts) throw error;
        await abortableDelay(retryDelay(attempt, error), signal);
      }
    }
    throw lastError ?? new Error("Unable to probe download");
  }

  private taskDirectory(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      throw new Error("Invalid persisted download id");
    }
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown download id for temporary storage");
    const partsRoot = path.resolve(path.dirname(entry.record.destination), ".bunni-parts");
    const target = path.resolve(partsRoot, id);
    const rootPrefix = `${partsRoot}${path.sep}`;
    if (!target.startsWith(rootPrefix)) throw new Error("Unsafe temporary path");
    return target;
  }

  private legacyTaskDirectory(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      throw new Error("Invalid persisted download id");
    }
    const target = path.resolve(this.tempRoot, id);
    const rootPrefix = `${path.resolve(this.tempRoot)}${path.sep}`;
    if (!target.startsWith(rootPrefix)) throw new Error("Unsafe legacy temporary path");
    return target;
  }

  private partPath(id: string, index: number): string {
    if (!Number.isInteger(index) || index < 0 || index > MAX_SEGMENTS) {
      throw new Error("Invalid segment index");
    }
    return path.join(this.taskDirectory(id), `${index}.part`);
  }

  private assemblyPath(entry: DownloadEntry): string {
    return `${entry.record.destination}.bunni-${entry.record.id}.tmp`;
  }

  private async removeTaskDirectory(id: string): Promise<void> {
    const current = this.taskDirectory(id);
    const legacy = this.legacyTaskDirectory(id);
    await Promise.all([
      fs.rm(current, { recursive: true, force: true }),
      fs.rm(legacy, { recursive: true, force: true }),
    ]);
    await Promise.all([
      removeEmptyDirectory(path.dirname(current)),
      removeEmptyDirectory(path.dirname(legacy)),
    ]);
  }

  private async migrateLegacyParts(entry: DownloadEntry): Promise<void> {
    const legacyDirectory = this.legacyTaskDirectory(entry.record.id);
    if (!(await pathExists(legacyDirectory))) return;

    await fs.mkdir(this.taskDirectory(entry.record.id), { recursive: true });
    await this.writeTaskManifest(entry);
    const indexes = new Set(entry.record.segments.map((segment) => segment.index));
    for (const item of await fs.readdir(legacyDirectory, { withFileTypes: true })) {
      const match = /^(\d+)\.part$/.exec(item.name);
      if (!item.isFile() || !match) continue;
      const index = Number(match[1]);
      if (Number.isInteger(index) && index >= 0 && index <= MAX_SEGMENTS) {
        indexes.add(index);
      }
    }
    for (const index of indexes) {
      const source = path.join(legacyDirectory, `${index}.part`);
      const destination = this.partPath(entry.record.id, index);
      await migratePartFile(source, destination);
    }
    await removeIfExists(path.join(legacyDirectory, TASK_MANIFEST_NAME));
    // Only remove an empty legacy directory. An unrecognized file is retained
    // rather than risking deletion of data that was not verified at the new
    // location.
    await removeEmptyDirectory(legacyDirectory);
    await removeEmptyDirectory(path.dirname(legacyDirectory));
  }

  private async writeTaskManifest(entry: DownloadEntry): Promise<void> {
    if (entry.record.segments.length === 0) return;
    const directory = this.taskDirectory(entry.record.id);
    await fs.mkdir(directory, { recursive: true });
    const manifest: TaskManifest = {
      version: 1,
      id: entry.record.id,
      sourceUrlHash: urlHash(entry.record.url),
      ...(entry.finalUrl ? { finalUrlHash: urlHash(entry.finalUrl) } : {}),
      fileName: entry.record.fileName,
      destination: entry.record.destination,
      totalBytes: entry.record.totalBytes,
      rangeSupported: entry.rangeSupported,
      segmentsRequested: entry.segmentsRequested,
      segments: entry.record.segments.map((segment) => ({
        index: segment.index,
        start: segment.start,
        end: segment.end,
      })),
      ...(entry.etag ? { etag: entry.etag } : {}),
      ...(entry.lastModified ? { lastModified: entry.lastModified } : {}),
    };
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    const target = path.join(directory, TASK_MANIFEST_NAME);
    const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeDurableFile(temporary, serialized);
      await replaceFile(temporary, target);
    } finally {
      await removeIfExists(temporary).catch(() => undefined);
    }
  }

  private async findMatchingOrphan(
    sourceUrl: string,
    fileName: string,
    directory: string,
    segmentsRequested: number,
    probe: ProbeResult,
  ): Promise<OrphanMatch | undefined> {
    const roots = [
      path.resolve(directory, ".bunni-parts"),
      path.resolve(this.tempRoot),
    ];
    const matches: OrphanMatch[] = [];
    for (const root of roots) {
      let items: import("node:fs").Dirent[];
      try {
        items = await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      for (const item of items) {
        if (!item.isDirectory() || !/^[A-Za-z0-9_-]{1,100}$/.test(item.name)) continue;
        if (this.entries.has(item.name)) continue;
        const taskDirectory = path.resolve(root, item.name);
        const rootPrefix = `${root}${path.sep}`;
        if (!taskDirectory.startsWith(rootPrefix)) continue;
        const manifest = await readTaskManifest(
          path.join(taskDirectory, TASK_MANIFEST_NAME),
          item.name,
        );
        if (
          manifest &&
          orphanManifestMatches(
            manifest,
            sourceUrl,
            fileName,
            directory,
            segmentsRequested,
            probe,
          ) &&
          !(await pathExists(manifest.destination)) &&
          !this.destinationReserved(manifest.destination)
        ) {
          matches.push({ manifest, directory: taskDirectory });
        }
      }
    }

    // Multiple equally-proven candidates are deliberately left untouched;
    // choosing one would be a guess about which user transfer to resume.
    return matches.length === 1 ? matches[0] : undefined;
  }

  private async ensureDestinationSpace(entry: DownloadEntry): Promise<void> {
    const totalBytes = entry.record.totalBytes;
    if (totalBytes === null || totalBytes <= 0) return;

    // An interrupted assembly is reproducible from the part files and would
    // otherwise make the free-space check unnecessarily pessimistic.
    await removeIfExists(this.assemblyPath(entry));
    const directory = path.dirname(entry.record.destination);
    await fs.mkdir(directory, { recursive: true });
    if (typeof fs.statfs !== "function") return;

    let stats: Awaited<ReturnType<typeof fs.statfs>>;
    try {
      stats = await fs.statfs(directory);
    } catch (error) {
      if (isUnsupportedStatFs(error)) return;
      throw error;
    }

    const available = BigInt(stats.bavail) * BigInt(stats.bsize);
    const remainingParts = Math.max(0, totalBytes - entry.record.bytesReceived);
    const required = BigInt(remainingParts) + BigInt(totalBytes);
    if (available >= required) return;

    throw new Error(
      "Not enough free space on the destination drive. " +
        `Bunni needs about ${formatByteCount(required)} free for the remaining parts ` +
        `and final assembly, but only ${formatByteCount(available)} is available.`,
    );
  }

  private async findAvailableDestination(
    directory: string,
    requestedName: string,
    excludeId?: string,
    forceSuffix = false,
  ): Promise<string> {
    const safeName = sanitizeFileName(requestedName);
    const extension = path.extname(safeName);
    const stem = extension ? safeName.slice(0, -extension.length) : safeName;

    for (let index = forceSuffix ? 1 : 0; index < 10_000; index += 1) {
      const suffix = index === 0 ? "" : ` (${index})`;
      const candidateName = truncateFileName(`${stem}${suffix}${extension}`);
      const candidate = path.resolve(directory, candidateName);
      if (this.destinationReserved(candidate, excludeId)) continue;
      if (await pathExists(candidate)) continue;
      // Recheck after the await so concurrently-added records cannot reserve it
      // while the filesystem lookup is in flight.
      if (this.destinationReserved(candidate, excludeId)) continue;
      return candidate;
    }
    throw new Error("Could not find a collision-free destination name");
  }

  private destinationReserved(candidate: string, excludeId?: string): boolean {
    const normalized = normalizePathForComparison(candidate);
    for (const [id, entry] of this.entries) {
      if (id === excludeId) continue;
      if (normalizePathForComparison(entry.record.destination) === normalized) return true;
    }
    return false;
  }

  private schedulePersist(): Promise<void> {
    const operation = this.persistenceChain
      .catch(() => undefined)
      .then(() => this.writeMetadata());
    // Keep the serialization chain usable after a failed write, but return the
    // uncaught operation so public methods that promise durability can reject.
    this.persistenceChain = operation.catch((error: unknown) => {
      this.emit("manager-error", error);
    });
    return operation;
  }

  private async persistAndWait(): Promise<void> {
    await this.schedulePersist();
  }

  private async writeMetadata(): Promise<void> {
    const serializedState = serializePersistedEntries(this.entries.values());
    const nonce = `${process.pid}-${randomUUID()}`;
    const temporaryPath = `${this.metadataPath}.${nonce}.tmp`;
    const temporaryBackupPath = `${this.metadataBackupPath}.${nonce}.tmp`;
    try {
      await writeDurableFile(temporaryPath, serializedState);
      if (!this.skipNextMetadataBackup) {
        try {
          const previous = await fs.readFile(this.metadataPath, "utf8");
          let sanitizedPrevious: string | undefined;
          try {
            sanitizedPrevious = serializePersistedEntries(
              parsePersistedEntries(previous, this.unprotectSensitiveHeaders),
            );
          } catch {
            // Do not replace a known-good backup with externally-corrupted or
            // legacy metadata that cannot be parsed and safely scrubbed.
          }
          if (sanitizedPrevious !== undefined) {
            await writeDurableFile(temporaryBackupPath, sanitizedPrevious);
            await replaceFile(temporaryBackupPath, this.metadataBackupPath);
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      } else {
        // The backup was the recovery source. Rewrite it from the sanitized
        // in-memory representation instead of retaining legacy credentials.
        await writeDurableFile(temporaryBackupPath, serializedState);
        await replaceFile(temporaryBackupPath, this.metadataBackupPath);
      }
      await replaceFile(temporaryPath, this.metadataPath);
      this.skipNextMetadataBackup = false;
    } finally {
      await Promise.all([
        removeIfExists(temporaryPath).catch(() => undefined),
        removeIfExists(temporaryBackupPath).catch(() => undefined),
      ]);
    }
  }

  private async loadMetadata(): Promise<void> {
    let primaryError: unknown;
    try {
      const entries = parsePersistedEntries(
        await fs.readFile(this.metadataPath, "utf8"),
        this.unprotectSensitiveHeaders,
      );
      for (const entry of entries) this.entries.set(entry.record.id, entry);
      return;
    } catch (error) {
      primaryError = error;
    }

    try {
      const entries = parsePersistedEntries(
        await fs.readFile(this.metadataBackupPath, "utf8"),
        this.unprotectSensitiveHeaders,
      );
      for (const entry of entries) this.entries.set(entry.record.id, entry);
      this.skipNextMetadataBackup = true;
      this.emit(
        "manager-error",
        new Error(
          `Recovered downloads metadata from backup after the primary failed: ${errorMessage(primaryError)}`,
        ),
      );
      if (errorCode(primaryError) !== "ENOENT") {
        const corruptPath = `${this.metadataPath}.corrupt-${Date.now()}`;
        await fs.copyFile(this.metadataPath, corruptPath).catch(() => undefined);
      }
      return;
    } catch (backupError) {
      if (errorCode(primaryError) === "ENOENT" && errorCode(backupError) === "ENOENT") return;
      throw new Error(
        `Could not read downloads metadata or its backup: ${errorMessage(primaryError)}; ` +
          errorMessage(backupError),
      );
    }
  }
}

async function probeUrl(
  url: string,
  userHeaders: Record<string, string>,
  desiredSegments: number,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const headers = mergeHeaders(userHeaders, { "Accept-Encoding": "identity" });
  let head: ProbeResult | undefined;
  try {
    const opened = await openResponse(url, "HEAD", headers, signal);
    const status = opened.response.statusCode ?? 0;
    if (status >= 200 && status < 300) {
      head = probeFromHeaders(opened.finalUrl, opened.response.headers, false);
    } else if (isTransientStatus(status)) {
      throw new RequestFailure(`Server returned HTTP ${status}`, true, undefined, status);
    }
    opened.response.resume();
  } catch (error) {
    // A surprising number of otherwise valid download endpoints reject or
    // abruptly close HEAD requests. The byte probe below is authoritative.
    if (isAbort(error, signal)) throw error;
  }

  const shouldVerifyRange = desiredSegments > 1 || !head || head.rangeSupported;
  if (!shouldVerifyRange) {
    return probeFullGet(url, headers, head, signal);
  }

  const rangeHeaders = mergeHeaders(headers, { Range: "bytes=0-0" });
  const opened = await openResponse(url, "GET", rangeHeaders, signal);
  const status = opened.response.statusCode ?? 0;
  const responseHeaders = opened.response.headers;
  if (status === 206) {
    const contentRange = parseContentRange(header(responseHeaders, "content-range"));
    const encoding = header(responseHeaders, "content-encoding");
    const responseLength = parseNonNegativeInteger(header(responseHeaders, "content-length"));
    const rangeSafe =
      contentRange !== null &&
      contentRange.start === 0 &&
      contentRange.end === 0 &&
      (responseLength === null || responseLength === 1) &&
      (!encoding || encoding.toLowerCase() === "identity");
    if (rangeSafe) {
      const result = probeFromHeaders(opened.finalUrl, responseHeaders, true);
      if (contentRange.total !== null) result.totalBytes = contentRange.total;
      opened.response.destroy();
      return mergeProbe(head, result);
    }

    // A malformed or encoded range response is not safe to segment. Validate
    // the ordinary representation with a second GET before accepting it.
    opened.response.destroy();
    return probeFullGet(url, headers, head, signal);
  }
  if (status >= 200 && status < 300) {
    const result = probeFromHeaders(opened.finalUrl, responseHeaders, false);
    // This GET was sent with Range: bytes=0-0. A normal 2xx response proves
    // that ranges are ignored, while still validating the real GET endpoint.
    result.rangeSupported = false;
    opened.response.destroy();
    return mergeProbe(head, result);
  }
  if (isRangeProbeRejectionStatus(status)) {
    opened.response.destroy();
    return probeFullGet(url, headers, head, signal);
  }

  const retryAfter = parseRetryAfter(header(responseHeaders, "retry-after"));
  opened.response.resume();
  throw new RequestFailure(
    `Server returned HTTP ${status}`,
    isTransientStatus(status),
    retryAfter,
    status,
  );
}

async function probeFullGet(
  url: string,
  headers: Record<string, string>,
  head: ProbeResult | undefined,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const opened = await openResponse(url, "GET", headers, signal);
  const status = opened.response.statusCode ?? 0;
  const responseHeaders = opened.response.headers;
  if (status >= 200 && status < 300 && status !== 206) {
    const result = probeFromHeaders(opened.finalUrl, responseHeaders, false);
    result.rangeSupported = false;
    opened.response.destroy();
    return mergeProbe(head, result);
  }

  const retryAfter = parseRetryAfter(header(responseHeaders, "retry-after"));
  opened.response.resume();
  throw new RequestFailure(
    `Server returned HTTP ${status}`,
    isTransientStatus(status),
    retryAfter,
    status,
  );
}

function probeFromHeaders(
  finalUrl: string,
  headers: http.IncomingHttpHeaders,
  verifiedRange: boolean,
): ProbeResult {
  return {
    finalUrl,
    totalBytes: parseNonNegativeInteger(header(headers, "content-length")),
    rangeSupported:
      verifiedRange || /(^|,)\s*bytes\s*(,|$)/i.test(header(headers, "accept-ranges") ?? ""),
    fileName: fileNameFromDisposition(header(headers, "content-disposition")),
    mime: mimeFromHeaders(headers),
    etag: header(headers, "etag"),
    lastModified: header(headers, "last-modified"),
  };
}

function mergeProbe(head: ProbeResult | undefined, next: ProbeResult): ProbeResult {
  if (!head) return next;
  const sizeMismatch =
    head.totalBytes !== null &&
    next.totalBytes !== null &&
    head.totalBytes !== next.totalBytes
      ? { expected: head.totalBytes, actual: next.totalBytes }
      : undefined;
  return {
    finalUrl: next.finalUrl,
    totalBytes: head.totalBytes ?? next.totalBytes,
    rangeSupported: next.rangeSupported,
    fileName: next.fileName ?? head.fileName,
    mime: next.mime ?? head.mime,
    etag: next.etag ?? head.etag,
    lastModified: next.lastModified ?? head.lastModified,
    sizeMismatch,
  };
}

function isRangeProbeRejectionStatus(status: number): boolean {
  return [400, 405, 406, 412, 416, 501].includes(status);
}

async function openResponse(
  inputUrl: string,
  method: "GET" | "HEAD",
  headers: Record<string, string>,
  signal?: AbortSignal,
  redirectCount = 0,
): Promise<OpenedResponse> {
  throwIfAborted(signal);
  const url = validateHttpUrl(inputUrl);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise<OpenedResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      { method, headers, signal },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new RequestFailure("Too many HTTP redirects", false));
            return;
          }
          let redirected: URL;
          try {
            redirected = new URL(location, url);
          } catch {
            reject(new RequestFailure("Server returned an invalid redirect URL", false));
            return;
          }
          let redirectedHeaders = { ...headers };
          if (redirected.origin !== url.origin) {
            redirectedHeaders = withoutSensitiveHeaders(redirectedHeaders);
          }
          openResponse(
            redirected.toString(),
            method,
            redirectedHeaders,
            signal,
            redirectCount + 1,
          ).then(resolve, reject);
          return;
        }
        resolve({ response, finalUrl: url.toString() });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      const timeout = new RequestFailure("HTTP request timed out", true);
      Object.assign(timeout, { code: "ETIMEDOUT" });
      request.destroy(timeout);
    });
    request.once("error", reject);
    request.end();
  });
}

function makeSegments(
  totalBytes: number | null,
  count: number,
  ranged: boolean,
): DownloadSegmentRecord[] {
  if (!ranged || totalBytes === null || totalBytes <= 0) {
    return [
      {
        index: 0,
        start: 0,
        end: totalBytes !== null && totalBytes > 0 ? totalBytes - 1 : null,
        bytesReceived: 0,
        status: "queued",
        retries: 0,
      },
    ];
  }
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((totalBytes * index) / count);
    const end = Math.floor((totalBytes * (index + 1)) / count) - 1;
    return {
      index,
      start,
      end,
      bytesReceived: 0,
      status: "queued" as const,
      retries: 0,
    };
  });
}

function sameTopology(
  current: DownloadSegmentRecord[],
  desired: DownloadSegmentRecord[],
): boolean {
  return (
    current.length === desired.length &&
    current.every(
      (segment, index) =>
        segment.index === desired[index].index &&
        segment.start === desired[index].start &&
        segment.end === desired[index].end,
    )
  );
}

function serializePersistedEntries(entries: Iterable<DownloadEntry>): string {
  const state: PersistedState = {
    version: METADATA_VERSION,
    entries: [...entries].map((entry) => ({
      record: cloneRecord(entry.record),
      headers: headersForPersistence(entry.headers),
      protectedHeaders: entry.protectedHeaders,
      segmentsRequested: entry.segmentsRequested,
      rangeSupported: entry.rangeSupported,
      etag: entry.etag,
      lastModified: entry.lastModified,
    })),
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}

function parsePersistedEntries(
  text: string,
  unprotectSensitiveHeaders?: (opaque: string) => Record<string, string>,
): DownloadEntry[] {
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed) || parsed.version !== METADATA_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error("Unsupported downloads metadata format");
  }

  const entries: DownloadEntry[] = [];
  const ids = new Set<string>();
  for (const value of parsed.entries) {
    const entry = deserializeEntry(value, unprotectSensitiveHeaders);
    if (!entry) throw new Error("Downloads metadata contains an invalid entry");
    if (ids.has(entry.record.id)) {
      throw new Error(`Downloads metadata contains duplicate id ${entry.record.id}`);
    }
    ids.add(entry.record.id);
    entries.push(entry);
  }
  return entries;
}

function deserializeEntry(
  value: unknown,
  unprotectSensitiveHeaders?: (opaque: string) => Record<string, string>,
): DownloadEntry | null {
  if (!isObject(value) || !isObject(value.record)) return null;
  const recordValue = value.record;
  const id = stringValue(recordValue.id);
  const url = stringValue(recordValue.url);
  const fileName = stringValue(recordValue.fileName);
  const destination = stringValue(recordValue.destination);
  const status = recordValue.status;
  if (
    !id ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
    !url ||
    !fileName ||
    !destination ||
    !isDownloadStatus(status)
  ) {
    return null;
  }
  try {
    validateHttpUrl(url);
  } catch {
    return null;
  }

  const segments = Array.isArray(recordValue.segments)
    ? recordValue.segments.flatMap((item): DownloadSegmentRecord[] => {
        if (!isObject(item)) return [];
        const index = finiteInteger(item.index);
        const start = finiteInteger(item.start);
        const end = item.end === null ? null : finiteInteger(item.end);
        const bytesReceived = finiteInteger(item.bytesReceived);
        const segmentStatus = item.status;
        const retries = finiteInteger(item.retries) ?? 0;
        if (
          index === null ||
          index < 0 ||
          index > MAX_SEGMENTS ||
          start === null ||
          start < 0 ||
          (end !== null && end < start) ||
          bytesReceived === null ||
          bytesReceived < 0 ||
          !isSegmentStatus(segmentStatus)
        ) {
          return [];
        }
        return [{ index, start, end, bytesReceived, status: segmentStatus, retries }];
      })
    : [];
  const totalBytes =
    recordValue.totalBytes === null ? null : nonNegativeNumber(recordValue.totalBytes);
  const createdAt = stringValue(recordValue.createdAt) ?? new Date().toISOString();
  const updatedAt = stringValue(recordValue.updatedAt) ?? createdAt;
  const persistedMime = stringValue(recordValue.mime);
  const record: DownloadRecord = {
    id,
    url,
    fileName: sanitizeFileName(fileName),
    destination: path.resolve(destination),
    status,
    bytesReceived: nonNegativeNumber(recordValue.bytesReceived) ?? 0,
    totalBytes,
    speed: 0,
    eta: null,
    progress: clamp(nonNegativeNumber(recordValue.progress) ?? 0, 0, 100),
    segments,
    createdAt,
    updatedAt,
    error: recordValue.error === null ? null : (stringValue(recordValue.error) ?? null),
    ...(persistedMime ? { mime: persistedMime } : {}),
  };
  const headers: Record<string, string> = {};
  if (isObject(value.headers)) {
    for (const [key, item] of Object.entries(value.headers)) {
      if (
        typeof item === "string" &&
        !containsNewline(key) &&
        !containsNewline(item) &&
        !isCredentialHeader(key)
      ) {
        headers[key] = item;
      }
    }
  }
  let protectedHeaders: string | undefined;
  let credentialRestoreFailed = false;
  const credentialsStillNeeded = record.status !== "completed" && record.status !== "cancelled";
  if (value.protectedHeaders !== undefined && credentialsStillNeeded) {
    if (
      typeof value.protectedHeaders !== "string" ||
      value.protectedHeaders.length === 0 ||
      value.protectedHeaders.length > MAX_PROTECTED_HEADERS_LENGTH
    ) {
      credentialRestoreFailed = true;
    } else {
      protectedHeaders = value.protectedHeaders;
      if (!unprotectSensitiveHeaders) {
        credentialRestoreFailed = true;
      } else {
        try {
          const restored = validateRestoredSensitiveHeaders(
            unprotectSensitiveHeaders(protectedHeaders),
          );
          Object.assign(headers, mergeHeaders(headers, restored));
        } catch {
          credentialRestoreFailed = true;
        }
      }
    }
  }
  if (credentialRestoreFailed) {
    record.status = "error";
    record.error = PROTECTED_HEADERS_ERROR;
    record.speed = 0;
    record.eta = null;
  }
  const persistedRequested = finiteInteger(value.segmentsRequested);
  const requested = persistedRequested !== null && persistedRequested > 0
    ? persistedRequested
    : 1;
  return {
    record,
    headers,
    protectedHeaders,
    segmentsRequested: boundedSegments(requested),
    rangeSupported: value.rangeSupported === true,
    etag: stringValue(value.etag),
    lastModified: stringValue(value.lastModified),
  };
}

function isDownloadStatus(value: unknown): value is DownloadStatus {
  return [
    "queued",
    "probing",
    "downloading",
    "paused",
    "completed",
    "cancelled",
    "error",
  ].includes(String(value));
}

function isSegmentStatus(value: unknown): value is DownloadSegmentStatus {
  return ["queued", "downloading", "paused", "completed", "error"].includes(
    String(value),
  );
}

function cloneRecord(record: DownloadRecord): DownloadRecord {
  return {
    ...record,
    segments: record.segments.map((segment) => ({ ...segment })),
  };
}

function validateHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Download URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Only HTTP and HTTPS download URLs are supported");
  }
  return url;
}

function resolveDownloadDirectory(baseDirectory: string, requested?: string): string {
  if (!requested) return baseDirectory;
  return path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(baseDirectory, requested);
}

function sanitizeFileName(input: string): string {
  let value = input.normalize("NFKC").replace(/\\/g, "/");
  value = path.posix.basename(value);
  value = value
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!value || value === "." || value === "..") value = "download";
  const stem = value.split(".")[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) value = `_${value}`;
  return truncateFileName(value);
}

function truncateFileName(value: string, maxLength = 180): string {
  if (value.length <= maxLength) return value;
  const extension = path.extname(value);
  const extensionLimit = Math.min(extension.length, 30);
  const safeExtension = extension.slice(0, extensionLimit);
  return `${value.slice(0, Math.max(1, maxLength - safeExtension.length))}${safeExtension}`;
}

function fileNameFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (!last) return undefined;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return undefined;
  }
}

function fileNameFromDisposition(value?: string): string | undefined {
  if (!value) return undefined;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*([^;]+)/i.exec(value)?.[1]?.trim();
  if (encoded) {
    const unquoted = stripQuotes(encoded);
    const match = /^([^']*)'[^']*'(.*)$/.exec(unquoted);
    const payload = match?.[2] ?? unquoted;
    try {
      return decodeURIComponent(payload);
    } catch {
      // Fall through to the basic filename parameter.
    }
  }
  const basic = /(?:^|;)\s*filename\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/i.exec(value)?.[1];
  if (!basic) return undefined;
  return stripQuotes(basic.trim()).replace(/\\(["\\])/g, "$1");
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function normalizeUserHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (!name || containsNewline(name) || containsNewline(value)) {
      throw new TypeError("HTTP header names and values cannot contain newlines");
    }
    if (["range", "if-range", "accept-encoding", "content-length"].includes(name.toLowerCase())) {
      continue;
    }
    http.validateHeaderName(name);
    http.validateHeaderValue(name, String(value));
    normalized[name] = String(value);
  }
  return normalized;
}

function mergeHeaders(
  base: Record<string, string>,
  additions: Record<string, string>,
): Record<string, string> {
  const result = { ...base };
  for (const [newName, value] of Object.entries(additions)) {
    for (const existingName of Object.keys(result)) {
      if (existingName.toLowerCase() === newName.toLowerCase()) delete result[existingName];
    }
    result[newName] = value;
  }
  return result;
}

function isCredentialHeader(name: string): boolean {
  return CREDENTIAL_HEADER_NAMES.has(name.toLowerCase());
}

function sensitiveHeadersOnly(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isCredentialHeader(name)) result[name] = value;
  }
  return result;
}

function validateRestoredSensitiveHeaders(value: unknown): Record<string, string> {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("Stored download credentials are invalid");
  }
  const result: Record<string, string> = {};
  const names = new Set<string>();
  for (const [name, item] of Object.entries(value)) {
    const normalizedName = name.toLowerCase();
    if (
      !isCredentialHeader(name) ||
      names.has(normalizedName) ||
      typeof item !== "string" ||
      containsNewline(name) ||
      containsNewline(item)
    ) {
      throw new Error("Stored download credentials are invalid");
    }
    http.validateHeaderName(name);
    http.validateHeaderValue(name, item);
    names.add(normalizedName);
    result[name] = item;
  }
  if (names.size === 0) throw new Error("Stored download credentials are empty");
  return result;
}

function headersForPersistence(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialHeader(name)) result[name] = value;
  }
  return result;
}

function withoutSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialHeader(name) && name.toLowerCase() !== "host") {
      result[name] = value;
    }
  }
  return result;
}

function header(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function mimeFromHeaders(headers: http.IncomingHttpHeaders): string | undefined {
  return header(headers, "content-type")?.split(";", 1)[0]?.trim() || undefined;
}

function assertExpectedFileResponse(
  sourceUrl: string,
  requestedFileName: string | undefined,
  responseMime: string | undefined,
): void {
  if (!isHtmlMime(responseMime)) return;
  const expectedName = requestedFileName ?? fileNameFromUrl(sourceUrl);
  if (expectedName && isClearlyNonHtmlFileName(expectedName)) {
    throw new RequestFailure(HTML_RESPONSE_ERROR, false);
  }
}

function assertProbeResponse(
  sourceUrl: string,
  requestedFileName: string | undefined,
  probe: ProbeResult,
): void {
  // Prefer the actionable browser-session error over a secondary size change
  // when an authentication or landing page replaced the requested file.
  assertExpectedFileResponse(sourceUrl, requestedFileName, probe.mime);
  if (probe.sizeMismatch) {
    throw new RequestFailure(
      `The server returned ${probe.sizeMismatch.actual} bytes; ` +
        `expected ${probe.sizeMismatch.expected}. The link may be expired or have changed.`,
      false,
    );
  }
}

function assertTransferResponse(
  expected: TransferExpectation,
  responseHeaders: http.IncomingHttpHeaders,
  finalUrl: string,
  ranged: boolean,
): void {
  const responseMime = mimeFromHeaders(responseHeaders);
  assertExpectedFileResponse(expected.sourceUrl, expected.fileName, responseMime);

  if (expected.finalUrl !== undefined && finalUrl !== expected.finalUrl) {
    throw new RequestFailure(
      "The download redirected to a different resource than the initial check. " +
        "The link may be expired or require your browser session.",
      false,
    );
  }

  if (
    expected.mime !== undefined &&
    responseMime !== undefined &&
    normalizeMime(expected.mime) !== normalizeMime(responseMime)
  ) {
    throw new RequestFailure(
      `The server changed the response type from ${expected.mime} to ${responseMime}. ` +
        "The link may be expired or require your browser session.",
      false,
    );
  }

  if (!ranged && expected.totalBytes !== null) {
    const responseLength = parseNonNegativeInteger(header(responseHeaders, "content-length"));
    if (responseLength !== null && responseLength !== expected.totalBytes) {
      throw new RequestFailure(
        `The server returned ${responseLength} bytes; expected ${expected.totalBytes}. ` +
          "The link may be expired or have changed.",
        false,
      );
    }
  }
}

function normalizeMime(value: string): string {
  return value.trim().toLowerCase();
}

function isHtmlMime(value?: string): boolean {
  return value !== undefined && HTML_MIME_TYPES.has(normalizeMime(value));
}

function isClearlyNonHtmlFileName(value: string): boolean {
  const portableName = value.replace(/\\/g, "/");
  const extension = path.posix.extname(path.posix.basename(portableName)).toLowerCase();
  return extension.length > 0 && !HTML_CAPABLE_EXTENSIONS.has(extension);
}

function parseContentRange(
  value?: string,
): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total < 0)) return null;
  if (total !== null && end >= total) return null;
  return { start, end, total };
}

function parseNonNegativeInteger(value?: string): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseRetryAfter(value?: string): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Math.min(MAX_RETRY_AFTER_MS, Number(value) * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : clamp(date - Date.now(), 0, MAX_RETRY_AFTER_MS);
}

function strongEtag(value?: string): string | undefined {
  return value && !/^W\//i.test(value) ? value : undefined;
}

function isTransientStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isTransient(error: unknown): boolean {
  if (error instanceof RequestFailure) return error.transient;
  const code = errorCode(error);
  return [
    "ABORT_ERR",
    "ECONNRESET",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
  ].includes(code ?? "");
}

function isRateLimit(error: unknown): boolean {
  return error instanceof RequestFailure && error.statusCode === 429;
}

function retryLimit(error: unknown): number {
  return isRateLimit(error) ? MAX_RATE_LIMIT_RETRIES : MAX_RETRIES;
}

function networkOrDiskFailure(error: unknown): Error {
  const code = errorCode(error);
  const diskCodes = ["EACCES", "EDQUOT", "ENOSPC", "EROFS"];
  if (code && diskCodes.includes(code)) return errorAsError(error);
  const failure = new RequestFailure(errorMessage(error), true);
  if (code) Object.assign(failure, { code });
  return failure;
}

function retryDelay(attempt: number, error: unknown): number {
  if (error instanceof RequestFailure && error.retryAfterMs !== undefined) {
    return error.retryAfterMs;
  }
  if (isRateLimit(error)) {
    const base = Math.min(60_000, 2_000 * 2 ** attempt);
    return Math.round(base * (0.9 + Math.random() * 0.2));
  }
  const base = Math.min(8_000, 400 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function isGoFileUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.$/, "");
    return hostname === "gofile.io" || hostname.endsWith(".gofile.io");
  } catch {
    return false;
  }
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(createAbortError("Operation aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    if (signal?.aborted) abort();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? createAbortError("Operation aborted");
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError") ||
    errorCode(error) === "ABORT_ERR"
  );
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  Object.assign(error, { code: "ABORT_ERR" });
  return error;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function boundedSegments(value: number): number {
  return Math.min(MAX_SEGMENTS, positiveInteger(value, "segments"));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function containsNewline(value: string): boolean {
  return /[\r\n]/.test(value);
}

function normalizePathForComparison(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function urlHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readTaskManifest(
  manifestPath: string,
  expectedId: string,
): Promise<TaskManifest | undefined> {
  try {
    const stat = await fs.stat(manifestPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TASK_MANIFEST_BYTES) return undefined;
    const value: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    if (!isObject(value) || value.version !== 1 || value.id !== expectedId) return undefined;
    if (
      typeof value.sourceUrlHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sourceUrlHash) ||
      (value.finalUrlHash !== undefined &&
        (typeof value.finalUrlHash !== "string" || !/^[a-f0-9]{64}$/.test(value.finalUrlHash))) ||
      typeof value.fileName !== "string" ||
      !value.fileName ||
      value.fileName !== path.basename(value.fileName) ||
      typeof value.destination !== "string" ||
      !path.isAbsolute(value.destination) ||
      path.basename(value.destination) !== value.fileName ||
      (value.totalBytes !== null &&
        (typeof value.totalBytes !== "number" ||
          !Number.isSafeInteger(value.totalBytes) ||
          value.totalBytes < 0)) ||
      typeof value.rangeSupported !== "boolean" ||
      typeof value.segmentsRequested !== "number" ||
      !Number.isInteger(value.segmentsRequested) ||
      value.segmentsRequested < 1 ||
      value.segmentsRequested > MAX_SEGMENTS ||
      !Array.isArray(value.segments) ||
      value.segments.length < 1 ||
      value.segments.length > MAX_SEGMENTS
    ) {
      return undefined;
    }

    const segments: TaskManifest["segments"] = [];
    const indexes = new Set<number>();
    for (const item of value.segments) {
      if (!isObject(item)) return undefined;
      const index = finiteInteger(item.index);
      const start = finiteInteger(item.start);
      const end = item.end === null ? null : finiteInteger(item.end);
      if (
        index === null ||
        index < 0 ||
        index >= MAX_SEGMENTS ||
        indexes.has(index) ||
        start === null ||
        start < 0 ||
        (end !== null && end < start)
      ) {
        return undefined;
      }
      indexes.add(index);
      segments.push({ index, start, end });
    }
    segments.sort((left, right) => left.index - right.index);

    const optionalText = (item: unknown): string | undefined =>
      typeof item === "string" && item.length > 0 && item.length <= 8_192 && !containsNewline(item)
        ? item
        : undefined;
    if (value.etag !== undefined && optionalText(value.etag) === undefined) return undefined;
    if (value.lastModified !== undefined && optionalText(value.lastModified) === undefined) return undefined;

    return {
      version: 1,
      id: expectedId,
      sourceUrlHash: value.sourceUrlHash,
      ...(typeof value.finalUrlHash === "string" ? { finalUrlHash: value.finalUrlHash } : {}),
      fileName: value.fileName,
      destination: path.resolve(value.destination),
      totalBytes: value.totalBytes as number | null,
      rangeSupported: value.rangeSupported,
      segmentsRequested: value.segmentsRequested,
      segments,
      ...(typeof value.etag === "string" ? { etag: value.etag } : {}),
      ...(typeof value.lastModified === "string" ? { lastModified: value.lastModified } : {}),
    };
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    return undefined;
  }
}

function orphanManifestMatches(
  manifest: TaskManifest,
  sourceUrl: string,
  fileName: string,
  directory: string,
  segmentsRequested: number,
  probe: ProbeResult,
): boolean {
  const goFile = isGoFileUrl(sourceUrl);
  if (
    !manifest.rangeSupported ||
    !probe.rangeSupported ||
    probe.totalBytes === null ||
    probe.totalBytes <= 0 ||
    manifest.totalBytes !== probe.totalBytes ||
    manifest.sourceUrlHash !== urlHash(sourceUrl) ||
    manifest.finalUrlHash !== urlHash(probe.finalUrl) ||
    manifest.fileName !== fileName ||
    (!goFile &&
      normalizePathForComparison(path.dirname(manifest.destination)) !==
        normalizePathForComparison(directory)) ||
    (!goFile && manifest.segmentsRequested !== segmentsRequested)
  ) {
    return false;
  }

  const oldValidator = strongEtag(manifest.etag) ?? manifest.lastModified;
  const newValidator = strongEtag(probe.etag) ?? probe.lastModified;
  if (oldValidator !== undefined && oldValidator !== newValidator) return false;
  if (oldValidator === undefined && !goFile) return false;

  const topologySegments = goFile ? manifest.segmentsRequested : segmentsRequested;
  const count = Math.max(1, Math.min(topologySegments, probe.totalBytes));
  const desired = makeSegments(probe.totalBytes, count, true);
  if (manifest.segments.length !== desired.length) return false;
  return manifest.segments.every((segment, index) => {
    const expected = desired[index];
    return expected !== undefined &&
      segment.index === expected.index &&
      segment.start === expected.start &&
      segment.end === expected.end;
  });
}

async function orphanSegmentsWithSizes(match: OrphanMatch): Promise<DownloadSegmentRecord[]> {
  const result: DownloadSegmentRecord[] = [];
  for (const segment of match.manifest.segments) {
    const part = path.join(match.directory, `${segment.index}.part`);
    const size = (await regularFileSize(part)) ?? 0;
    const expected = segment.end === null ? 0 : segment.end - segment.start + 1;
    if (size > expected) throw new Error("Saved orphan part is larger than its verified segment");
    result.push({
      ...segment,
      bytesReceived: size,
      status: size === expected ? "completed" : "queued",
      retries: 0,
    });
  }
  return result;
}

async function writeDurableFile(filePath: string, contents: string): Promise<void> {
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    // Windows does not consistently allow rename() to replace an existing
    // file. The previous complete metadata generation is kept in .bak before
    // this fallback can overwrite the primary in place.
    const code = errorCode(error) ?? "";
    if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
    await fs.copyFile(source, destination);
    await removeIfExists(source).catch(() => undefined);
  }
}

async function migratePartFile(source: string, destination: string): Promise<void> {
  const sourceSize = await regularFileSize(source);
  if (sourceSize === null) {
    if (await pathExists(source)) {
      throw new Error(`Legacy part is not a regular file: ${source}`);
    }
    return;
  }

  const existingSize = await regularFileSize(destination);
  if (existingSize !== null && existingSize >= sourceSize) {
    await removeIfExists(source);
    await removeIfExists(`${destination}.migrating`).catch(() => undefined);
    return;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.migrating`;
  let lastError: unknown;
  for (let attempt = 0; attempt < MIGRATION_RETRIES; attempt += 1) {
    try {
      await fs.copyFile(source, temporary);
      const copiedSize = await regularFileSize(temporary);
      if (copiedSize !== sourceSize) {
        throw new Error(
          `Migrated part verification failed: copied ${copiedSize ?? "no"} bytes; expected ${sourceSize}`,
        );
      }
      try {
        await fs.rename(temporary, destination);
      } catch (error) {
        const code = errorCode(error) ?? "";
        if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
        await removeIfExists(destination);
        await fs.rename(temporary, destination);
      }
      const installedSize = await regularFileSize(destination);
      if (installedSize !== sourceSize) {
        throw new Error(
          `Migrated part verification failed: installed ${installedSize ?? "no"} bytes; expected ${sourceSize}`,
        );
      }
      await removeIfExists(source);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < MIGRATION_RETRIES) {
        await abortableDelay(50 * 2 ** attempt);
      }
    }
  }
  throw errorAsError(lastError);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(error) ?? "")) {
      // Removing a shared empty root is cosmetic. Leave it in place if the
      // platform or another process currently prevents removal.
    }
  }
}

function isUnsupportedStatFs(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL"].includes(errorCode(error) ?? "");
}

function formatByteCount(bytes: bigint): string {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unit = 0;
  let divisor = 1n;
  while (unit + 1 < units.length && bytes >= divisor * 1024n) {
    divisor *= 1024n;
    unit += 1;
  }
  if (unit === 0) return `${bytes} B`;
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
}

async function fileSize(value: string): Promise<number> {
  try {
    return (await fs.stat(value)).size;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function regularFileSize(value: string): Promise<number | null> {
  try {
    const stat = await fs.stat(value);
    return stat.isFile() ? stat.size : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function removeIfExists(value: string): Promise<void> {
  try {
    await fs.unlink(value);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function destinationHasExpectedSize(record: DownloadRecord): Promise<boolean> {
  if (record.totalBytes === null) return false;
  return (await regularFileSize(record.destination)) === record.totalBytes;
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorAsError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
