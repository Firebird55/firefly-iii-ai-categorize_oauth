import OpenAI from "openai";
import { getConfigVariable } from "./util.js";

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
  #model;

  constructor() {
    const apiKey = getConfigVariable("OPENAI_API_KEY");
    const baseURL = getConfigVariable("OPENAI_BASE_URL", null);
    this.#model = getConfigVariable("OPENAI_MODEL", "gpt-4o-mini");

    const opts = { apiKey };
    if (baseURL) opts.baseURL = baseURL;
    this.#client = new OpenAI(opts);
  }

  async classify(categories, destinationName, description, amount) {
    const userPrompt = this.#buildPrompt(categories, destinationName, description, amount);

    const response = await this.#client.chat.completions.create({
      model: this.#model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const raw = response.choices[0].message.content;
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
        rawResponse: raw,
      };
    }

    if (parsed.category && !categories.includes(parsed.category)) {
      console.warn(`Classifier returned unknown category "${parsed.category}", falling back to NEEDS_REVIEW`);
      parsed.outcome = "NEEDS_REVIEW";
      parsed.category = null;
      parsed.reason = `Model suggested "${parsed.category}" which is not in your category list`;
    }

    return {
      ...parsed,
      prompt: userPrompt,
      rawResponse: raw,
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
}
