import { randomUUID } from "node:crypto";
import express from "express";
import * as http from "http";
import Queue from "queue";
import { Server } from "socket.io";
import ClassifierService from "./ClassifierService.js";
import FireflyService from "./FireflyService.js";
import JobList from "./JobList.js";
import StatsStore from "./StatsStore.js";
import { evaluateTransactionGroup, TRANSACTION_SELECTION_SCOPES } from "./transactionEligibility.js";
import { getConfigVariable } from "./util.js";

export default class App {
  #PORT;
  #ENABLE_UI;
  #APP_STATE_FILE;
  #TAG_PREFIX;
  #BACKFILL_DEFAULT_MAX_TRANSACTIONS;
  #BACKFILL_MAX_TRANSACTIONS;
  #BACKFILL_PAGE_SIZE;

  #firefly;
  #classifier;
  #statsStore;

  #server;
  #io;
  #express;

  #queue;
  #jobList;

  constructor() {
    this.#PORT = getConfigVariable("PORT", "3000");
    this.#ENABLE_UI = getConfigVariable("ENABLE_UI", "false") === "true";
    this.#APP_STATE_FILE = getConfigVariable("APP_STATE_FILE", "/data/state/app-state.json");
    this.#TAG_PREFIX = getConfigVariable("TAG_PREFIX", "ai");
    this.#BACKFILL_DEFAULT_MAX_TRANSACTIONS = parseIntegerEnv(
      "BACKFILL_DEFAULT_MAX_TRANSACTIONS",
      100,
    );
    this.#BACKFILL_MAX_TRANSACTIONS = parseIntegerEnv("BACKFILL_MAX_TRANSACTIONS", 1000);
    this.#BACKFILL_PAGE_SIZE = parseIntegerEnv("BACKFILL_PAGE_SIZE", 100);
  }

  async run() {
    this.#firefly = new FireflyService();
    this.#classifier = new ClassifierService();
    this.#statsStore = new StatsStore({ stateFile: this.#APP_STATE_FILE });
    await this.#statsStore.load();
    this.#restorePersistedModel();

    this.#queue = new Queue({
      timeout: 60 * 1000,
      concurrency: 1,
      autostart: true,
    });

    this.#queue.addEventListener("start", (job) => console.log("Job started", job));
    this.#queue.addEventListener("success", (event) => console.log("Job success", event.job));
    this.#queue.addEventListener("error", (event) => console.error("Job error", event.job, event.err));
    this.#queue.addEventListener("timeout", (event) => console.log("Job timeout", event.job));

    this.#express = express();
    this.#server = http.createServer(this.#express);
    this.#io = new Server(this.#server);

    this.#jobList = new JobList();
    this.#jobList.on("job created", (data) => this.#io.emit("job created", data));
    this.#jobList.on("job updated", (data) => this.#io.emit("job updated", data));
    this.#statsStore.on("updated", (data) => this.#io.emit("stats updated", data));

    this.#express.use(express.json({ limit: "1mb" }));

    if (this.#ENABLE_UI) {
      this.#express.use("/", express.static("public"));
    }

    this.#express.get("/health", this.#onHealth.bind(this));
    this.#express.get("/api/state", this.#onState.bind(this));
    this.#express.post("/api/settings/model", this.#onUpdateModel.bind(this));
    this.#express.post("/webhook", this.#onWebhook.bind(this));
    this.#express.post("/api/backfill", this.#onBackfill.bind(this));
    this.#express.post("/api/reevaluate", this.#onReevaluate.bind(this));

    this.#server.listen(this.#PORT, () => {
      console.log(`firefly-iii-ai-categorize v2 running on port ${this.#PORT}`);
      console.log("Three-outcome model: CLASSIFIED | ASSUMED | NEEDS_REVIEW");
      console.log(`UI ${this.#ENABLE_UI ? "enabled" : "disabled"}`);
      console.log(`Backfill max transactions: ${this.#BACKFILL_MAX_TRANSACTIONS}`);
      console.log(`State file: ${this.#APP_STATE_FILE}`);
    });

    this.#io.on("connection", (socket) => {
      socket.emit("jobs", Array.from(this.#jobList.getJobs().values()));
      socket.emit("stats updated", this.#statsStore.getSnapshot());
      socket.emit("settings updated", this.#buildStatePayload().settings);
    });
  }

  #restorePersistedModel() {
    const persistedModel = this.#statsStore.getSelectedModel();
    if (!persistedModel) {
      return;
    }

    try {
      this.#classifier.setModel(persistedModel);
    } catch (error) {
      console.warn(`Ignoring persisted model "${persistedModel}":`, error.message);
      this.#statsStore.setSelectedModel(null);
    }
  }

  async #onBackfill(req, res) {
    try {
      const options = normalizeBackfillOptions(req.body ?? {}, {
        defaultMaxTransactions: this.#BACKFILL_DEFAULT_MAX_TRANSACTIONS,
        maxTransactionsLimit: this.#BACKFILL_MAX_TRANSACTIONS,
      });
      if (options.model) {
        options.model = this.#classifier.validateModel(options.model);
      }
      const result = await this.#runBackfill(options);
      res.json(result);
    } catch (error) {
      console.error("Backfill request failed:", error);
      res.status(error instanceof BackfillException ? 400 : 500).json({
        error: error.message,
      });
    }
  }

  async #onReevaluate(req, res) {
    try {
      const transactionId = normalizeTransactionId(req.body?.transactionId);
      const requestedModel = normalizeOptionalString(req.body?.model);
      const model = requestedModel ? this.#classifier.validateModel(requestedModel) : null;
      const queued = await this.#queueManualReevaluation({ transactionId, model });

      if (!queued.queued) {
        res.status(queued.reason === "duplicate-open-job" ? 409 : 400).json({
          error: reasonToManualReevaluationMessage(queued.reason),
        });
        return;
      }

      res.json({
        ok: true,
        job: queued.job,
        message: `Queued reevaluation for transaction ${transactionId}.`,
      });
    } catch (error) {
      console.error("Manual reevaluation request failed:", error);
      res.status(error instanceof BackfillException ? 400 : 500).json({
        error: error.message,
      });
    }
  }

  #onUpdateModel(req, res) {
    try {
      const rawModel = typeof req.body?.model === "string" ? req.body.model.trim() : "";

      if (!rawModel) {
        this.#classifier.resetModel();
        this.#statsStore.setSelectedModel(null);
      } else {
        this.#classifier.setModel(rawModel);
        this.#statsStore.setSelectedModel(
          this.#classifier.getModel() === this.#classifier.getDefaultModel()
            ? null
            : this.#classifier.getModel(),
        );
      }

      const settings = this.#buildStatePayload().settings;
      this.#io.emit("settings updated", settings);

      res.json({
        ok: true,
        settings,
        message: rawModel
          ? `Model changed to ${this.#classifier.getModel()}`
          : `Model reset to ${this.#classifier.getDefaultModel()}`,
      });
    } catch (error) {
      console.error("Failed to update model:", error);
      res.status(400).json({
        error: error.message,
      });
    }
  }

  #onWebhook(req, res) {
    try {
      const result = this.#handleWebhook(req.body);
      res.status(result.statusCode).send(result.message);
    } catch (error) {
      console.error(error);
      res.status(400).send(error.message);
    }
  }

  #handleWebhook(body) {
    if (body?.trigger !== "STORE_TRANSACTION") {
      throw new WebhookException("trigger is not STORE_TRANSACTION");
    }

    if (body?.response !== "TRANSACTIONS") {
      throw new WebhookException("response is not TRANSACTIONS");
    }

    if (!body?.content?.id) {
      throw new WebhookException("Missing content.id");
    }

    const evaluation = evaluateTransactionGroup(body.content, {
      tagPrefix: this.#TAG_PREFIX,
    });

    const queued = this.#queueTransactionGroup({
      source: "webhook",
      transactionGroup: body.content,
      evaluation,
    });

    if (!queued.queued) {
      return {
        statusCode: 200,
        message: reasonToWebhookMessage(queued.reason, evaluation.transaction),
      };
    }

    return {
      statusCode: 200,
      message: "Queued",
    };
  }

  async #processJob({ jobId, transactionId, transactions, source, modelOverride = null }) {
    const job = this.#jobList.getJob(jobId);
    if (!job) {
      return;
    }

    this.#jobList.setJobInProgress(jobId);
    let writeAttempted = false;

    try {
      const categories = await this.#firefly.getCategories();
      this.#firefly.setCategoryList(categories);
      const categoryNames = categories.map((category) => category.name);

      const result = await this.#classifier.classify(
        categoryNames,
        job.data.destinationName,
        job.data.description,
        job.data.amount,
        { model: modelOverride },
      );

      if (result.category) {
        const categoryId = this.#firefly.findCategoryId(result.category);
        if (categoryId) {
          result.categoryId = categoryId;
        }
      }

      this.#jobList.updateJobData(jobId, { ...job.data, ...result });
      this.#statsStore.recordClassification({
        outcome: result.outcome,
        source,
        model: result.model,
        usage: result.usage,
      });

      writeAttempted = true;
      await this.#firefly.updateTransaction(transactionId, transactions, result);
      this.#statsStore.recordWrite({ source, success: true });
      this.#jobList.setJobFinished(jobId);
    } catch (error) {
      console.error(`Classification failed for transaction ${transactionId}:`, error);
      if (writeAttempted) {
        this.#statsStore.recordWrite({ source, success: false });
      }
      this.#jobList.setJobFailed(jobId, error.message);
    }
  }

  async #queueManualReevaluation({ transactionId, model = null }) {
    const transactionGroup = await this.#firefly.getTransactionGroup(transactionId);
    if (!transactionGroup?.id) {
      throw new BackfillException(`Transaction ${transactionId} was not found in Firefly III.`);
    }

    const evaluation = evaluateTransactionGroup(transactionGroup, {
      tagPrefix: this.#TAG_PREFIX,
      includeTagged: true,
      ignoreExistingCategory: true,
      ignoreAiTags: true,
    });

    return this.#queueTransactionGroup({
      source: "reevaluation",
      transactionGroup,
      includeTagged: true,
      metadata: {
        requestedModel: model,
        selectionScope: "single_transaction",
      },
      evaluation,
    });
  }

  #queueTransactionGroup({
    source,
    transactionGroup,
    includeTagged = false,
    metadata = {},
    evaluation = null,
    scope = TRANSACTION_SELECTION_SCOPES.UNCATEGORIZED,
  }) {
    const resolvedEvaluation = evaluation ?? evaluateTransactionGroup(transactionGroup, {
      tagPrefix: this.#TAG_PREFIX,
      includeTagged,
      scope,
    });

    if (!resolvedEvaluation.eligible) {
      return {
        queued: false,
        reason: resolvedEvaluation.reason,
        evaluation: resolvedEvaluation,
      };
    }

    const transactionId = resolvedEvaluation.transactionGroupId;
    if (!transactionId) {
      return {
        queued: false,
        reason: "missing-transaction-id",
        evaluation: resolvedEvaluation,
      };
    }

    if (this.#jobList.hasOpenJobForTransaction(transactionId)) {
      return {
        queued: false,
        reason: "duplicate-open-job",
        evaluation: resolvedEvaluation,
      };
    }

    const transaction = resolvedEvaluation.transaction;
    const job = this.#jobList.createJob({
      source,
      ...buildTransactionSnapshot(transactionId, transaction, {
        currentOutcome: resolvedEvaluation.currentOutcome,
        transactionUrl: this.#firefly.getTransactionUrl(transactionId),
      }),
      ...metadata,
    });

    const transactions = resolvedEvaluation.transactions.map((item) => ({ ...item }));
    this.#queue.push(async () => {
      await this.#processJob({
        jobId: job.id,
        transactionId,
        transactions,
        source,
        modelOverride: job.data.requestedModel ?? null,
      });
    });

    return {
      queued: true,
      job,
      evaluation: resolvedEvaluation,
    };
  }

  async #runBackfill(options) {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const source = options.scope === TRANSACTION_SELECTION_SCOPES.UNCATEGORIZED
      ? "backfill"
      : "reevaluation";
    const skippedReasonCounts = {};
    const sampleCandidates = [];
    let inspected = 0;
    let eligibleCandidates = 0;
    let queueableCandidates = 0;
    let queued = 0;
    let duplicateOpenJobs = 0;
    let page = 1;
    let stoppedBecause = "end-of-results";

    while (true) {
      const { groups, pagination } = await this.#firefly.getTransactionGroups({
        type: "withdrawal",
        startDate: options.startDate,
        endDate: options.endDate,
        page,
        limit: this.#BACKFILL_PAGE_SIZE,
      });

      if (groups.length === 0) {
        break;
      }

      for (const group of groups) {
        inspected += 1;

        const evaluation = evaluateTransactionGroup(group, {
          tagPrefix: this.#TAG_PREFIX,
          includeTagged: options.includeTagged,
          scope: options.scope,
        });

        if (!evaluation.eligible) {
          skippedReasonCounts[evaluation.reason] = (skippedReasonCounts[evaluation.reason] ?? 0) + 1;
          continue;
        }

        eligibleCandidates += 1;

        if (this.#jobList.hasOpenJobForTransaction(evaluation.transactionGroupId)) {
          duplicateOpenJobs += 1;
          continue;
        }

        queueableCandidates += 1;
        if (sampleCandidates.length < 5) {
          sampleCandidates.push(buildCandidatePreview(
            evaluation.transactionGroupId,
            evaluation.transaction,
            {
              currentOutcome: evaluation.currentOutcome,
              transactionUrl: this.#firefly.getTransactionUrl(evaluation.transactionGroupId),
            },
          ));
        }

        if (options.dryRun) {
          continue;
        }

        const queuedResult = this.#queueTransactionGroup({
          source,
          transactionGroup: group,
          includeTagged: options.includeTagged,
          metadata: {
            backfillRunId: runId,
            requestedModel: options.model,
            selectionScope: options.scope,
          },
          evaluation,
          scope: options.scope,
        });

        if (queuedResult.queued) {
          queued += 1;
        } else if (queuedResult.reason === "duplicate-open-job") {
          duplicateOpenJobs += 1;
          queueableCandidates = Math.max(queueableCandidates - 1, 0);
        }

        if (queued >= options.maxTransactions) {
          stoppedBecause = "max-transactions-reached";
          break;
        }
      }

      if (stoppedBecause === "max-transactions-reached") {
        break;
      }

      if (!pagination || page >= pagination.total_pages) {
        break;
      }

      page += 1;
    }

    const result = {
      runId,
      mode: options.dryRun ? "preview" : "queue",
      source,
      startedAt,
      completedAt: new Date().toISOString(),
      stoppedBecause,
      options,
      inspected,
      eligibleCandidates,
      queueableCandidates,
      queueableWithinLimit: Math.min(queueableCandidates, options.maxTransactions),
      remainingCandidates: Math.max(queueableCandidates - options.maxTransactions, 0),
      queued,
      duplicateOpenJobs,
      skippedReasonCounts,
      sampleCandidates,
    };

    this.#statsStore.recordBackfillRun(result);
    return result;
  }

  #onState(_req, res) {
    res.json(this.#buildStatePayload());
  }

  #buildStatePayload() {
    const jobs = Array.from(this.#jobList.getJobs().values());

    return {
      jobs,
      stats: this.#statsStore.getSnapshot(),
      queue: summarizeJobs(jobs),
      settings: {
        uiEnabled: this.#ENABLE_UI,
        authMode: this.#classifier.getAuthMode(),
        tagPrefix: this.#TAG_PREFIX,
        appStateFile: this.#statsStore.getStateFile(),
        currentModel: this.#classifier.getModel(),
        defaultModel: this.#classifier.getDefaultModel(),
        modelOverrideActive: this.#classifier.getModel() !== this.#classifier.getDefaultModel(),
        selectedModel: this.#statsStore.getSelectedModel(),
        availableModels: this.#classifier.getAvailableModels(),
        allowsCustomModelInput: this.#classifier.allowsCustomModelInput(),
        backfillDefaultMaxTransactions: this.#BACKFILL_DEFAULT_MAX_TRANSACTIONS,
        backfillMaxTransactions: this.#BACKFILL_MAX_TRANSACTIONS,
        backfillPageSize: this.#BACKFILL_PAGE_SIZE,
      },
    };
  }

  async #onHealth(_req, res) {
    const fireflyStatus = this.#firefly.getHealthStatus();
    const classifierStatus = await this.#classifier.getHealthStatus();
    const ready = fireflyStatus.configured && classifierStatus.configured;

    res.json({
      status: ready ? "ok" : "degraded",
      ready,
      model: this.#classifier.getModel(),
      authMode: this.#classifier.getAuthMode(),
      queue: summarizeJobs(Array.from(this.#jobList.getJobs().values())),
      checks: {
        firefly: fireflyStatus,
        classifier: classifierStatus,
        uiEnabled: this.#ENABLE_UI,
        stateFile: this.#statsStore.getStateFile(),
      },
    });
  }
}

class WebhookException extends Error {
  constructor(message) {
    super(message);
  }
}

class BackfillException extends Error {
  constructor(message) {
    super(message);
  }
}

function parseIntegerEnv(name, defaultValue) {
  const rawValue = getConfigVariable(name, String(defaultValue));
  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function normalizeBackfillOptions(body, { defaultMaxTransactions, maxTransactionsLimit }) {
  const startDate = normalizeDate(body.startDate);
  const endDate = normalizeDate(body.endDate);
  const scope = normalizeBackfillScope(body.scope);
  const maxTransactions = body.maxTransactions == null || body.maxTransactions === ""
    ? defaultMaxTransactions
    : Number.parseInt(String(body.maxTransactions), 10);

  if (!Number.isInteger(maxTransactions) || maxTransactions <= 0 || maxTransactions > maxTransactionsLimit) {
    throw new BackfillException(
      `maxTransactions must be an integer between 1 and ${maxTransactionsLimit}.`,
    );
  }

  if (startDate && endDate && startDate > endDate) {
    throw new BackfillException("startDate must be on or before endDate.");
  }

  return {
    startDate,
    endDate,
    scope,
    model: normalizeOptionalString(body.model),
    maxTransactions,
    dryRun: normalizeBoolean(body.dryRun, true),
    includeTagged: normalizeBoolean(body.includeTagged, false),
  };
}

function normalizeDate(value) {
  if (value == null || value === "") {
    return null;
  }

  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BackfillException("Dates must be in YYYY-MM-DD format.");
  }

  return value;
}

function normalizeBoolean(value, defaultValue) {
  if (value == null) {
    return defaultValue;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }

  return defaultValue;
}

function normalizeBackfillScope(value) {
  if (value === TRANSACTION_SELECTION_SCOPES.ASSUMED
    || value === TRANSACTION_SELECTION_SCOPES.NEEDS_REVIEW
    || value === TRANSACTION_SELECTION_SCOPES.ATTENTION) {
    return value;
  }

  return TRANSACTION_SELECTION_SCOPES.UNCATEGORIZED;
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTransactionId(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new BackfillException("transactionId is required.");
  }
  return normalized;
}

function buildCandidatePreview(transactionId, transaction, {
  currentOutcome = null,
  transactionUrl = null,
} = {}) {
  return buildTransactionSnapshot(transactionId, transaction, {
    currentOutcome,
    transactionUrl,
  });
}

function buildTransactionSnapshot(transactionId, transaction, {
  currentOutcome = null,
  transactionUrl = null,
} = {}) {
  const displayAmount = resolveDisplayAmount(transaction);

  return {
    transactionId,
    transactionUrl,
    currentOutcome,
    date: transaction?.date ?? null,
    destinationName: transaction?.destination_name ?? "",
    description: transaction?.description ?? "",
    amount: transaction?.amount ?? null,
    displayAmount: displayAmount.amount,
    displayCurrencySymbol: displayAmount.currencySymbol,
    displayCurrencyCode: displayAmount.currencyCode,
    displayCurrencyDecimalPlaces: displayAmount.currencyDecimalPlaces,
  };
}

function resolveDisplayAmount(transaction) {
  if (transaction?.foreign_amount != null && transaction?.foreign_currency_code) {
    return {
      amount: transaction.foreign_amount,
      currencySymbol: transaction.foreign_currency_symbol ?? null,
      currencyCode: transaction.foreign_currency_code ?? null,
      currencyDecimalPlaces: Number.isInteger(transaction.foreign_currency_decimal_places)
        ? transaction.foreign_currency_decimal_places
        : null,
    };
  }

  return {
    amount: transaction?.amount ?? null,
    currencySymbol: transaction?.currency_symbol ?? null,
    currencyCode: transaction?.currency_code ?? null,
    currencyDecimalPlaces: Number.isInteger(transaction?.currency_decimal_places)
      ? transaction.currency_decimal_places
      : null,
  };
}

function summarizeJobs(jobs) {
  const summary = {
    total: jobs.length,
    queued: 0,
    inProgress: 0,
    finished: 0,
    failed: 0,
  };

  for (const job of jobs) {
    if (job.status === "queued") {
      summary.queued += 1;
    } else if (job.status === "in_progress") {
      summary.inProgress += 1;
    } else if (job.status === "finished") {
      summary.finished += 1;
    } else if (job.status === "failed") {
      summary.failed += 1;
    }
  }

  return summary;
}

function reasonToWebhookMessage(reason, transaction) {
  switch (reason) {
    case "missing-transactions":
      return "No transactions in payload";
    case "not-withdrawal":
      return `Transaction type "${transaction?.type}" is not a withdrawal - skipping`;
    case "already-categorized":
      return "Category already set - skipping";
    case "already-ai-tagged":
      return "Transaction already has an AI tag - skipping";
    case "missing-text":
      return "No description or destination - cannot classify";
    case "duplicate-open-job":
      return "Transaction already queued - skipping";
    case "missing-transaction-id":
      return "Missing transaction id";
    default:
      return "Transaction is not eligible for classification";
  }
}

function reasonToManualReevaluationMessage(reason) {
  switch (reason) {
    case "duplicate-open-job":
      return "This transaction already has an open job.";
    case "not-withdrawal":
      return "Only withdrawal transactions can be reevaluated.";
    case "missing-text":
      return "This transaction has no description or destination to classify.";
    case "missing-transactions":
      return "This transaction group does not contain any transaction journals.";
    case "missing-transaction-id":
      return "Missing transaction id.";
    default:
      return "This transaction is not eligible for reevaluation.";
  }
}
