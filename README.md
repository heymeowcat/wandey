# wandey

**A debloated, provider-agnostic research agent.**

Wandey is an original, MIT-licensed research agent built around one job: investigating
questions on the web. It is not a coding agent and not a chat wrapper with a search box.
The browser UI has streaming answers, reasoning, tool cards, interactive questions,
citations, saved sources, and a research dashboard. Underneath is a small Bun process,
SQLite, and adapters for the models and search engines you already use.

- **Research first.** Deep research plans sub-questions, searches in parallel, reads pages,
  extracts cited evidence, fills gaps over rounds, and writes an auditable report.
- **Provider agnostic.** Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, OpenAI, Anthropic,
  Gemini, and other OpenAI-compatible endpoints. Wandey can also reuse API-key providers
  that OpenCode already has on your machine.
- **No artificial crawl ceiling.** The crawler has a queue, robots.txt handling, per-host
  politeness, sitemap support, dedupe, PDFs, and optional JS rendering. Every limit is a
  configuration knob.
- **Local-first.** One Bun process, one SQLite database, no Docker, Postgres, Redis, or
  account. The UI is plain TypeScript bundled in memory by the server.

Wandey is early software. Expect sharp edges, and read the code if you plan to rely on it.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Providers and models](#providers-and-models)
- [Search](#search)
- [Crawling](#crawling)
- [Deep research](#deep-research)
- [Browser UI](#browser-ui)
- [CLI](#cli)
- [Configuration](#configuration)
- [Data and files](#data-and-files)
- [HTTP and WebSocket API](#http-and-websocket-api)
- [Architecture](#architecture)
- [Development](#development)
- [Security and limitations](#security-and-limitations)
- [License](#license)

## Requirements

- [Bun](https://bun.sh) **1.1 or newer**.
- At least one model provider: a local server such as Ollama, or an API key.
- Optional: `pdftotext` from Poppler for local PDF extraction.
- Optional: a reader/render service for JavaScript-heavy pages. Wandey uses
  [Jina Reader](https://r.jina.ai) as a fallback by default; see [Crawling](#crawling).

## Install

Clone the repository, then install dependencies:

```sh
bun install
```

Run directly from the checkout:

```sh
./bin/wandey doctor
./bin/wandey
```

Or make the `wandey` command available on your `PATH`:

```sh
bun link
wandey doctor
```

`bun run dev` is an alias for `wandey serve`.

If PDF extraction is useful to you:

```sh
# macOS
brew install poppler

# Debian / Ubuntu
sudo apt install poppler-utils
```

## Quick start

The fastest path is a local model:

```sh
ollama serve
ollama pull qwen3:8b

wandey models
wandey
```

Wandey probes Ollama, LM Studio, and llama.cpp on their default ports automatically. If
you prefer a hosted model, export a key before starting:

```sh
export OPENROUTER_API_KEY=sk-or-...
wandey
```

The default server is `http://127.0.0.1:4319`. `wandey` opens it in your browser. Pick a
model in the top bar, leave **Deep research** off for a normal conversation, or switch it
on for a multi-round investigation.

Check the installation and see what Wandey found:

```sh
wandey doctor
wandey models --free
```

No config file is required. Create or edit one when you want persistence:

```sh
wandey config path
wandey config init
wandey config set agent.model "ollama/qwen3:8b"
wandey config set server.port 4319
```

## Providers and models

Model references use the form `provider/model`. Provider IDs are the keys shown by
`wandey models` and in the UI model picker. OpenRouter model IDs can contain slashes:

```text
openrouter/nvidia/nemotron-3-ultra-550b-a55b:free
ollama/qwen3:8b
anthropic/claude-sonnet-4-5
```

### Built-in providers

Wandey ships templates for these providers. Setting the environment variable registers
the provider automatically; the key stays in memory and is not written to the config file.

| Provider | ID | Environment variable |
| --- | --- | --- |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini` | `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `GOOGLE_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| OpenCode Zen | `opencode` | `OPENCODE_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |
| Z.ai | `zai` | `ZAI_API_KEY` or `Z_AI_API_KEY` |
| Moonshot | `moonshot` | `MOONSHOT_API_KEY` |
| MiniMax | `minimax` | `MINIMAX_API_KEY` |
| Together | `together` | `TOGETHER_API_KEY` |
| Fireworks | `fireworks` | `FIREWORKS_API_KEY` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` |

### Local providers

| Provider | ID | Default endpoint |
| --- | --- | --- |
| Ollama | `ollama` | `http://127.0.0.1:11434/v1` |
| LM Studio | `lmstudio` | `http://127.0.0.1:1234/v1` |
| llama.cpp server | `llamacpp` | `http://127.0.0.1:8080/v1` |

Local servers do not need a key. Wandey probes them at startup and ignores dead ports.
They are OpenAI-compatible, so any other local server can be added with a custom provider.

If Ollama is signed in (`ollama signin`), Wandey also discovers Ollama's cloud models and
lists them under the same provider, for example `minimax-m3.1-flash:cloud` or
`gpt-oss:120b-cloud`. Free models currently advertised by Ollama's catalog are labeled
`free` in the picker.

### Custom providers

Add any OpenAI-, Anthropic-, or Gemini-compatible endpoint under `providers`:

```json
{
  "providers": {
    "lab": {
      "kind": "openai",
      "baseUrl": "http://127.0.0.1:9000/v1",
      "local": true,
      "models": ["my-finetune"]
    },
    "proxy": {
      "kind": "openai",
      "baseUrl": "https://llm.example.com/v1",
      "apiKeyEnv": "PROXY_API_KEY",
      "headers": { "X-Organization": "research" }
    }
  }
}
```

- `kind` is `openai`, `anthropic`, or `gemini`.
- `apiKeyEnv` names an environment variable. A literal `apiKey` is also accepted, but keep
  secrets out of files when possible.
- `models` is a fallback list for endpoints without a `/models` route.
- `enabled: false` disables a built-in template as well as a custom provider.
- `local: true` tells Wandey that a missing key is expected.

### OpenCode credentials

If OpenCode is installed, Wandey reads its local credential database **read-only** and
registers API-key providers it recognizes. OAuth refresh tokens are deliberately ignored.
Secrets are kept in memory; nothing is copied into Wandey's config or database.

OpenCode's database is searched in the usual XDG, macOS Application Support, and
`~/.opencode` locations. Disable the integration if you do not want it:

```sh
wandey config set integrations.opencode false
wandey serve --no-opencode
wandey chat --no-opencode
```

### OpenCode free models (local runtime)

OpenCode's anonymous free models are available through an optional local runtime. The free
tier only works inside OpenCode itself; a direct API call is rejected. Wandey therefore starts
the OpenCode CLI on demand and talks to its local HTTP API. It does not impersonate a client
or copy free-tier headers.

Install OpenCode and make sure `opencode` is on your `PATH`. Then enable the integration:

```sh
wandey config set integrations.opencodeLocal true
wandey serve --opencode-local
wandey chat --opencode-local --model opencode-local/big-pickle
```

In the browser, open **Providers → Local runtime → Enable**. The card shows the runtime status
and how many free models are available.

Model references use the `opencode-local` provider:

```text
opencode-local/big-pickle
opencode-local/deepseek-v4.1-flash-free
opencode-local/beam-free
```

`wandey models --provider opencode-local` lists the free models currently advertised by
OpenCode, with a built-in fallback list when the network is unavailable.

The runtime is isolated. Wandey starts `opencode serve` on a random loopback port with a
throwaway `HOME`, XDG directories, and an empty working directory. It cannot read your project,
Wandey's config or keys, your OpenCode config, or your OpenCode history. A custom text agent
disables shell, edit, subagent, external-directory, todo, question, web fetch/search, LSP, skill,
and browser tools. Read-only discovery tools stay enabled because the free tier rejects requests
when tools are fully denied; the empty temporary directory limits what they can see. The
process is stopped when the integration is disabled or Wandey exits.

**This backend is text-only.** Wandey does not send tool schemas, so these models cannot browse,
cite sources, or run deep research from chat. They answer from the conversation and their own
knowledge. Use a tool-capable provider when you need current sources or a cited report.

### Listing models

```sh
wandey models
wandey models --provider openrouter --free --limit 10
wandey models --provider opencode-local
wandey models --all
wandey models --refresh
wandey models --json
```

Listing is best-effort and cached in the process. A provider that is down, rate-limited, or
does not implement `/models` will show an error in `wandey doctor` without stopping the app.

## Search

Search providers are merged round-robin so one API cannot crowd out the others. The
defaults need no account:

- **Bing RSS** (`bing`)
- **Wikipedia** (`wikipedia`)

Optional providers:

| Type | Configuration | Environment shortcut |
| --- | --- | --- |
| `brave` | `apiKey` or `apiKeyEnv` | `BRAVE_API_KEY` |
| `tavily` | `apiKey` or `apiKeyEnv` | `TAVILY_API_KEY` |
| `exa` | `apiKey` or `apiKeyEnv` | `EXA_API_KEY` |
| `searxng` | `baseUrl` | `SEARXNG_URL` |
| `duckduckgo` | no key | none |

If the config file does not define `search.providers`, Wandey automatically prepends
providers whose keys it finds in the environment. An explicit list always wins.

```json
{
  "search": {
    "maxResults": 10,
    "providers": [
      { "type": "searxng", "baseUrl": "http://127.0.0.1:8888" },
      { "type": "brave", "apiKeyEnv": "BRAVE_API_KEY" },
      { "type": "bing" },
      { "type": "wikipedia" }
    ]
  }
}
```

DuckDuckGo's HTML endpoint and Bing's RSS endpoint can rate-limit. Add a keyed provider or
a SearXNG instance for heavier use.

## Crawling

Wandey uses a real crawler, not just a single-page fetcher:

- concurrent workers with a per-host limit and configurable delay;
- canonical URL deduplication and tracking-parameter removal;
- robots.txt checks, sitemap discovery, and feed links;
- Readability extraction with a Markdown path;
- PDF extraction through `pdftotext`;
- an in-memory page cache;
- optional reader/renderer backends for JavaScript-heavy pages.

The agent has these web tools:

| Tool | Purpose |
| --- | --- |
| `web_search` | Search the configured providers and save results as candidates. |
| `fetch_url` | Fetch one page, extract readable text, and save it as a numbered source. |
| `crawl_site` | Crawl a site or a list of seeds with page, depth, path, and time budgets. |
| `read_source` | Read a saved source by ID, in character ranges. |
| `list_sources` | List every source in the session. |
| `save_report` | Write a Markdown report to the research output directory. |
| `deep_research` | Run the full multi-round research pipeline. |
| `ask_user` | Ask a selectable question when a decision cannot be inferred. |

`crawl_site` accepts `max_pages` (1-2000), `max_depth` (0-8), `same_domain`,
`include_paths`, `exclude_paths`, `include_sitemaps`, and `time_budget_seconds` (10-600).
Its defaults come from `crawl.maxPagesPerCall` (12) and `crawl.maxDepth` (1).

### Crawl settings

| Key | Default | Meaning |
| --- | --- | --- |
| `crawl.concurrency` | `8` | Total pages fetched in parallel. |
| `crawl.perHost` | `2` | Parallel requests per host. |
| `crawl.delayMs` | `300` | Delay between requests to the same host. |
| `crawl.timeoutMs` | `20000` | Per-request timeout. |
| `crawl.maxContentBytes` | `6291456` | Maximum response body buffered (6 MiB). |
| `crawl.maxCharsPerPage` | `80000` | Characters of a page handed to the model. |
| `crawl.maxPagesPerCall` | `12` | Default page budget for a crawl call. |
| `crawl.maxDepth` | `1` | Default link depth for a crawl call. |
| `crawl.respectRobots` | `true` | Check robots.txt before fetching. |
| `crawl.useSitemaps` | `true` | Discover sitemap URLs when crawling. |
| `crawl.readerFallback` | `true` | Use a reader service when extraction is weak. |
| `crawl.readerEndpoint` | `https://r.jina.ai` | Reader base URL. |
| `crawl.userAgent` | `wandey/0.1 (research agent)` | Sent with requests. |
| `crawl.pdf.enabled` | `true` | Try PDF extraction. |
| `crawl.pdf.command` | `pdftotext` | External PDF-to-text command. |
| `crawl.render.backend` | `none` | `none`, `reader`, `firecrawl`, or `crawl4ai`. |
| `crawl.render.endpoint` | `""` | Backend URL; empty uses the backend default. |
| `crawl.render.apiKey` | `""` | Backend token, if required. |

**Privacy note:** with the default `readerFallback: true`, pages that cannot be extracted
locally (including some PDFs and JS apps) are sent to `r.jina.ai` for Markdown conversion.
Set `crawl.readerFallback` to `false` for private or internal material. Firecrawl and
Crawl4AI are not used unless you explicitly set `crawl.render.backend`.

Example heavier configuration:

```json
{
  "crawl": {
    "concurrency": 16,
    "perHost": 3,
    "delayMs": 150,
    "maxPagesPerCall": 100,
    "maxDepth": 3,
    "readerFallback": false,
    "render": {
      "backend": "crawl4ai",
      "endpoint": "http://127.0.0.1:11235",
      "apiKey": ""
    }
  }
}
```

## Deep research

Deep research is the part that makes Wandey more than a chat UI. The engine is deliberately
visible rather than magic:

```text
plan -> search -> read -> extract -> (gap -> search -> read -> extract)*
     -> synthesize -> validate citations -> write Markdown + JSON
```

1. **Plan.** The model restates the question, sets scope, and breaks it into sub-questions
   with search queries.
2. **Search.** Queries run in parallel across configured search providers; results are
   deduplicated by canonical URL.
3. **Read.** The strongest pages are fetched concurrently, respecting crawl limits.
4. **Extract.** The worker model writes evidence notes: claim, quote, source ID,
   sub-question, confidence, and round.
5. **Gap rounds.** The model proposes follow-up questions from missing evidence. Each round
   adds notes and sources until the configured budget is exhausted.
6. **Synthesize.** The synthesis model receives only the evidence notes and source list,
   not the raw open web. That is what makes citations auditable.
7. **Validate.** Citations are normalized to `[s1]` form. Unknown source IDs are removed.
   A `## Sources` section is appended for the cited pages.
8. **Persist.** The report is written as Markdown plus a sidecar JSON file containing the
   plan, notes, sources, warnings, and generation time.

If planning or synthesis fails, the engine falls back to a deterministic report assembled
from the evidence notes rather than discarding the run. Aborting leaves the job marked
`aborted` and retains partial notes.

### Stop and resume

A research job is not just an in-memory loop. After planning, each search result, page read,
extraction, and gap round is checkpointed to the database. **Stop** cancels in-flight searches,
reads, and model calls; workers are allowed to settle before the job is marked aborted so
nothing writes progress after cancellation.

Use **Resume from saved work** on an aborted research card or in the research dashboard.
Resuming creates a new assistant message and continues the same job from its checkpoint:

- completed sub-questions are skipped;
- pages already read are not fetched again;
- evidence notes are reused rather than duplicated;
- the remaining gap rounds and synthesis run normally.

Jobs that were interrupted by a server restart are marked resumable on the next boot. Jobs
created before checkpointing existed still recover their saved plan, notes, and sources and
synthesize a report from that evidence, warning that unfinished follow-up questions were not
re-run.

Checkpoints live in the `research_job.state` column and include the plan, question rounds,
candidate URLs, page-to-source mappings, completed questions, warnings, and progress. Note
text and page bodies remain in their own tables, so a checkpoint stays small.

### Research settings

| Key | Default | Meaning |
| --- | --- | --- |
| `research.depth` | `standard` | Default depth: `quick`, `standard`, `deep`, or `exhaustive`. |
| `research.rounds` | `2` | Base number of evidence rounds. Depth scales this. |
| `research.breadth` | `4` | Search queries generated per sub-question. |
| `research.resultsPerQuery` | `8` | Search results considered per query. |
| `research.pagesPerSubQuestion` | `6` | Page budget for each sub-question. |
| `research.maxSources` | `60` | Maximum sources retained for a job. |
| `research.workers` | `3` | Parallel research/extraction workers. |
| `research.outputDir` | `$WANDEY_HOME/research` | Report output directory. |
| `research.maxReportChars` | `50000` | Maximum synthesized report length. |
| `research.planModel` | `""` | Optional separate planning model. |
| `research.workerModel` | `""` | Optional separate extraction model. |
| `research.synthModel` | `""` | Optional separate synthesis model. |

Depth scales the base budget and clamps it: `quick` is 0.5x, `standard` 1x, `deep` 1.5x,
and `exhaustive` 2x. The task can request a depth explicitly through the `deep_research`
tool, and the UI's Deep research toggle runs the agent in research mode.

A standard run commonly takes one to several minutes and produces dozens of sources. Report
quality depends heavily on the model's ability to plan and extract; smaller models often
need the fallback path.

## Browser UI

Start the server and open the URL:

```sh
wandey serve
# http://127.0.0.1:4319
```

The UI is intentionally close to a small IDE chat:

- session list with titles, modes, and deletion;
- streaming Markdown with syntax highlighting and code-copy buttons;
- reasoning pane for models that expose reasoning;
- tool cards with arguments, status, duration, and output;
- numbered citation chips that open the exact saved source in a modal;
- question modal with selectable options, multiple choice, custom text, and skip;
- deep-research progress card and full report viewer;
- research dashboard with jobs, plans, evidence notes, and source chips;
- model picker, provider summary, reconnect indicator, and light/dark theme;
- provider manager with a Local runtime toggle for OpenCode free models;
- responsive layout for narrow windows.

Keyboard shortcuts:

- `Enter` sends; `Shift+Enter` inserts a newline.
- `Cmd/Ctrl+K` starts a new research session.
- The theme toggle persists in browser `localStorage`.

The UI re-renders structure when messages or parts are created, and applies throttled,
targeted updates while text streams. It reconnects over WebSocket and falls back to polling
if the socket drops.

## CLI

The same agent runs in the terminal:

```sh
wandey chat
wandey chat --model openrouter/google/gemma-4-31b-it:free
wandey chat --research
wandey chat --continue
wandey chat --session ses_abc123
```

Chat streams assistant text, prints tool starts/finishes, shows research progress, lists
sources and token usage after each turn, and prompts for selectable questions. Reasoning is
hidden unless you pass `--reasoning`. Terminal output is plain Markdown, not rendered HTML.

Commands inside chat:

| Command | Action |
| --- | --- |
| `/model [ref]` | Show the model or switch to another ref. |
| `/research` | Toggle deep-research mode. |
| `/sources` | List saved sources. |
| `/session` | Show the session ID and title. |
| `/new` | Start a fresh session. |
| `/reasoning` | Toggle streamed reasoning. |
| `/help` | Show commands. |
| `/quit` | Exit. |

`Ctrl+C` aborts the current turn; press it at the prompt to exit. `exit` and `quit` also
work. Piping text into `wandey chat` is supported, which makes simple scripted checks easy.

### Command reference

```text
wandey [serve] [--host <host>] [--port <n>] [--model <ref>]
                [--no-open] [--dev] [--no-opencode]
                [--opencode-local | --no-opencode-local]

wandey chat [--model <ref>] [--research | --chat]
            [--session <id> | --continue] [--reasoning] [--no-opencode]
            [--opencode-local | --no-opencode-local]

wandey models [--provider <id>] [--free] [--all] [--limit <n>]
              [--refresh] [--json]
              [--opencode-local | --no-opencode-local]

wandey doctor [--json]

wandey config [show | path | init [--force] | set <key> <value>]

wandey version
```

`doctor` checks storage, providers, search, PDF support, renderer settings, and OpenCode
integrations. It exits non-zero only for critical problems such as unreadable storage or no
usable model provider.

## Configuration

The config file is JSON. Its default location is `~/.wandey/config.json`. Environment
variables can change both the config location and the data home:

| Variable | Effect |
| --- | --- |
| `WANDEY_HOME` | Default config and data root. Used for storage when config does not set one. |
| `WANDEY_CONFIG` | Explicit config file path. |
| `WANDEY_PORT` | Override `server.port`. |
| `WANDEY_HOST` | Override `server.host`. |
| `WANDEY_NO_OPEN=1` | Do not open a browser. |
| `NO_COLOR=1` | Disable CLI colors. |

A config file can live in a repository; `storage.dir` decides where runtime data goes.
`WANDEY_CONFIG` only changes the config location, while `WANDEY_HOME` isolates the default
data home too.

### Minimal config

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 4319,
    "openBrowser": true
  },
  "agent": {
    "model": "ollama/qwen3:8b",
    "maxSteps": 24,
    "temperature": 0.4,
    "contextChars": 220000,
    "autoTitle": true,
    "systemExtra": "",
    "streamReasoning": true
  },
  "storage": {
    "dir": "~/.wandey"
  }
}
```

### Agent settings

| Key | Default | Meaning |
| --- | --- | --- |
| `agent.model` | `""` | Default model ref. Empty means first tool-capable model. |
| `agent.maxSteps` | `24` | Model/tool loop limit before the run stops. |
| `agent.temperature` | `0.4` | Sampling temperature passed to providers. |
| `agent.contextChars` | `220000` | Approximate history budget before compaction. |
| `agent.autoTitle` | `true` | Derive session titles from the first prompt. |
| `agent.systemExtra` | `""` | Extra instructions appended to the research system prompt. |
| `agent.streamReasoning` | `true` | Request and display reasoning when available. |

### Other sections

- `server`: local host, port, and whether `serve` opens a browser.
- `providers`: provider records, as described above.
- `integrations.opencode`: import API-key credentials from OpenCode (default `true`).
- `integrations.opencodeLocal`: enable OpenCode's free models through the local CLI runtime
  (default `false`).
- `search`: provider list and `maxResults`.
- `crawl`: crawler, PDF, and renderer settings.
- `research`: deep-research budgets and model overrides.
- `storage.dir`: database and research home.

Precedence is: defaults, then the config file, then provider/search/port environment
shortcuts, then command-line flags. Explicit config wins over environment auto-detection for
providers and search.

## Data and files

By default:

```text
~/.wandey/
├── config.json       # optional; created with `wandey config init`
├── wandey.db         # SQLite database (WAL mode)
├── cache/            # reserved for local caches
└── research/         # deep-research reports: <slug>-<timestamp>-<job>.md/.json
```

The database stores sessions, messages, parts (text, reasoning, tool calls, questions,
sources, research parts, errors), saved pages, research jobs, evidence notes, and small
settings. Foreign keys cascade on session deletion.

Sources are session-scoped and numbered `s1`, `s2`, ... A citation chip resolves to the
stored page through the session, not to a live URL. This keeps reports reproducible after
the web page changes.

Model credentials are never stored in the database. Environment and OpenCode credentials
live in the provider registry's memory for the life of the process. Config output from the
CLI and HTTP API is redacted.

## HTTP and WebSocket API

The browser UI uses the same public API you can script against. The server binds to
`127.0.0.1` by default and has **no authentication**; do not expose it to an untrusted
network.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Version and uptime. |
| `GET` | `/api/models` | Models and provider statuses. |
| `GET` | `/api/providers` | Provider statuses and integration flags. |
| `POST` | `/api/integrations/opencode-local` | Enable or disable the local OpenCode runtime (`enabled`). |
| `GET` | `/api/config` | Redacted config and paths. |
| `GET` | `/api/sessions` | List sessions. |
| `POST` | `/api/sessions` | Create a session (`title`, `mode`, `model`). |
| `GET` | `/api/sessions/:id` | Session detail with messages, parts, and `running`. |
| `PATCH` | `/api/sessions/:id` | Update title, model, mode, or archived. |
| `DELETE` | `/api/sessions/:id` | Abort and delete a session. |
| `POST` | `/api/sessions/:id/prompt` | Start a run (`text`, `model`, `mode`). |
| `POST` | `/api/sessions/:id/abort` | Abort the active run. |
| `POST` | `/api/sessions/:id/answer` | Answer a pending question. |
| `GET` | `/api/sessions/:id/research` | List research jobs for a session. |
| `GET` | `/api/sessions/:id/sources/:sourceID` | Full saved source content. |
| `GET` | `/api/research/:jobID` | Job, notes, and sources. |
| `POST` | `/api/research/:jobID/resume` | Resume an aborted or interrupted job. |
| `GET` | `/ws` | WebSocket for session events. |

The WebSocket sends a `hello` event and then streams `session.updated`, `message.created`,
`part.created`, `part.delta`, `part.updated`, `session.status`, `session.error`,
`question`, `question.done`, `research.progress`, `crawl.progress`, and
`session.deleted` events. Client messages subscribe to a session, send prompts or aborts,
and answer questions. See `src/core/types.ts` for the exact shapes.

## Architecture

```text
web/ (vanilla TypeScript)
   |  HTTP + WebSocket
   v
src/server/server.ts
   |-- src/agent/agent.ts -------- provider loop, tools, questions, abort, finalization
   |     |-- src/providers/ ------- OpenAI-compatible, Anthropic, Gemini adapters
   |     |-- src/tools/ ----------- web_search, fetch_url, crawl_site, deep_research, ask_user
   |     |-- src/research/ -------- planner, workers, evidence, synthesis, citations
   |     `-- src/crawl + search --- fetch queue, robots, extraction, providers
   `-- src/storage/store.ts ------- SQLite persistence and event history
```

- `src/core/` holds shared types, config, URL canonicalization, events, and utilities.
- `src/agent/` owns the streamed model/tool loop and run lifecycle. It publishes server
  events and never knows whether the consumer is a browser or the terminal.
- `src/providers/` adapts three wire protocols plus the optional local OpenCode runtime behind
  one `ProviderAdapter` interface.
- `src/tools/` contains small, independently testable tools with a JSON-schema-style
  parameter description.
- `src/research/` is the deep-research pipeline. It depends on tools only through injected
  fetcher/search/store/model services.
- `src/storage/` is the schema and all persistence. SQLite is synchronous on purpose; this
  removes a class of "rendered before saved" races.
- `src/server/` serves API, WebSocket, static assets, and the in-memory UI bundle.
- `web/` is a no-framework browser client: `main.ts` controls state, `components.ts` builds
  DOM, `markdown.ts` renders Markdown and citations, `api.ts` wraps HTTP, `styles.css` is
  the whole design.
- `src/cli/` wires the same agent to readline and the terminal.
- `tests/` covers URL hygiene, citation validation, storage, and configuration.

The UI bundle is built with `Bun.build` at server startup and served as `/app.js`, so there
is no production build step. `scripts/build-web.ts` produces a static copy in `dist/web` for
other hosts.

## Development

```sh
bun test
bunx tsc --noEmit
bun run build:web
```

Live smoke tests use real providers and search engines; they are not part of `bun test`:

```sh
bun scripts/smoke-agent.ts [provider/model] ["prompt"]
bun scripts/smoke-research.ts [provider/model] ["question"] [depth]
```

`smoke-research.ts` writes its report under the configured data home. Both scripts use an
in-memory database.

The repository favors small, reviewable commits. The code is organized so the agent loop,
research pipeline, crawler, storage, browser, and CLI can be read independently.

## Security and limitations

- **No auth.** Wandey is a single-user local app. Keep the default loopback bind or put it
  behind your own authenticated proxy.
- **Web content is untrusted.** Search results and pages can contain prompt injection.
  Wandey treats sources as evidence, not instructions, but no agent is immune. Review
  citations before acting on a report.
- **Reader fallback is third-party.** `r.jina.ai` receives URLs of pages that local
  extraction cannot handle. Disable it for sensitive material.
- **Reports are only as good as the model.** Planning, extraction, and synthesis all depend
  on the selected model. Use a capable tool-calling model for research; check the notes and
  citations in the dashboard.
- **No coding tools.** Wandey deliberately has no shell or file-editing tool. It writes
  research reports, not code.
- **Early software.** APIs, schema, and UI will change. Back up `~/.wandey` if a research
  history matters to you.

## License

MIT. See [LICENSE](LICENSE).
