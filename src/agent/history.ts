import type { ChatMessage, ContentBlock, ToolResultBlock } from "../core/types.ts";
import type { Store } from "../storage/store.ts";
import { truncate } from "../core/util.ts";

/**
 * Turn persisted parts into provider messages.
 *
 * Assistant tool calls are reconstructed from tool parts, and their results are
 * appended as a synthetic user turn. OpenAI, Anthropic and Gemini adapters each
 * translate that shape into their own wire format.
 */
export interface HistoryResult {
  messages: ChatMessage[];
  trimmed: boolean;
  note?: string;
}

const TOOL_RESULT_CHARS = 12_000;

export function buildProviderHistory(store: Store, sessionID: string, contextChars: number): HistoryResult {
  const rows = store.providerHistory(sessionID);
  const messages: ChatMessage[] = [];

  for (const row of rows) {
    if (row.role === "user") {
      const text = row.content
        .filter((part) => part.type === "text")
        .map((part) => part.data.text)
        .join("\n\n")
        .trim();
      if (text) messages.push({ role: "user", content: [{ type: "text", text }] });
      continue;
    }

    const blocks: ContentBlock[] = [];
    const toolResults: ToolResultBlock[] = [];
    for (const part of row.content) {
      if (part.type === "text" && part.data.text.trim()) {
        blocks.push({ type: "text", text: part.data.text });
      } else if (part.type === "tool") {
        const data = part.data;
        blocks.push({
          type: "tool_call",
          id: data.callID || part.id,
          name: data.name,
          args: data.args,
        });
        if (data.status === "done" || data.status === "error") {
          toolResults.push({
            type: "tool_result",
            id: data.callID || part.id,
            name: data.name,
            title: data.title,
            output: truncate(data.output ?? "(no output)", TOOL_RESULT_CHARS),
            isError: data.status === "error",
          });
        }
      }
    }

    if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
    if (toolResults.length > 0) messages.push({ role: "user", content: toolResults });
  }

  const total = sizeOf(messages);
  if (total <= contextChars) return { messages, trimmed: false };

  // Drop whole oldest turns until under target. Never drop the final user turn.
  const target = Math.floor(contextChars * 0.8);
  let trimmed = false;
  while (sizeOf(messages) > target && messages.length > 6) {
    messages.shift();
    trimmed = true;
    // A tool-result user turn is meaningless without the assistant call.
    while (messages.length > 2 && isOnlyToolResults(messages[0]!)) {
      messages.shift();
    }
    if (messages.length > 0 && messages[0]!.role === "assistant") {
      messages.unshift({ role: "user", content: [{ type: "text", text: "(Earlier conversation omitted to fit the context window.)" }] });
    }
  }

  return {
    messages,
    trimmed,
    note: trimmed ? "Earlier turns were omitted to stay inside the context window. Ask for a recap if you need details." : undefined,
  };
}

function isOnlyToolResults(message: ChatMessage): boolean {
  return message.role === "user" && message.content.every((block) => block.type === "tool_result");
}

function sizeOf(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") total += block.text.length;
      else if (block.type === "tool_call") total += JSON.stringify(block.args).length + block.name.length;
      else if (block.type === "tool_result") total += (block.output?.length ?? 0) + 20;
    }
  }
  return total;
}
