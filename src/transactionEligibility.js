export const TRANSACTION_SELECTION_SCOPES = Object.freeze({
  UNCATEGORIZED: "uncategorized",
  ASSUMED: "assumed",
  NEEDS_REVIEW: "needs_review",
  ATTENTION: "attention",
});

const OUTCOME_TAG_SUFFIXES = Object.freeze({
  CLASSIFIED: "classified",
  ASSUMED: "assumed",
  NEEDS_REVIEW: "needs-review",
});

export function evaluateTransactionGroup(
  group,
  {
    tagPrefix = "ai",
    includeTagged = false,
    scope = TRANSACTION_SELECTION_SCOPES.UNCATEGORIZED,
  } = {},
) {
  const transactionGroupId = String(group?.id ?? "");
  const transactions = extractTransactions(group);

  if (transactions.length === 0) {
    return { eligible: false, reason: "missing-transactions", transactionGroupId, transactions: [] };
  }

  const transaction = transactions[0];
  const currentOutcome = getAiOutcomeFromTags(transaction?.tags, tagPrefix);

  if (transaction?.type !== "withdrawal") {
    return {
      eligible: false,
      reason: "not-withdrawal",
      transactionGroupId,
      transaction,
      transactions,
      currentOutcome,
    };
  }

  const normalizedScope = normalizeScope(scope);
  if (normalizedScope === TRANSACTION_SELECTION_SCOPES.UNCATEGORIZED) {
    if (transaction?.category_id !== null && transaction?.category_id !== undefined && transaction?.category_id !== "") {
      return {
        eligible: false,
        reason: "already-categorized",
        transactionGroupId,
        transaction,
        transactions,
        currentOutcome,
      };
    }

    if (!includeTagged && hasAiTag(transaction?.tags, tagPrefix)) {
      return {
        eligible: false,
        reason: "already-ai-tagged",
        transactionGroupId,
        transaction,
        transactions,
        currentOutcome,
      };
    }
  } else if (!matchesScope(currentOutcome, normalizedScope)) {
    return {
      eligible: false,
      reason: "not-selected-scope",
      transactionGroupId,
      transaction,
      transactions,
      currentOutcome,
    };
  }

  if (!transaction?.description && !transaction?.destination_name) {
    return {
      eligible: false,
      reason: "missing-text",
      transactionGroupId,
      transaction,
      transactions,
      currentOutcome,
    };
  }

  return {
    eligible: true,
    reason: "eligible",
    transactionGroupId,
    transaction,
    transactions,
    currentOutcome,
  };
}

export function hasAiTag(tags, tagPrefix = "ai") {
  if (!Array.isArray(tags)) {
    return false;
  }

  const normalizedPrefix = `${tagPrefix}:`.toLocaleLowerCase();
  return tags.some((tag) => typeof tag === "string" && tag.toLocaleLowerCase().startsWith(normalizedPrefix));
}

export function getAiOutcomeFromTags(tags, tagPrefix = "ai") {
  if (!Array.isArray(tags)) {
    return null;
  }

  const normalizedTags = tags
    .filter((tag) => typeof tag === "string" && tag.trim())
    .map((tag) => tag.trim().toLocaleLowerCase());

  for (const [outcome, suffix] of Object.entries(OUTCOME_TAG_SUFFIXES)) {
    const expectedTag = `${tagPrefix}:${suffix}`.toLocaleLowerCase();
    if (normalizedTags.includes(expectedTag)) {
      return outcome;
    }
  }

  return null;
}

function matchesScope(currentOutcome, scope) {
  if (scope === TRANSACTION_SELECTION_SCOPES.ASSUMED) {
    return currentOutcome === "ASSUMED";
  }

  if (scope === TRANSACTION_SELECTION_SCOPES.NEEDS_REVIEW) {
    return currentOutcome === "NEEDS_REVIEW";
  }

  if (scope === TRANSACTION_SELECTION_SCOPES.ATTENTION) {
    return currentOutcome === "ASSUMED" || currentOutcome === "NEEDS_REVIEW";
  }

  return true;
}

function normalizeScope(scope) {
  if (scope === TRANSACTION_SELECTION_SCOPES.ASSUMED
    || scope === TRANSACTION_SELECTION_SCOPES.NEEDS_REVIEW
    || scope === TRANSACTION_SELECTION_SCOPES.ATTENTION) {
    return scope;
  }

  return TRANSACTION_SELECTION_SCOPES.UNCATEGORIZED;
}

function extractTransactions(group) {
  if (Array.isArray(group?.transactions)) {
    return group.transactions;
  }

  if (Array.isArray(group?.attributes?.transactions)) {
    return group.attributes.transactions;
  }

  return [];
}
