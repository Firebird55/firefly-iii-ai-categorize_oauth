import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import StatsStore from "../src/StatsStore.js";

test("StatsStore persists classifications, usage, and writes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stats-store-"));
  const stateFile = path.join(tempDir, "state.json");
  const store = new StatsStore({ stateFile });
  await store.load();

  store.recordClassification({
    outcome: "ASSUMED",
    source: "webhook",
    model: "gpt-5.4-mini",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 17,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.0001,
        cacheWrite: 0,
        total: 0.0031,
      },
    },
  });
  store.recordWrite({ source: "webhook", success: true });

  await waitForFile(stateFile);

  const loaded = new StatsStore({ stateFile });
  await loaded.load();
  const snapshot = loaded.getSnapshot();

  assert.equal(snapshot.classifications.total, 1);
  assert.equal(snapshot.classifications.byOutcome.ASSUMED, 1);
  assert.equal(snapshot.classifications.bySource.webhook, 1);
  assert.equal(snapshot.classifications.byModel["gpt-5.4-mini"], 1);
  assert.equal(snapshot.writes.finished, 1);
  assert.equal(snapshot.writes.bySource.webhook.finished, 1);
  assert.equal(snapshot.usage.callsWithUsage, 1);
  assert.equal(snapshot.usage.totalTokens, 17);
  assert.equal(snapshot.usage.cost.total, 0.0031);
});

test("StatsStore stores a capped backfill history", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stats-store-backfill-"));
  const stateFile = path.join(tempDir, "state.json");
  const store = new StatsStore({ stateFile });
  await store.load();

  for (let i = 0; i < 25; i += 1) {
    store.recordBackfillRun({ runId: `run-${i}` });
  }

  await waitForFile(stateFile);
  const snapshot = store.getSnapshot();

  assert.equal(snapshot.backfill.runs.length, 20);
  assert.equal(snapshot.backfill.runs[0].runId, "run-24");
  assert.equal(snapshot.backfill.runs[19].runId, "run-5");
});

test("StatsStore persists a selected model override", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stats-store-model-"));
  const stateFile = path.join(tempDir, "state.json");
  const store = new StatsStore({ stateFile });
  await store.load();

  store.setSelectedModel("gpt-5.4");
  await waitForFile(stateFile);

  const loaded = new StatsStore({ stateFile });
  await loaded.load();

  assert.equal(loaded.getSelectedModel(), "gpt-5.4");

  loaded.setSelectedModel(null);
  await waitForFile(stateFile);
  assert.equal(loaded.getSnapshot().settings.selectedModel, null);
});

async function waitForFile(filePath) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  throw new Error(`Timed out waiting for ${filePath}`);
}
