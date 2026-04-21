import EventEmitter from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = {
  classifications: {
    total: 0,
    byOutcome: {
      CLASSIFIED: 0,
      ASSUMED: 0,
      NEEDS_REVIEW: 0,
    },
    bySource: {},
    byModel: {},
  },
  writes: {
    finished: 0,
    failed: 0,
    bySource: {},
  },
  usage: {
    callsWithUsage: 0,
    callsWithoutUsage: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  },
  backfill: {
    runs: [],
  },
  settings: {
    selectedModel: null,
    selectedQueueConcurrency: null,
  },
  updatedAt: null,
};

export default class StatsStore {
  #eventEmitter = new EventEmitter();
  #stateFile;
  #state;
  #persistChain = Promise.resolve();

  constructor({ stateFile }) {
    this.#stateFile = stateFile;
    this.#state = clone(DEFAULT_STATE);
  }

  async load() {
    await fs.mkdir(path.dirname(this.#stateFile), { recursive: true });

    try {
      const raw = await fs.readFile(this.#stateFile, "utf8");
      const parsed = JSON.parse(raw);
      this.#state = mergeState(parsed);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`Failed to load state from ${this.#stateFile}, starting fresh:`, error);
      }
      await this.#persist();
    }
  }

  on(event, listener) {
    this.#eventEmitter.on(event, listener);
  }

  getSnapshot() {
    return clone(this.#state);
  }

  getStateFile() {
    return this.#stateFile;
  }

  getSelectedModel() {
    return this.#state.settings.selectedModel;
  }

  getSelectedQueueConcurrency() {
    return asNullablePositiveInteger(this.#state.settings.selectedQueueConcurrency);
  }

  setSelectedModel(model) {
    const normalizedModel = normalizeOptionalString(model);
    if (this.#state.settings.selectedModel === normalizedModel) {
      return;
    }

    this.#state.settings.selectedModel = normalizedModel;
    this.#touch();
  }

  setSelectedQueueConcurrency(concurrency) {
    const normalizedConcurrency = asNullablePositiveInteger(concurrency);
    if (this.#state.settings.selectedQueueConcurrency === normalizedConcurrency) {
      return;
    }

    this.#state.settings.selectedQueueConcurrency = normalizedConcurrency;
    this.#touch();
  }

  recordClassification({ outcome, source, model, usage }) {
    this.#state.classifications.total += 1;
    this.#state.classifications.byOutcome[outcome] =
      (this.#state.classifications.byOutcome[outcome] ?? 0) + 1;
    this.#state.classifications.bySource[source] =
      (this.#state.classifications.bySource[source] ?? 0) + 1;
    this.#state.classifications.byModel[model] =
      (this.#state.classifications.byModel[model] ?? 0) + 1;

    if (usage) {
      this.#state.usage.callsWithUsage += 1;
      this.#state.usage.input += usage.input ?? 0;
      this.#state.usage.output += usage.output ?? 0;
      this.#state.usage.cacheRead += usage.cacheRead ?? 0;
      this.#state.usage.cacheWrite += usage.cacheWrite ?? 0;
      this.#state.usage.totalTokens += usage.totalTokens ?? 0;
      this.#state.usage.cost.input += usage.cost?.input ?? 0;
      this.#state.usage.cost.output += usage.cost?.output ?? 0;
      this.#state.usage.cost.cacheRead += usage.cost?.cacheRead ?? 0;
      this.#state.usage.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
      this.#state.usage.cost.total += usage.cost?.total ?? 0;
    } else {
      this.#state.usage.callsWithoutUsage += 1;
    }

    this.#touch();
  }

  recordWrite({ source, success }) {
    const bucket = this.#ensureSourceBucket(this.#state.writes.bySource, source, {
      finished: 0,
      failed: 0,
    });

    if (success) {
      this.#state.writes.finished += 1;
      bucket.finished += 1;
    } else {
      this.#state.writes.failed += 1;
      bucket.failed += 1;
    }

    this.#touch();
  }

  recordBackfillRun(run) {
    this.#state.backfill.runs.unshift(run);
    this.#state.backfill.runs = this.#state.backfill.runs.slice(0, 20);
    this.#touch();
  }

  #ensureSourceBucket(map, source, defaultValue) {
    if (!map[source]) {
      map[source] = clone(defaultValue);
    }
    return map[source];
  }

  #touch() {
    this.#state.updatedAt = new Date().toISOString();
    this.#emitUpdate();
    this.#persistLater();
  }

  #emitUpdate() {
    this.#eventEmitter.emit("updated", this.getSnapshot());
  }

  #persistLater() {
    this.#persistChain = this.#persistChain
      .then(() => this.#persist())
      .catch((error) => {
        console.error("Failed to persist stats state:", error);
      });
  }

  async #persist() {
    await fs.mkdir(path.dirname(this.#stateFile), { recursive: true });
    await fs.writeFile(this.#stateFile, JSON.stringify(this.#state, null, 2), "utf8");
  }
}

function mergeState(candidate) {
  const merged = clone(DEFAULT_STATE);
  if (!candidate || typeof candidate !== "object") {
    return merged;
  }

  merged.classifications.total = asNumber(candidate.classifications?.total);
  merged.classifications.byOutcome = {
    CLASSIFIED: asNumber(candidate.classifications?.byOutcome?.CLASSIFIED),
    ASSUMED: asNumber(candidate.classifications?.byOutcome?.ASSUMED),
    NEEDS_REVIEW: asNumber(candidate.classifications?.byOutcome?.NEEDS_REVIEW),
  };
  merged.classifications.bySource = asNumberMap(candidate.classifications?.bySource);
  merged.classifications.byModel = asNumberMap(candidate.classifications?.byModel);

  merged.writes.finished = asNumber(candidate.writes?.finished);
  merged.writes.failed = asNumber(candidate.writes?.failed);
  merged.writes.bySource = asNestedWriteMap(candidate.writes?.bySource);

  merged.usage.callsWithUsage = asNumber(candidate.usage?.callsWithUsage);
  merged.usage.callsWithoutUsage = asNumber(candidate.usage?.callsWithoutUsage);
  merged.usage.input = asNumber(candidate.usage?.input);
  merged.usage.output = asNumber(candidate.usage?.output);
  merged.usage.cacheRead = asNumber(candidate.usage?.cacheRead);
  merged.usage.cacheWrite = asNumber(candidate.usage?.cacheWrite);
  merged.usage.totalTokens = asNumber(candidate.usage?.totalTokens);
  merged.usage.cost = {
    input: asNumber(candidate.usage?.cost?.input),
    output: asNumber(candidate.usage?.cost?.output),
    cacheRead: asNumber(candidate.usage?.cost?.cacheRead),
    cacheWrite: asNumber(candidate.usage?.cost?.cacheWrite),
    total: asNumber(candidate.usage?.cost?.total),
  };

  merged.backfill.runs = Array.isArray(candidate.backfill?.runs)
    ? candidate.backfill.runs.slice(0, 20)
    : [];
  merged.settings.selectedModel = normalizeOptionalString(candidate.settings?.selectedModel);
  merged.settings.selectedQueueConcurrency = asNullablePositiveInteger(
    candidate.settings?.selectedQueueConcurrency,
  );
  merged.updatedAt = typeof candidate.updatedAt === "string" ? candidate.updatedAt : null;

  return merged;
}

function asNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function asNullablePositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function asNumberMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, amount]) => [key, asNumber(amount)]),
  );
}

function asNestedWriteMap(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, bucket]) => [
      key,
      {
        finished: asNumber(bucket?.finished),
        failed: asNumber(bucket?.failed),
      },
    ]),
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
