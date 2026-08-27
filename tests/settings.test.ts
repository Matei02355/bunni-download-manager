import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SettingsStore } from "../src/main/settings";

test("settings are validated and persisted", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bunni-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const downloads = path.join(directory, "downloads");
  const store = new SettingsStore(directory, {
    downloadDirectory: downloads,
    defaultSegments: 8,
    maxConcurrent: 3,
    serverPort: 17_865,
    notifyOnComplete: true
  });

  await store.init();
  const updated = await store.update({ defaultSegments: 99, maxConcurrent: 0, serverPort: 80 });
  assert.equal(updated.defaultSegments, 32);
  assert.equal(updated.maxConcurrent, 1);
  assert.equal(updated.serverPort, 1024);

  const saved = JSON.parse(await readFile(path.join(directory, "settings.json"), "utf8")) as typeof updated;
  assert.deepEqual(saved, updated);
});
