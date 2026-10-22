# wandey

A debloated, unlimited research agent.

Wandey is an open-source agent framework focused on **research**, not coding. It gives you
an OpenCode-grade chat experience in the browser (streaming markdown, tool cards, reasoning
panes, interactive question popups) on top of a tiny Bun process that talks to models you
already have.

- **Bring your own provider.** Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, OpenAI,
  Anthropic, Gemini — and it can reuse the providers OpenCode already has configured on
  your machine.
- **Unlimited crawling.** A real crawler with a queue, robots.txt respect, per-host rate
  limits, dedupe, sitemaps and feeds, PDFs — every limit is a *configuration knob*, not a
  wall.
- **Deep research.** Multi-round planning, parallel research workers, evidence notes, and
  reports with numbered citations that link back to the exact page they came from.

## Status

Early and moving fast. Everything is being built in small, reviewable commits.

## Quick start

```sh
bun install
bun run dev        # starts the local server and opens the chat UI
```

## Requirements

- [Bun](https://bun.sh) >= 1.1
- At least one model provider. Nothing else is required — no Docker, no Postgres, no Redis.

## License

MIT
