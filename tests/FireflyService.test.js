import test from "node:test";
import assert from "node:assert/strict";
import FireflyService from "../src/FireflyService.js";

test("builds a Firefly III transaction URL", async () => {
  await withEnv({
    FIREFLY_URL: "https://firefly.example.com/",
    FIREFLY_PERSONAL_TOKEN: "test-token",
  }, async () => {
    const service = new FireflyService();
    assert.equal(
      service.getTransactionUrl("123"),
      "https://firefly.example.com/transactions/show/123",
    );
  });
});

test("reevaluation writeback replaces AI outcome tags and clears category for needs review", async () => {
  await withEnv({
    FIREFLY_URL: "https://firefly.example.com",
    FIREFLY_PERSONAL_TOKEN: "test-token",
    TAG_PREFIX: "ai",
  }, async () => {
    const requests = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options = {}) => {
      requests.push({ url, options });
      return {
        ok: true,
        async json() {
          return { data: {} };
        },
        async text() {
          return "";
        },
      };
    };

    try {
      const service = new FireflyService();
      await service.updateTransaction("123", [{
        transaction_journal_id: "456",
        tags: ["ai:assumed", "manual"],
        notes: "Existing note",
      }], {
        outcome: "NEEDS_REVIEW",
        category: null,
        reason: "Too vague",
        assumption: null,
      });

      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://firefly.example.com/api/v1/transactions/123");

      const body = JSON.parse(requests[0].options.body);
      assert.deepEqual(body.transactions[0].tags, ["manual", "ai:needs-review"]);
      assert.equal(body.transactions[0].category_id, null);
      assert.equal(body.transactions[0].category_name, null);
      assert.match(body.transactions[0].notes, /Existing note/);
      assert.match(body.transactions[0].notes, /AI: Too vague/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

async function withEnv(values, fn) {
  const originals = new Map();

  for (const [key, value] of Object.entries(values)) {
    originals.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    await fn();
  } finally {
    for (const [key, value] of originals.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
