import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCredentialProtection,
  type LinuxStorageBackend,
  type SafeStorageLike,
} from "../src/main/credential-protection";

class FakeSafeStorage implements SafeStorageLike {
  constructor(
    private readonly available = true,
    private readonly backend: LinuxStorageBackend = "gnome_libsecret",
  ) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plainText: string): Buffer {
    return this.transform(Buffer.from(plainText, "utf8"));
  }

  decryptString(encrypted: Buffer): string {
    return this.transform(Buffer.from(encrypted)).toString("utf8");
  }

  getSelectedStorageBackend(): LinuxStorageBackend {
    return this.backend;
  }

  sealRaw(plainText: string): string {
    return this.encryptString(plainText).toString("base64");
  }

  private transform(input: Buffer): Buffer {
    for (let index = 0; index < input.length; index += 1) input[index] ^= 0xa5;
    return input;
  }
}

test("credential protection round-trips only encrypted sensitive headers", () => {
  const storage = new FakeSafeStorage();
  const protection = createCredentialProtection(storage);
  const secret = "accountToken=credential-test-secret";
  const opaque = protection.protectSensitiveHeaders({
    Cookie: secret,
    Authorization: "Bearer authorization-test-secret",
  });

  assert.match(opaque, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.doesNotMatch(opaque, /credential-test-secret|authorization-test-secret/);
  assert.deepEqual({ ...protection.unprotectSensitiveHeaders(opaque) }, {
    Cookie: secret,
    Authorization: "Bearer authorization-test-secret",
  });
});

test("credential protection fails closed when OS encryption is unavailable", () => {
  const protection = createCredentialProtection(new FakeSafeStorage(false));
  assert.throws(
    () => protection.protectSensitiveHeaders({ Cookie: "secret" }),
    /encryption is unavailable/i,
  );
  assert.throws(
    () => protection.unprotectSensitiveHeaders("c2VhbGVk"),
    /encryption is unavailable/i,
  );
});

test("credential protection accepts secure Electron storage backends on Linux", () => {
  for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"] as const) {
    const protection = createCredentialProtection(
      new FakeSafeStorage(true, backend),
      { platform: "linux" },
    );
    const opaque = protection.protectSensitiveHeaders({ Cookie: `secret-${backend}` });
    assert.deepEqual(
      { ...protection.unprotectSensitiveHeaders(opaque) },
      { Cookie: `secret-${backend}` },
    );
  }
});

test("credential protection rejects plaintext, unknown, or unreportable Linux backends", () => {
  const missingBackend: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString("utf8"),
  };
  const throwingBackend: SafeStorageLike = {
    ...missingBackend,
    getSelectedStorageBackend: () => { throw new Error("backend probe failed"); },
  };

  for (const storage of [
    new FakeSafeStorage(true, "basic_text"),
    new FakeSafeStorage(true, "unknown"),
    missingBackend,
    throwingBackend,
  ]) {
    const protection = createCredentialProtection(storage, { platform: "linux" });
    assert.throws(
      () => protection.protectSensitiveHeaders({ Cookie: "secret" }),
      /operating-system credential encryption is unavailable/i,
    );
    assert.throws(
      () => protection.unprotectSensitiveHeaders("c2VhbGVk"),
      /operating-system credential encryption is unavailable/i,
    );
  }
});

test("credential protection keeps non-Linux behavior independent of Linux backend reporting", () => {
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
  const protection = createCredentialProtection(storage, { platform: "win32" });
  const opaque = protection.protectSensitiveHeaders({ Cookie: "secret" });
  assert.deepEqual({ ...protection.unprotectSensitiveHeaders(opaque) }, { Cookie: "secret" });
});

test("credential protection rejects malformed and unexpected decrypted data", () => {
  const storage = new FakeSafeStorage();
  const protection = createCredentialProtection(storage);

  for (const opaque of [
    "not base64",
    storage.sealRaw("not json"),
    storage.sealRaw(JSON.stringify(["Cookie", "secret"])),
    storage.sealRaw(JSON.stringify({ "X-Api-Key": "secret" })),
    storage.sealRaw(JSON.stringify({ Cookie: "safe", cookie: "duplicate" })),
  ]) {
    assert.throws(() => protection.unprotectSensitiveHeaders(opaque), /credentials are invalid/i);
  }
});

test("credential protection does not expose storage failure details", () => {
  const sensitiveFailure = "storage-error-containing-a-secret";
  const storage: SafeStorageLike = {
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error(sensitiveFailure); },
    decryptString: () => { throw new Error(sensitiveFailure); },
  };
  const protection = createCredentialProtection(storage);

  for (const action of [
    () => protection.protectSensitiveHeaders({ Cookie: "credential" }),
    () => protection.unprotectSensitiveHeaders(Buffer.from("ciphertext").toString("base64")),
  ]) {
    assert.throws(action, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, new RegExp(sensitiveFailure));
      assert.doesNotMatch(error.message, /Windows/i);
      return true;
    });
  }
});
