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
- **Local usage tracking** in the UI with token totals and estimated cost.
- **Historical backfill + reevaluation mode** with preview and queue actions for older uncategorized withdrawals or already tagged `ai:assumed` / `ai:needs-review` entries.
- **Direct Firefly III links** in the dashboard so each queued or reviewed entry can be opened in Firefly immediately.

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

### Docker Compose beside an existing Firefly III stack

This repo now includes its own `docker-compose.yml` so it can run as the main categorizer container outside your Firefly III repo while still attaching to the same Docker network.

1. Start your main Firefly III stack first so the shared Docker network exists.
2. Copy `.env.example` to `.env`.
3. Put your Firefly III Personal Access Token in `.env.local` as `FIREFLY_PERSONAL_TOKEN=...`.
4. Sign in with the Codex desktop app or Codex CLI on this machine.
5. Run `.\scripts\import-codex-auth.ps1`.
6. Run `docker compose up -d --build`.
7. In Firefly III, create a webhook that posts to `http://firefly_iii_ai_categorizer:3000/webhook`.

By default the container joins the `fireflyiii_firefly_iii` Docker network and reaches Firefly III at `http://firefly_iii_app:8080`. If your main stack uses a different network or service name, update `FIREFLY_DOCKER_NETWORK` and `FIREFLY_URL` before starting.

Health endpoint and dashboard:

- `http://localhost:3202/health`
- `http://localhost:3202`

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
| `FIREFLY_URL` | Yes | — | URL used by the categorizer container to talk to Firefly III |
| `FIREFLY_UI_URL` | No | `FIREFLY_URL` | Browser-facing Firefly III URL used for dashboard links like `Open in Firefly III` |
| `FIREFLY_PERSONAL_TOKEN` | Yes | — | Firefly III Personal Access Token |
| `OPENAI_AUTH_MODE` | No | `api_key` | `api_key` for the classic flow, or `codex_oauth` for a local ChatGPT/Codex auth file |
| `OPENAI_API_KEY` | API-key mode | — | OpenAI API key (or compatible provider) |
| `OPENAI_MODEL` | No | `gpt-4o-mini` or `gpt-5.4-mini` | Model to use; defaults depend on auth mode |
| `OPENAI_BASE_URL` | No | — | Custom base URL for OpenAI-compatible APIs |
| `OPENAI_CODEX_AUTH_FILE` | Codex mode | `/data/secrets/openai_codex_auth.json` | Path to a Codex auth.json file with access + refresh tokens |
| `OPENAI_CODEX_BASE_URL` | No | `https://chatgpt.com/backend-api/codex` | Override for the Codex-compatible backend |
| `TAG_PREFIX` | No | `ai` | Prefix for tags (produces `ai:classified`, etc.) |
| `ENABLE_UI` | No | `false` | Enable the web UI for monitoring |
| `APP_STATE_FILE` | No | `/data/state/app-state.json` | JSON file used for persisted local stats and backfill history |
| `BACKFILL_DEFAULT_MAX_TRANSACTIONS` | No | `100` | Default max transactions shown in the UI backfill form |
| `BACKFILL_MAX_TRANSACTIONS` | No | `1000` | Hard cap for a single backfill request |
| `BACKFILL_PAGE_SIZE` | No | `100` | Firefly API page size used during historical scans |
| `QUEUE_CONCURRENCY` | No | `4` | Number of categorization workers that may run in parallel |
| `PORT` | No | `3000` | Port to listen on |

## Historical backfill and reevaluation

The normal webhook flow only handles new uncategorized withdrawals.

If you want to classify older records too, open the built-in UI and use the **Historical Scan And Reevaluation** section:

1. Choose a **Scan scope**:
   - `Uncategorized withdrawals` for the original backfill flow
   - `Assumed only`, `Needs review only`, or `Assumed + needs review` to reevaluate prior AI decisions
2. Optionally choose a start date and end date.
3. Optionally enter a **Model override** if you want the reevaluation to run with a different model than the current active one.
4. Run a preview first.
5. If the preview looks right, queue the scan.

Backfill scans Firefly III withdrawals through the API, skips transactions that are already categorized, and skips already tagged transactions unless you opt in. Reevaluation mode instead targets transactions already tagged with `ai:assumed` and/or `ai:needs-review`, replaces the old AI outcome tag with the new one, and can clear a previously assumed category if the new result is `NEEDS_REVIEW`. Both flows add jobs to the same live worker queue used for webhook traffic, and that queue can process multiple jobs in parallel through `QUEUE_CONCURRENCY`.

## Usage dashboard

When the UI is enabled, `http://localhost:3202` shows:

- the active model, with a UI control to change it and reset to the default
- an optional model override for historical reevaluation runs
- live queue counts
- outcome counts
- tracked token totals
- estimated cost when the model/provider reports usage
- recent scan runs and sample candidates
- direct links to open each transaction in Firefly III
- a buffered jobs feed that shows the latest slice first, lets you reveal older entries on demand, and pauses live inserts while you are browsing lower on the page

These totals are stored locally in `APP_STATE_FILE` and survive container restarts when the `./data` volume is mounted.

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
