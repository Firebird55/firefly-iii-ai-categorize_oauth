import { getConfigVariable } from "./util.js";

export default class FireflyService {
  #BASE_URL;
  #PERSONAL_TOKEN;

  constructor() {
    this.#BASE_URL = getConfigVariable("FIREFLY_URL");
    if (this.#BASE_URL.endsWith("/")) {
      this.#BASE_URL = this.#BASE_URL.slice(0, -1);
    }
    this.#PERSONAL_TOKEN = getConfigVariable("FIREFLY_PERSONAL_TOKEN");
  }

  async getCategories() {
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

  async updateTransaction(transactionId, transactions, result) {
    const tag = this.#tagForOutcome(result.outcome);
    const notes = this.#buildNotes(result);

    const body = {
      apply_rules: true,
      fire_webhooks: false,
      transactions: [],
    };

    for (const txn of transactions) {
      const tags = [...(txn.tags || [])];
      if (!tags.includes(tag)) tags.push(tag);

      const update = {
        transaction_journal_id: txn.transaction_journal_id,
        tags,
      };

      if (result.outcome !== "NEEDS_REVIEW" && result.category) {
        const catId = this.findCategoryId(result.category);
        if (catId) update.category_id = catId;
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
    const prefix = getConfigVariable("TAG_PREFIX", "ai");
    const tags = {
      CLASSIFIED: `${prefix}:classified`,
      ASSUMED: `${prefix}:assumed`,
      NEEDS_REVIEW: `${prefix}:needs-review`,
    };
    return tags[outcome] || `${prefix}:unknown`;
  }

  #buildNotes(result) {
    const parts = [];
    if (result.reason) parts.push(`AI: ${result.reason}`);
    if (result.assumption) parts.push(`Assumption: ${result.assumption}`);
    return parts.join("\n") || null;
  }
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
