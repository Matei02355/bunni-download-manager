export type CaptureState =
  | "pending"
  | "accepted"
  | "accepted-paused"
  | "rejected"
  | "error";

export type CaptureAction = "start" | "later" | "cancel";

export interface CaptureDownload {
  id: string;
  status: string;
  error?: string | null;
}

export interface CaptureRecord<TDownload extends CaptureDownload = CaptureDownload> {
  id: string;
  state: CaptureState;
  download: TDownload;
}

export interface CaptureTarget {
  fileName?: string;
  directory?: string;
}

export interface CaptureResponse extends CaptureTarget {
  id: string;
  action: CaptureAction;
}

export interface CaptureBrokerOptions<
  TRequest,
  TDownload extends CaptureDownload
> {
  createPaused: (request: TRequest) => Promise<TDownload>;
  retarget: (id: string, target: CaptureTarget) => Promise<TDownload>;
  resume: (id: string) => Promise<TDownload>;
  remove: (id: string) => Promise<void>;
  onRequested: (capture: CaptureRecord<TDownload>) => void;
  onChanged?: (capture: CaptureRecord<TDownload>) => void;
  onError?: (error: unknown) => void;
  maxEntries?: number;
  pendingTtlMs?: number;
  terminalTtlMs?: number;
}

interface CaptureEntry<TDownload extends CaptureDownload> {
  capture: CaptureRecord<TDownload>;
  createdAt: number;
  timer?: NodeJS.Timeout;
  operation?: Promise<CaptureRecord<TDownload>>;
}

const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_PENDING_TTL_MS = 5 * 60_000;
const DEFAULT_TERMINAL_TTL_MS = 10 * 60_000;

/**
 * Owns the short-lived handshake between the browser and the desktop window.
 * Download credentials stay in DownloadManager; this broker only keeps the
 * manager's public DownloadRecord clone.
 */
export class CaptureBroker<TRequest, TDownload extends CaptureDownload> {
  private readonly entries = new Map<string, CaptureEntry<TDownload>>();
  private readonly maxEntries: number;
  private readonly pendingTtlMs: number;
  private readonly terminalTtlMs: number;
  private shuttingDown = false;

  constructor(private readonly options: CaptureBrokerOptions<TRequest, TDownload>) {
    this.maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "maxEntries");
    this.pendingTtlMs = positiveInteger(options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS, "pendingTtlMs");
    this.terminalTtlMs = positiveInteger(options.terminalTtlMs ?? DEFAULT_TERMINAL_TTL_MS, "terminalTtlMs");
  }

  async create(request: TRequest): Promise<CaptureRecord<TDownload>> {
    if (this.shuttingDown) throw new Error("Browser capture is shutting down.");
    await this.makeRoom();

    const download = await this.options.createPaused(request);
    if (!validId(download.id)) {
      throw new Error("The prepared download returned an invalid identifier.");
    }
    if (this.entries.has(download.id)) {
      throw new Error("A capture with this identifier already exists.");
    }
    if (download.status !== "paused" && download.status !== "error") {
      try {
        await this.options.remove(download.id);
      } catch (error) {
        this.report(error);
      }
      throw new Error("The prepared download did not remain paused.");
    }

    const state: CaptureState = download.status === "error" ? "error" : "pending";
    const entry: CaptureEntry<TDownload> = {
      capture: { id: download.id, state, download: cloneDownload(download) },
      createdAt: Date.now()
    };
    this.entries.set(download.id, entry);
    this.schedule(entry, state === "pending" ? this.pendingTtlMs : this.terminalTtlMs);

    const capture = cloneCapture(entry.capture);
    if (state === "pending") {
      try {
        this.options.onRequested(capture);
      } catch (error) {
        this.report(error);
      }
    } else {
      // A failed admission never reaches the confirmation dialog. Remove its
      // temporary manager record immediately so the renderer cannot retain a
      // dead Retry row while Chrome keeps the original download.
      try {
        await this.options.remove(download.id);
      } catch (error) {
        this.report(error);
      }
    }
    return capture;
  }

  get(id: string): CaptureRecord<TDownload> | undefined {
    const entry = this.entries.get(id);
    return entry ? cloneCapture(entry.capture) : undefined;
  }

  async respond(response: CaptureResponse): Promise<CaptureRecord<TDownload> | undefined> {
    const entry = this.entries.get(response.id);
    if (!entry) return undefined;
    return this.transition(entry, async () => {
      let download = entry.capture.download;
      try {
        if (response.action === "cancel") {
          await this.options.remove(entry.capture.id);
          entry.capture.state = "rejected";
        } else {
          const target: CaptureTarget = {};
          if (response.fileName !== undefined) target.fileName = response.fileName;
          if (response.directory !== undefined) target.directory = response.directory;
          download = await this.options.retarget(entry.capture.id, target);
          if (response.action === "start") {
            download = await this.options.resume(entry.capture.id);
            entry.capture.state = "accepted";
          } else {
            entry.capture.state = "accepted-paused";
          }
          entry.capture.download = cloneDownload(download);
        }
        this.schedule(entry, this.terminalTtlMs);
        const capture = cloneCapture(entry.capture);
        this.notifyChanged(capture);
        return capture;
      } catch (error) {
        entry.capture.state = "error";
        entry.capture.download = cloneDownload(download);
        this.schedule(entry, this.terminalTtlMs);
        if (response.action !== "cancel") {
          try {
            await this.options.remove(entry.capture.id);
          } catch (cleanupError) {
            this.report(cleanupError);
          }
        }
        this.notifyChanged(cloneCapture(entry.capture));
        throw error;
      }
    });
  }

  async reject(id: string): Promise<CaptureRecord<TDownload> | undefined> {
    return this.respond({ id, action: "cancel" });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const pendingIds = [...this.entries.values()]
      .filter((entry) => entry.capture.state === "pending")
      .map((entry) => entry.capture.id);
    await Promise.allSettled(pendingIds.map((id) => this.reject(id)));
    this.entries.clear();
  }

  private async transition(
    entry: CaptureEntry<TDownload>,
    operation: () => Promise<CaptureRecord<TDownload>>
  ): Promise<CaptureRecord<TDownload>> {
    if (entry.operation) {
      try {
        await entry.operation;
      } catch {
        // The state below carries the outcome of the operation that won.
      }
      return cloneCapture(entry.capture);
    }
    if (entry.capture.state !== "pending") return cloneCapture(entry.capture);

    const pending = operation();
    entry.operation = pending;
    try {
      return await pending;
    } finally {
      if (entry.operation === pending) entry.operation = undefined;
    }
  }

  private schedule(entry: CaptureEntry<TDownload>, delay: number): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (this.shuttingDown) {
      entry.timer = undefined;
      return;
    }
    const id = entry.capture.id;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.expire(id).catch((error) => this.report(error));
    }, delay);
    entry.timer.unref?.();
  }

  private async expire(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.capture.state === "pending") {
      try {
        await this.reject(id);
      } catch {
        // respond() has already moved the capture to the error state.
      }
      if (this.entries.get(id) === entry) this.schedule(entry, this.terminalTtlMs);
      return;
    }
    this.entries.delete(id);
  }

  private async makeRoom(): Promise<void> {
    while (this.entries.size >= this.maxEntries) {
      const values = [...this.entries.values()];
      const disposableTerminal = values.find((entry) =>
        entry.capture.state === "rejected" || entry.capture.state === "error"
      );
      const terminal = disposableTerminal
        ?? values.find((entry) => entry.capture.state !== "pending");
      const entry = terminal
        ?? values.find((candidate) => candidate.capture.state === "pending" && !candidate.operation);
      if (!entry) throw new Error("Too many browser captures are awaiting a decision.");
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.capture.state === "pending") {
        try {
          await this.reject(entry.capture.id);
        } catch (error) {
          this.report(error);
        }
      }
      this.entries.delete(entry.capture.id);
    }
  }

  private report(error: unknown): void {
    this.options.onError?.(error);
  }

  private notifyChanged(capture: CaptureRecord<TDownload>): void {
    try {
      this.options.onChanged?.(capture);
    } catch (error) {
      this.report(error);
    }
  }
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{4,128}$/.test(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}

function cloneDownload<TDownload extends CaptureDownload>(download: TDownload): TDownload {
  return { ...download };
}

function cloneCapture<TDownload extends CaptureDownload>(
  capture: CaptureRecord<TDownload>
): CaptureRecord<TDownload> {
  return {
    id: capture.id,
    state: capture.state,
    download: cloneDownload(capture.download)
  };
}
