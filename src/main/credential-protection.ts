export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): LinuxStorageBackend;
}

export type LinuxStorageBackend =
  | "basic_text"
  | "gnome_libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6"
  | "unknown";

export interface CredentialProtectionOptions {
  platform?: NodeJS.Platform;
}

export interface CredentialProtection {
  protectSensitiveHeaders(headers: Record<string, string>): string;
  unprotectSensitiveHeaders(opaque: string): Record<string, string>;
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "proxy-authorization",
]);
const MAX_CREDENTIAL_JSON_BYTES = 60 * 1024;
const MAX_OPAQUE_LENGTH = 256 * 1024;
const SECURE_LINUX_STORAGE_BACKENDS = new Set<LinuxStorageBackend>([
  "gnome_libsecret",
  "kwallet",
  "kwallet5",
  "kwallet6",
]);

export function createCredentialProtection(
  storage: SafeStorageLike,
  options: CredentialProtectionOptions = {},
): CredentialProtection {
  const platform = options.platform ?? process.platform;
  return Object.freeze({
    protectSensitiveHeaders(headers: Record<string, string>): string {
      requireEncryption(storage, platform);
      const serialized = JSON.stringify(validateSensitiveHeaders(headers));
      if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_JSON_BYTES) {
        throw new Error("Download credentials are too large to protect.");
      }

      try {
        const encrypted = storage.encryptString(serialized);
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
          throw new Error("invalid encrypted payload");
        }
        return encrypted.toString("base64");
      } catch {
        throw new Error("Download credentials could not be protected by operating-system encryption.");
      }
    },

    unprotectSensitiveHeaders(opaque: string): Record<string, string> {
      requireEncryption(storage, platform);
      const encrypted = decodeOpaquePayload(opaque);
      let serialized: string;
      try {
        serialized = storage.decryptString(encrypted);
      } catch {
        throw new Error("Stored download credentials could not be decrypted.");
      }
      if (
        typeof serialized !== "string"
        || Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_JSON_BYTES
      ) {
        throw new Error("Stored download credentials are invalid.");
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(serialized) as unknown;
      } catch {
        throw new Error("Stored download credentials are invalid.");
      }
      return validateSensitiveHeaders(parsed);
    },
  });
}

function requireEncryption(storage: SafeStorageLike, platform: NodeJS.Platform): void {
  try {
    if (!storage.isEncryptionAvailable()) throw new Error("encryption unavailable");
    if (platform === "linux") {
      const backend = storage.getSelectedStorageBackend?.();
      if (!backend || !SECURE_LINUX_STORAGE_BACKENDS.has(backend)) {
        throw new Error("insecure Linux credential backend");
      }
    }
    return;
  } catch {
    // Report the same fail-closed error as an unavailable OS encryption service.
  }
  throw new Error("Operating-system credential encryption is unavailable.");
}

function decodeOpaquePayload(opaque: string): Buffer {
  if (
    typeof opaque !== "string"
    || opaque.length === 0
    || opaque.length > MAX_OPAQUE_LENGTH
    || opaque.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(opaque)
  ) {
    throw new Error("Stored download credentials are invalid.");
  }
  const encrypted = Buffer.from(opaque, "base64");
  if (encrypted.length === 0 || encrypted.toString("base64") !== opaque) {
    throw new Error("Stored download credentials are invalid.");
  }
  return encrypted;
}

function validateSensitiveHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Download credentials are invalid.");
  }

  const result = Object.create(null) as Record<string, string>;
  const normalizedNames = new Set<string>();
  for (const [name, headerValue] of Object.entries(value)) {
    const normalizedName = name.toLowerCase();
    if (
      !SENSITIVE_HEADER_NAMES.has(normalizedName)
      || normalizedNames.has(normalizedName)
      || typeof headerValue !== "string"
      || /[\r\n]/.test(headerValue)
    ) {
      throw new Error("Download credentials are invalid.");
    }
    normalizedNames.add(normalizedName);
    result[name] = headerValue;
  }
  return result;
}
