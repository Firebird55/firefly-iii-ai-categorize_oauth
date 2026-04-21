import OpenAI from "openai";
import { calculateCost, completeSimple, getModel, getModels } from "@mariozechner/pi-ai";
import CodexAuthStore from "./CodexAuthStore.js";
import { getConfigVariable, getOptionalConfigVariable } from "./util.js";

const SYSTEM_PROMPT = `You are a bank transaction classifier for a personal finance system.

You classify transactions using a three-outcome model:

1. CLASSIFIED — You are confident in the category. The transaction description, destination, and amount give you enough signal to match one of the user's existing categories.

2. ASSUMED — You are not fully confident but you are applying a conservative default. You pick the most reasonable category and disclose the assumption. Conservative means: when in doubt between a deductible and non-deductible category, pick non-deductible. When in doubt between business and personal, pick personal. The user can always override.

3. NEEDS_REVIEW — You cannot classify this transaction. The description is too vague, the destination is unknown, or the amount is ambiguous. You do not guess. You flag it for human review.

You MUST respond with valid JSON matching this schema:
{
  "outcome": "CLASSIFIED" | "ASSUMED" | "NEEDS_REVIEW",
  "category": "<exact category name from the list, or null if NEEDS_REVIEW>",
  "reason": "<one sentence explaining your classification>",
  "assumption": "<if ASSUMED: what you assumed and what the alternative is; otherwise null>"
}

Rules:
- category MUST be an exact match from the provided list, or null
- Never invent categories
- When uncertain between two categories, pick the one that is less favorable to the user (conservative default)
- If the description is too vague to even assume, use NEEDS_REVIEW`;

export default class ClassifierService {
  #client;
  #authMode;
  #authStore;
  #baseURL;
  #defaultModel;
  #model;

  constructor() {
    this.#authMode = resolveAuthMode();
    this.#defaultModel = getConfigVariable(
      "OPENAI_MODEL",
      this.#authMode === "codex_oauth" ? "gpt-5.4-mini" : "gpt-4o-mini",
    );
    this.#model = this.#defaultModel;

    if (this.#authMode === "codex_oauth") {
      this.#baseURL = getConfigVariable(
        "OPENAI_CODEX_BASE_URL",
        "https://chatgpt.com/backend-api/codex",
      );
      this.#authStore = new CodexAuthStore({
        authFile: getConfigVariable("OPENAI_CODEX_AUTH_FILE", "/data/secrets/openai_codex_auth.json"),
      });
      this.#client = null;
      return;
    }

    const apiKey = getOptionalConfigVariable("OPENAI_API_KEY", null);
    const baseURL = getOptionalConfigVariable("OPENAI_BASE_URL", null);

    if (!apiKey) {
      this.#client = null;
      this.#baseURL = baseURL;
      return;
    }

    const opts = { apiKey };
    if (baseURL) opts.baseURL = baseURL;
    this.#baseURL = baseURL;
    this.#client = new OpenAI(opts);
  }

  async classify(categories, destinationName, description, amount, { model } = {}) {
    const modelName = model ? this.validateModel(model) : this.#model;
    const userPrompt = this.#buildPrompt(categories, destinationName, description, amount);
    const response = await this.#runClassifier(userPrompt, modelName);
    return normalizeClassificationResult(categories, userPrompt, response.text, response.usage, modelName);
  }

  getModel() {
    return this.#model;
  }

  getDefaultModel() {
    return this.#defaultModel;
  }

  getAuthMode() {
    return this.#authMode;
  }

  getAvailableModels() {
    const provider = this.#authMode === "codex_oauth" ? "openai-codex" : "openai";
    return getModels(provider).map((model) => model.id);
  }

  allowsCustomModelInput() {
    return this.#authMode !== "codex_oauth";
  }

  validateModel(model) {
    const normalizedModel = normalizeText(model);
    if (!normalizedModel) {
      throw new Error("Model name is required.");
    }

    this.#assertModelSupported(normalizedModel);
    return normalizedModel;
  }

  setModel(model) {
    this.#model = this.validateModel(model);
  }

  resetModel() {
    this.#model = this.#defaultModel;
  }

  async getHealthStatus() {
    if (this.#authMode === "codex_oauth") {
      const authStatus = await this.#authStore.getStatus();
      return {
        authMode: this.#authMode,
        configured: authStatus.configured === true,
        baseURL: this.#baseURL,
        ...authStatus,
      };
    }

    return {
      authMode: this.#authMode,
      configured: this.#client !== null,
      baseURL: this.#baseURL,
    };
  }

  #buildPrompt(categories, destinationName, description, amount) {
    const parts = [
      `Available categories: ${categories.join(", ")}`,
      "",
      "Transaction to classify:",
      `  Destination: ${destinationName}`,
      `  Description: ${description}`,
    ];

    if (amount != null) {
      parts.push(`  Amount: ${amount}`);
    }

    return parts.join("\n");
  }

  async #runClassifier(userPrompt, modelName) {
    if (this.#authMode === "codex_oauth") {
      return this.#classifyWithCodex(userPrompt, modelName);
    }
    return this.#classifyWithApiKey(userPrompt, modelName);
  }

  async #classifyWithApiKey(userPrompt, modelName) {
    if (!this.#client) {
      throw new Error(
        "OPENAI_API_KEY is missing. Set OPENAI_AUTH_MODE=codex_oauth to use Codex auth instead.",
      );
    }

    const response = await this.#client.chat.completions.create({
      model: modelName,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    return {
      text: response.choices[0]?.message?.content ?? "",
      usage: normalizeOpenAiUsage(response.usage, modelName),
    };
  }

  async #classifyWithCodex(userPrompt, modelName) {
    const accessToken = await this.#authStore.getAccessToken();
    const modelDefinition = getModel("openai-codex", modelName);
    if (!modelDefinition) {
      throw new Error(
        `Model "${modelName}" is not supported for Codex OAuth mode.`,
      );
    }

    const model = {
      ...modelDefinition,
      baseUrl: this.#baseURL,
    };

    const response = await completeSimple(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }, {
      apiKey: accessToken,
      reasoning: "low",
    });

    return {
      text: extractAssistantText(response),
      usage: normalizePiAiUsage(response.usage),
    };
  }

  #assertModelSupported(modelName) {
    if (this.#authMode !== "codex_oauth") {
      return;
    }

    if (!this.getAvailableModels().includes(modelName)) {
      throw new Error(
        `Model "${modelName}" is not available in Codex OAuth mode.`,
      );
    }
  }
}

function resolveAuthMode() {
  const configured = getConfigVariable("OPENAI_AUTH_MODE", "api_key").toLowerCase();
  if (configured === "api_key" || configured === "codex_oauth") {
    return configured;
  }

  throw new Error(
    `Unsupported OPENAI_AUTH_MODE "${configured}". Use "api_key" or "codex_oauth".`,
  );
}

function extractAssistantText(message) {
  const chunks = [];
  for (const block of message?.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      chunks.push(block.text);
    }
  }
  return chunks.join("\n").trim();
}

function normalizeClassificationResult(categories, userPrompt, raw, usage, model) {
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Failed to parse classifier response:", raw);
    return {
      outcome: "NEEDS_REVIEW",
      category: null,
      reason: "Classifier returned unparseable response",
      assumption: null,
      prompt: userPrompt,
      response: raw,
      rawResponse: raw,
      usage,
      model,
    };
  }

  const category = matchCategory(categories, parsed?.category);
  if (parsed?.category && !category) {
    console.warn(`Classifier returned unknown category "${parsed.category}", falling back to NEEDS_REVIEW`);
    return {
      outcome: "NEEDS_REVIEW",
      category: null,
      reason: `Model suggested "${parsed.category}" which is not in your category list`,
      assumption: null,
      prompt: userPrompt,
      response: raw,
      rawResponse: raw,
      usage,
      model,
    };
  }

  const outcome = normalizeOutcome(parsed?.outcome, category);
  return {
    outcome,
    category: outcome === "NEEDS_REVIEW" ? null : category,
    reason: normalizeText(parsed?.reason) ?? "No reason provided by classifier",
    assumption: outcome === "ASSUMED" ? normalizeText(parsed?.assumption) : null,
    prompt: userPrompt,
    response: raw,
    rawResponse: raw,
    usage,
    model,
  };
}

function normalizeOpenAiUsage(usage, modelName) {
  if (!usage) {
    return null;
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const normalized = createUsagePayload({
    input: Math.max((usage.prompt_tokens ?? 0) - cachedTokens, 0),
    output: usage.completion_tokens ?? 0,
    cacheRead: cachedTokens,
    cacheWrite: 0,
    totalTokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
  });

  const model = getModel("openai", modelName);
  if (model) {
    calculateCost(model, normalized);
  }

  return normalized;
}

function normalizePiAiUsage(usage) {
  if (!usage) {
    return null;
  }

  const normalized = createUsagePayload({
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? 0,
  });

  normalized.cost = {
    input: usage.cost?.input ?? normalized.cost.input,
    output: usage.cost?.output ?? normalized.cost.output,
    cacheRead: usage.cost?.cacheRead ?? normalized.cost.cacheRead,
    cacheWrite: usage.cost?.cacheWrite ?? normalized.cost.cacheWrite,
    total: usage.cost?.total ?? normalized.cost.total,
  };

  return normalized;
}

function createUsagePayload({
  input = 0,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
  totalTokens = 0,
} = {}) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function normalizeOutcome(candidate, category) {
  if (candidate === "CLASSIFIED" || candidate === "ASSUMED" || candidate === "NEEDS_REVIEW") {
    if (!category && candidate !== "NEEDS_REVIEW") {
      return "NEEDS_REVIEW";
    }
    return candidate;
  }

  return category ? "ASSUMED" : "NEEDS_REVIEW";
}

function matchCategory(categories, candidate) {
  const normalizedCandidate = normalizeText(candidate);
  if (!normalizedCandidate) {
    return null;
  }

  if (categories.includes(normalizedCandidate)) {
    return normalizedCandidate;
  }

  const lower = normalizedCandidate.toLocaleLowerCase();
  return categories.find((category) => category.toLocaleLowerCase() === lower) ?? null;
}

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
