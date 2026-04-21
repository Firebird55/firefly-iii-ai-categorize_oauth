import express from "express";
import { getConfigVariable } from "./util.js";
import FireflyService from "./FireflyService.js";
import ClassifierService from "./ClassifierService.js";
import { Server } from "socket.io";
import * as http from "http";
import Queue from "queue";
import JobList from "./JobList.js";

export default class App {
  #PORT;
  #ENABLE_UI;

  #firefly;
  #classifier;

  #server;
  #io;
  #express;

  #queue;
  #jobList;

  constructor() {
    this.#PORT = getConfigVariable("PORT", "3000");
    this.#ENABLE_UI = getConfigVariable("ENABLE_UI", "false") === "true";
  }

  async run() {
    this.#firefly = new FireflyService();
    this.#classifier = new ClassifierService();

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

    this.#express.use(express.json());

    if (this.#ENABLE_UI) {
      this.#express.use("/", express.static("public"));
    }

    this.#express.get("/health", this.#onHealth.bind(this));
    this.#express.post("/webhook", this.#onWebhook.bind(this));

    this.#server.listen(this.#PORT, () => {
      console.log(`firefly-iii-ai-categorize v2 running on port ${this.#PORT}`);
      console.log(`Three-outcome model: CLASSIFIED | ASSUMED | NEEDS_REVIEW`);
      console.log(`UI ${this.#ENABLE_UI ? "enabled" : "disabled"}`);
    });

    this.#io.on("connection", (socket) => {
      socket.emit("jobs", Array.from(this.#jobList.getJobs().values()));
    });
  }

  #onWebhook(req, res) {
    try {
      this.#handleWebhook(req);
      res.send("Queued");
    } catch (e) {
      console.error(e);
      res.status(400).send(e.message);
    }
  }

  #handleWebhook(req) {
    if (req.body?.trigger !== "STORE_TRANSACTION") {
      throw new WebhookException("trigger is not STORE_TRANSACTION");
    }

    if (req.body?.response !== "TRANSACTIONS") {
      throw new WebhookException("response is not TRANSACTIONS");
    }

    if (!req.body?.content?.id) {
      throw new WebhookException("Missing content.id");
    }

    const transactions = req.body.content.transactions || [];
    if (transactions.length === 0) {
      throw new WebhookException("No transactions in payload");
    }

    const txn = transactions[0];

    if (txn.type !== "withdrawal") {
      throw new WebhookException(`Transaction type "${txn.type}" is not a withdrawal — skipping`);
    }

    if (txn.category_id !== null) {
      throw new WebhookException("Category already set — skipping");
    }

    if (!txn.description && !txn.destination_name) {
      throw new WebhookException("No description or destination — cannot classify");
    }

    const job = this.#jobList.createJob({
      transactionId: req.body.content.id,
      destinationName: txn.destination_name || "",
      description: txn.description || "",
      amount: txn.amount || null,
    });

    this.#queue.push(async () => {
      this.#jobList.setJobInProgress(job.id);

      try {
        const categories = await this.#firefly.getCategories();
        this.#firefly.setCategoryList(categories);
        const categoryNames = categories.map((c) => c.name);

        const result = await this.#classifier.classify(
          categoryNames,
          job.data.destinationName,
          job.data.description,
          job.data.amount
        );

        if (result.category) {
          const catId = this.#firefly.findCategoryId(result.category);
          if (catId) result.categoryId = catId;
        }

        const newData = { ...job.data, ...result };
        this.#jobList.updateJobData(job.id, newData);

        await this.#firefly.updateTransaction(
          req.body.content.id,
          req.body.content.transactions,
          result
        );

        this.#jobList.setJobFinished(job.id);
      } catch (err) {
        console.error(`Classification failed for transaction ${req.body.content.id}:`, err);
        this.#jobList.setJobFailed(job.id, err.message);
      }
    });
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
      checks: {
        firefly: fireflyStatus,
        classifier: classifierStatus,
        uiEnabled: this.#ENABLE_UI,
      },
    });
  }
}

class WebhookException extends Error {
  constructor(message) {
    super(message);
  }
}
