import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTransactionGroup } from "../src/transactionEligibility.js";

test("eligible uncategorized withdrawal passes validation", () => {
  const result = evaluateTransactionGroup({
    id: "123",
    attributes: {
      transactions: [{
        type: "withdrawal",
        category_id: null,
        destination_name: "ALBERT HEIJN",
        description: "Groceries",
        tags: [],
      }],
    },
  });

  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.equal(result.transactionGroupId, "123");
});

test("ai-tagged transaction is skipped by default", () => {
  const result = evaluateTransactionGroup({
    id: "123",
    attributes: {
      transactions: [{
        type: "withdrawal",
        category_id: null,
        destination_name: "ALBERT HEIJN",
        description: "Groceries",
        tags: ["ai:classified"],
      }],
    },
  });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "already-ai-tagged");
});

test("ai-tagged transaction can be included when requested", () => {
  const result = evaluateTransactionGroup({
    id: "123",
    attributes: {
      transactions: [{
        type: "withdrawal",
        category_id: null,
        destination_name: "ALBERT HEIJN",
        description: "Groceries",
        tags: ["ai:classified"],
      }],
    },
  }, { includeTagged: true });

  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
});
