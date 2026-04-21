export function evaluateTransactionGroup(group, { tagPrefix = "ai", includeTagged = false } = {}) {
  const transactionGroupId = String(group?.id ?? "");
  const transactions = extractTransactions(group);

  if (transactions.length === 0) {
    return { eligible: false, reason: "missing-transactions", transactionGroupId, transactions: [] };
  }

  const transaction = transactions[0];

  if (transaction?.type !== "withdrawal") {
    return { eligible: false, reason: "not-withdrawal", transactionGroupId, transaction, transactions };
  }

  if (transaction?.category_id !== null && transaction?.category_id !== undefined && transaction?.category_id !== "") {
    return { eligible: false, reason: "already-categorized", transactionGroupId, transaction, transactions };
  }

  if (!includeTagged && hasAiTag(transaction?.tags, tagPrefix)) {
    return { eligible: false, reason: "already-ai-tagged", transactionGroupId, transaction, transactions };
  }

  if (!transaction?.description && !transaction?.destination_name) {
    return { eligible: false, reason: "missing-text", transactionGroupId, transaction, transactions };
  }

  return {
    eligible: true,
    reason: "eligible",
    transactionGroupId,
    transaction,
    transactions,
  };
}

export function hasAiTag(tags, tagPrefix = "ai") {
  if (!Array.isArray(tags)) {
    return false;
  }

  const normalizedPrefix = `${tagPrefix}:`.toLocaleLowerCase();
  return tags.some((tag) => typeof tag === "string" && tag.toLocaleLowerCase().startsWith(normalizedPrefix));
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
