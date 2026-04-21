import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTransactionGroup, TRANSACTION_SELECTION_SCOPES } from "../src/transactionEligibility.js";

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

test("assumed transaction can be reevaluated even when category is already set", () => {
  const result = evaluateTransactionGroup({
    id: "123",
    attributes: {
      transactions: [{
        type: "withdrawal",
        category_id: "42",
        destination_name: "ALBERT HEIJN",
        description: "Groceries",
        tags: ["ai:assumed"],
      }],
    },
  }, { scope: TRANSACTION_SELECTION_SCOPES.ASSUMED });

  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.equal(result.currentOutcome, "ASSUMED");
});

test("needs-review transaction can be reevaluated by scope", () => {
  const result = evaluateTransactionGroup({
    id: "123",
    attributes: {
      transactions: [{
        type: "withdrawal",
        category_id: null,
        destination_name: "UNKNOWN",
        description: "Card payment",
        tags: ["ai:needs-review"],
      }],
    },
  }, { scope: TRANSACTION_SELECTION_SCOPES.NEEDS_REVIEW });

  assert.equal(result.eligible, true);
  assert.equal(result.reason, "eligible");
  assert.equal(result.currentOutcome, "NEEDS_REVIEW");
});

test("classified transaction is excluded from attention reevaluation scope", () => {
  const result = evaluateTransactionGroup({
    id: "123",
    attributes: {
      transactions: [{
        type: "withdrawal",
        category_id: "7",
        destination_name: "ALBERT HEIJN",
        description: "Groceries",
        tags: ["ai:classified"],
      }],
    },
  }, { scope: TRANSACTION_SELECTION_SCOPES.ATTENTION });

  assert.equal(result.eligible, false);
  assert.equal(result.reason, "not-selected-scope");
  assert.equal(result.currentOutcome, "CLASSIFIED");
});
