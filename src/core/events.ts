import type { ServerEvent } from "./types.ts";

/**
 * A tiny event bus.
 *
 * The agent publishes ServerEvent objects; the server subscribes and fans them
 * out to every connected browser tab. Nothing else in the codebase knows how
 * events travel, which is what keeps the web UI and the CLI equally "native".
 */
export class EventBus {
  private subscribers = new Set<(event: ServerEvent) => void>();

  on(fn: (event: ServerEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(event: ServerEvent): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn(event);
      } catch (err) {
        // A broken subscriber must never break the agent loop.
        console.error("[events] subscriber failed:", err);
      }
    }
  }
}

/** Typed helper for tool code that only needs to emit progress events. */
export type Emit = (event: ServerEvent) => void;
