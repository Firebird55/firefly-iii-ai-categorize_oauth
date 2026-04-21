# Firefly III AI Categorization (Three-Outcome Fork)

> Fork of [bahuma20/firefly-iii-ai-categorize](https://github.com/bahuma20/firefly-iii-ai-categorize), rebuilt with a three-outcome classification model inspired by [OpenAccountants](https://github.com/openaccountants/openaccountants).

Automatically categorize transactions in [Firefly III](https://www.firefly-iii.org/) using an LLM. Every transaction gets one of three outcomes:

| Outcome | What happens | Firefly III tag |
|---------|-------------|-----------------|
| **Classified** | Confident match → category is set | `ai:classified` |
| **Assumed** | Best guess with conservative default → category is set, assumption disclosed in notes | `ai:assumed` |
| **Needs Review** | Can't classify → no category set, flagged for human review | `ai:needs-review` |

## What changed from the original

The [original project](https://github.com/bahuma20/firefly-iii-ai-categorize) is unmaintained (the author [invited forks](https://github.com/bahuma20/firefly-iii-ai-categorize#please-fork-me)). This fork:

- **Three-outcome model** instead of binary (match or nothing). When the AI isn't confident enough to classify but can make a reasonable guess, it applies a conservative default and discloses the assumption — rather than silently guessing or doing nothing.
- **Conservative defaults principle**: when uncertain between two categories, picks the one less favorable to the user (e.g., non-deductible over deductible). You can always override, but the default is safe.
- **Modern OpenAI SDK** (v6+) with structured JSON output instead of the deprecated v3 completions API.
- **Configurable model** — defaults to `gpt-4o-mini`; set `OPENAI_MODEL` to use any OpenAI-compatible model.
- **OpenAI-compatible base URL** — set `OPENAI_BASE_URL` to point at any compatible API (Ollama, Azure, etc.).
- **Codex OAuth mode** — optional `OPENAI_AUTH_MODE=codex_oauth` support for a local ChatGPT/Codex auth file, refreshed automatically.
- **Transaction amount** included in the prompt for better classification.
- **Notes on transactions** — assumptions and reasoning are written to Firefly III transaction notes for auditability.
- **Pagination** for categories (the original only fetched the first page).
- **Richer health endpoint** at `GET /health` with readiness and auth-mode details.
- **Failed job tracking** in the UI.

## How it works

```
Firefly III webhook (new transaction)
        │
        ▼
   Parse & validate
        │
        ▼
   Fetch your Firefly III categories
        │
        ▼
   Send to LLM with three-outcome prompt
        │
        ├── CLASSIFIED  → set category + tag "ai:classified"
        ├── ASSUMED     → set category + tag "ai:assumed" + note with assumption
        └── NEEDS_REVIEW → tag "ai:needs-review" + note explaining why
```

## Quick start

### Docker Compose with API key

```yaml
services:
  categorizer:
    image: ghcr.io/openaccountants/firefly-iii-ai-categorize:latest
    restart: always
    ports:
      - "3000:3000"
    environment:
      FIREFLY_URL: "https://firefly.example.com"
      FIREFLY_PERSONAL_TOKEN: "eyabc123..."
      OPENAI_API_KEY: "sk-abc123..."
      # OPENAI_MODEL: "gpt-4o-mini"        # optional, default gpt-4o-mini
      # OPENAI_BASE_URL: ""                 # optional, for Ollama/Azure/etc.
      # TAG_PREFIX: "ai"                    # optional, default "ai"
      # ENABLE_UI: "true"                   # optional, default false
```

### Docker Compose with ChatGPT/Codex OAuth

This mode uses a local Codex auth file instead of `OPENAI_API_KEY`.

```yaml
services:
  categorizer:
    image: ghcr.io/openaccountants/firefly-iii-ai-categorize:latest
    restart: always
    ports:
      - "3000:3000"
    environment:
      FIREFLY_URL: "https://firefly.example.com"
      FIREFLY_PERSONAL_TOKEN: "eyabc123..."
      OPENAI_AUTH_MODE: "codex_oauth"
      OPENAI_MODEL: "gpt-5.4-mini"
      OPENAI_CODEX_AUTH_FILE: "/run/secrets/openai_codex_auth.json"
      # OPENAI_CODEX_BASE_URL: "https://chatgpt.com/backend-api/codex"
      # TAG_PREFIX: "ai"
      # ENABLE_UI: "true"
    volumes:
      - ./secrets/openai_codex_auth.json:/run/secrets/openai_codex_auth.json
```

The auth file is typically copied from your local Codex installation:

- macOS / Linux: `~/.codex/auth.json`
- Windows: `%USERPROFILE%\\.codex\\auth.json`

### Manual Docker

```bash
docker run -d \
  -p 3000:3000 \
  -e FIREFLY_URL=https://firefly.example.com \
  -e FIREFLY_PERSONAL_TOKEN=eyabc123... \
  -e OPENAI_API_KEY=sk-abc123... \
  ghcr.io/openaccountants/firefly-iii-ai-categorize:latest
```

Codex OAuth variant:

```bash
docker run -d \
  -p 3000:3000 \
  -e FIREFLY_URL=https://firefly.example.com \
  -e FIREFLY_PERSONAL_TOKEN=eyabc123... \
  -e OPENAI_AUTH_MODE=codex_oauth \
  -e OPENAI_MODEL=gpt-5.4-mini \
  -e OPENAI_CODEX_AUTH_FILE=/run/secrets/openai_codex_auth.json \
  -v $PWD/secrets/openai_codex_auth.json:/run/secrets/openai_codex_auth.json \
  ghcr.io/openaccountants/firefly-iii-ai-categorize:latest
```

### Without Docker

```bash
git clone https://github.com/openaccountants/firefly-iii-ai-categorize.git
cd firefly-iii-ai-categorize
npm install
FIREFLY_URL=https://firefly.example.com \
FIREFLY_PERSONAL_TOKEN=eyabc123... \
OPENAI_API_KEY=sk-abc123... \
npm start
```

Codex OAuth variant:

```bash
FIREFLY_URL=https://firefly.example.com \
FIREFLY_PERSONAL_TOKEN=eyabc123... \
OPENAI_AUTH_MODE=codex_oauth \
OPENAI_MODEL=gpt-5.4-mini \
OPENAI_CODEX_AUTH_FILE="$HOME/.codex/auth.json" \
npm start
```

## Set up the Firefly III webhook

1. Log in to Firefly III → Automation → Webhooks → Create new webhook
2. **Title**: AI Categorizer
3. **Trigger**: After transaction creation
4. **Response**: Transaction details
5. **Delivery**: JSON
6. **URL**: `http://categorizer:3000/webhook` (or wherever this runs)

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FIREFLY_URL` | Yes | — | URL to your Firefly III instance |
| `FIREFLY_PERSONAL_TOKEN` | Yes | — | Firefly III Personal Access Token |
| `OPENAI_AUTH_MODE` | No | `api_key` | `api_key` for the classic flow, or `codex_oauth` for a local ChatGPT/Codex auth file |
| `OPENAI_API_KEY` | API-key mode | — | OpenAI API key (or compatible provider) |
| `OPENAI_MODEL` | No | `gpt-4o-mini` or `gpt-5.4-mini` | Model to use; defaults depend on auth mode |
| `OPENAI_BASE_URL` | No | — | Custom base URL for OpenAI-compatible APIs |
| `OPENAI_CODEX_AUTH_FILE` | Codex mode | `/data/secrets/openai_codex_auth.json` | Path to a Codex auth.json file with access + refresh tokens |
| `OPENAI_CODEX_BASE_URL` | No | `https://chatgpt.com/backend-api/codex` | Override for the Codex-compatible backend |
| `TAG_PREFIX` | No | `ai` | Prefix for tags (produces `ai:classified`, etc.) |
| `ENABLE_UI` | No | `false` | Enable the web UI for monitoring |
| `PORT` | No | `3000` | Port to listen on |

## Health endpoint

`GET /health` always returns JSON and reports whether the service is actually ready:

```json
{
  "status": "ok",
  "ready": true,
  "model": "gpt-5.4-mini",
  "authMode": "codex_oauth"
}
```

If Firefly credentials or model auth are missing, `status` becomes `degraded` and the `checks` block explains why.

## Why three outcomes?

Most AI categorizers are binary: they either guess a category or do nothing. This creates a trust problem — you don't know when the AI was confident and when it was just guessing.

The three-outcome model (from [OpenAccountants' tax classification methodology](https://github.com/openaccountants/openaccountants)) makes the AI's confidence visible:

- **Classified**: high confidence, no action needed
- **Assumed**: medium confidence with a disclosed assumption — review when you have time
- **Needs Review**: low confidence — the AI didn't guess, it asked for help

You can filter transactions by tag in Firefly III to review only the ones that need attention.

## Privacy

Transaction details (description, destination, amount) are sent to the configured LLM provider or backend. If privacy is a concern, use a local model via `OPENAI_BASE_URL` (for example Ollama).

## License

AGPL-3.0 (same as the original).

## Credits

- Original project by [bahuma20](https://github.com/bahuma20/firefly-iii-ai-categorize)
- Three-outcome classification model by [OpenAccountants](https://github.com/openaccountants/openaccountants)
