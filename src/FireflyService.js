import { getOptionalConfigVariable, getConfigVariable } from "./util.js";

export default class FireflyService {
  #BASE_URL;
  #UI_URL;
  #PERSONAL_TOKEN;

  constructor() {
    this.#BASE_URL = getOptionalConfigVariable("FIREFLY_URL", null);
    if (this.#BASE_URL?.endsWith("/")) {
      this.#BASE_URL = this.#BASE_URL.slice(0, -1);
    }
    this.#UI_URL = getOptionalConfigVariable("FIREFLY_UI_URL", this.#BASE_URL);
    if (this.#UI_URL?.endsWith("/")) {
      this.#UI_URL = this.#UI_URL.slice(0, -1);
    }
    this.#PERSONAL_TOKEN = getOptionalConfigVariable("FIREFLY_PERSONAL_TOKEN", null);
  }

  async getCategories() {
    this.#assertConfigured();
    const categories = [];
    let page = 1;

    while (true) {
      const response = await fetch(`${this.#BASE_URL}/api/v1/categories?page=${page}`, {
        headers: { Authorization: `Bearer ${this.#PERSONAL_TOKEN}` },
      });

      if (!response.ok) {
        throw new FireflyException(response.status, response, await response.text());
      }

      const data = await response.json();
      for (const cat of data.data) {
        categories.push({ name: cat.attributes.name, id: cat.id });
      }

      if (!data.meta?.pagination || page >= data.meta.pagination.total_pages) break;
      page++;
    }

    return categories;
  }

  async getTransactionGroups({ type = "withdrawal", startDate = null, endDate = null, page = 1, limit = 50 } = {}) {
    this.#assertConfigured();

    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
      type,
    });

    if (startDate) {
      params.set("start", startDate);
    }

    if (endDate) {
      params.set("end", endDate);
    }

    const response = await fetch(`${this.#BASE_URL}/api/v1/transactions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${this.#PERSONAL_TOKEN}` },
    });

    if (!response.ok) {
      throw new FireflyException(response.status, response, await response.text());
    }

    const data = await response.json();
    return {
      groups: data.data ?? [],
      pagination: data.meta?.pagination ?? null,
    };
  }

  async getTransactionGroup(transactionId) {
    this.#assertConfigured();

    const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${transactionId}`, {
      headers: { Authorization: `Bearer ${this.#PERSONAL_TOKEN}` },
    });

    if (!response.ok) {
      throw new FireflyException(response.status, response, await response.text());
    }

    const data = await response.json();
    return data.data ?? null;
  }

  async updateTransaction(transactionId, transactions, result) {
    this.#assertConfigured();
    const tag = this.#tagForOutcome(result.outcome);
    const notes = this.#buildNotes(result);

    const body = {
      apply_rules: true,
      fire_webhooks: false,
      transactions: [],
    };

    for (const txn of transactions) {
      const tags = sanitizeOutcomeTags(txn.tags, this.#tagPrefix());
      if (!tags.includes(tag)) tags.push(tag);

      const update = {
        transaction_journal_id: txn.transaction_journal_id,
        tags,
      };

      if (result.outcome !== "NEEDS_REVIEW" && result.category) {
        const catId = this.findCategoryId(result.category);
        if (catId) update.category_id = catId;
      } else if (result.outcome === "NEEDS_REVIEW") {
        update.category_id = null;
        update.category_name = null;
      }

      if (notes) {
        update.notes = [txn.notes, notes].filter(Boolean).join("\n\n");
      }

      body.transactions.push(update);
    }

    const response = await fetch(`${this.#BASE_URL}/api/v1/transactions/${transactionId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.#PERSONAL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new FireflyException(response.status, response, await response.text());
    }

    await response.json();
    console.info(`Transaction ${transactionId} updated [${result.outcome}]`);
  }

  isConfigured() {
    return Boolean(this.#BASE_URL && this.#PERSONAL_TOKEN);
  }

  getHealthStatus() {
    return {
      configured: this.isConfigured(),
      baseUrl: this.#BASE_URL,
    };
  }

  getTransactionUrl(transactionId) {
    if (!this.#UI_URL || !transactionId) {
      return null;
    }

    return `${this.#UI_URL}/transactions/show/${encodeURIComponent(String(transactionId))}`;
  }

  #categories = null;

  setCategoryList(categories) {
    this.#categories = categories;
  }

  findCategoryId(name) {
    if (!this.#categories) return null;
    const match = this.#categories.find((c) => c.name === name);
    return match ? match.id : null;
  }

  #tagForOutcome(outcome) {
    const prefix = this.#tagPrefix();
    const tags = {
      CLASSIFIED: `${prefix}:classified`,
      ASSUMED: `${prefix}:assumed`,
      NEEDS_REVIEW: `${prefix}:needs-review`,
    };
    return tags[outcome] || `${prefix}:unknown`;
  }

  #tagPrefix() {
    return getConfigVariable("TAG_PREFIX", "ai");
  }

  #buildNotes(result) {
    const parts = [];
    if (result.reason) parts.push(`AI: ${result.reason}`);
    if (result.assumption) parts.push(`Assumption: ${result.assumption}`);
    return parts.join("\n") || null;
  }

  #assertConfigured() {
    if (!this.#BASE_URL) {
      throw new Error("FIREFLY_URL is missing.");
    }

    if (!this.#PERSONAL_TOKEN) {
      throw new Error("FIREFLY_PERSONAL_TOKEN is missing.");
    }
  }
}

function sanitizeOutcomeTags(tags, tagPrefix) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const removableTags = new Set([
    `${tagPrefix}:classified`,
    `${tagPrefix}:assumed`,
    `${tagPrefix}:needs-review`,
  ].map((tag) => tag.toLocaleLowerCase()));

  return tags.filter((tag) => typeof tag === "string"
    && tag.trim()
    && !removableTags.has(tag.trim().toLocaleLowerCase()));
}

class FireflyException extends Error {
  code;
  response;
  body;

  constructor(statusCode, response, body) {
    super(`Error communicating with Firefly III: ${statusCode} - ${body}`);
    this.code = statusCode;
    this.response = response;
    this.body = body;
  }
}
