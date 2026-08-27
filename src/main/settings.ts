import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AppSettings {
  downloadDirectory: string;
  defaultSegments: number;
  maxConcurrent: number;
  serverPort: number;
  notifyOnComplete: boolean;
}

export type SettingsPatch = Partial<AppSettings>;

const clampInteger = (value: unknown, minimum: number, maximum: number, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
};

export class SettingsStore {
  readonly filePath: string;
  private settings: AppSettings;

  constructor(dataDirectory: string, defaults: AppSettings) {
    this.filePath = path.join(dataDirectory, "settings.json");
    this.settings = { ...defaults };
  }

  async init(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8")) as SettingsPatch;
      this.settings = this.validate({ ...this.settings, ...saved });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await this.save();
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  preview(patch: SettingsPatch): AppSettings {
    return this.validate({ ...this.settings, ...patch });
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    const next = this.preview(patch);
    await this.save(next);
    this.settings = next;
    return this.get();
  }

  private validate(candidate: AppSettings): AppSettings {
    const downloadDirectory = typeof candidate.downloadDirectory === "string" && path.isAbsolute(candidate.downloadDirectory)
      ? path.normalize(candidate.downloadDirectory)
      : this.settings.downloadDirectory;

    return {
      downloadDirectory,
      defaultSegments: clampInteger(candidate.defaultSegments, 1, 32, this.settings.defaultSegments),
      maxConcurrent: clampInteger(candidate.maxConcurrent, 1, 10, this.settings.maxConcurrent),
      serverPort: clampInteger(candidate.serverPort, 1024, 65535, this.settings.serverPort),
      notifyOnComplete: typeof candidate.notifyOnComplete === "boolean"
        ? candidate.notifyOnComplete
        : this.settings.notifyOnComplete
    };
  }

  private async save(settings = this.settings): Promise<void> {
    await writeFile(this.filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
}
