import type { Config } from "../core/config.ts";
import type { EventBus } from "../core/events.ts";
import type {
  ChatMessage,
  FinishReason,
  Message,
  Part,
  ProviderEvent,
  QuestionPartData,
  ResearchDepth,
  Session,
  SourcePartData,
  ToolCallBlock,
  Usage,
} from "../core/types.ts";
import { newID, now, truncate } from "../core/util.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { Store } from "../storage/store.ts";
import type { PageFetcher } from "../crawl/fetcher.ts";
import type { SearchService } from "../search/search.ts";
import type { AskRequest, AskResponse, DeepResearchOptions, ToolContext, ToolRegistry, ToolResult } from "../tools/types.ts";
import { ResearchEngine } from "../research/engine.ts";
import { buildProviderHistory } from "./history.ts";
import { buildSystemPrompt } from "./prompt.ts";

/**
 * The agent loop.
 *
 * One prompt can produce several assistant messages (one per tool round). Each
 * message owns parts, and every part is persisted before the next provider call
 * so a crash never leaves the conversation in a state the model can't resume.
 */
export interface AgentDeps {
  config: Config;
  store: Store;
  registry: ProviderRegistry;
  tools: ToolRegistry;
  fetcher: PageFetcher;
  search: SearchService;
  bus: EventBus;
}

interface RunState {
  controller: AbortController;
}

interface PendingQuestion {
  sessionID: string;
  partID: string;
  finish: (response: AskResponse) => void;
}

export interface PromptOptions {
  model?: string;
  mode?: "chat" | "research";
}

const DEFAULT_TITLES = new Set(["New research", "New chat", "Untitled"]);

export class Agent {
  private runs = new Map<string, RunState>();
  private questions = new Map<string, PendingQuestion>();
  private readonly research: ResearchEngine;

  constructor(private readonly deps: AgentDeps) {
    this.research = new ResearchEngine(deps);
  }

  isRunning(sessionID: string): boolean {
    return this.runs.has(sessionID);
  }

  runningSessions(): string[] {
    return [...this.runs.keys()];
  }

  /**
   * Persist the user's prompt and start the loop in the background. Returns the
   * user message immediately so the HTTP layer can acknowledge it.
   */
  async prompt(sessionID: string, text: string, options: PromptOptions = {}): Promise<Message> {
    const prompt = text.trim();
    if (!prompt) throw new Error("Prompt is empty");
    if (this.runs.has(sessionID)) throw new Error("This session is already running. Abort it or wait for it to finish.");

    const session = this.deps.store.getSession(sessionID);
    if (!session) throw new Error(`Session ${sessionID} not found`);

    const user = this.deps.store.createMessage(sessionID, "user");
    this.deps.store.addPart(sessionID, user.id, "text", { text: prompt });
    this.deps.bus.publish({ type: "message.created", sessionID, message: user });
    const part = this.deps.store.listParts(user.id)[0];
    if (part) this.deps.bus.publish({ type: "part.created", sessionID, messageID: user.id, part });

    let updated = session;
    if (DEFAULT_TITLES.has(session.title) || !session.title.trim()) {
      updated = this.deps.store.updateSession(sessionID, { title: truncate(prompt.replace(/\s+/g, " "), 72) }) ?? session;
    }
    if (options.mode && options.mode !== updated.mode) {
      updated = this.deps.store.updateSession(sessionID, { mode: options.mode }) ?? updated;
    }
    if (updated !== session) this.deps.bus.publish({ type: "session.updated", session: updated });

    const controller = new AbortController();
    this.runs.set(sessionID, { controller });
    void this.run(sessionID, user, controller, options)
      .catch((err) => {
        // run() handles its own errors; this is only a guard for the finally.
        if (!controller.signal.aborted) console.error("[agent] unhandled run error:", err);
      })
      .finally(() => {
        this.runs.delete(sessionID);
        this.deps.store.touchSession(sessionID);
        this.deps.bus.publish({ type: "session.status", sessionID, status: "idle" });
        const latest = this.deps.store.getSession(sessionID);
        if (latest) this.deps.bus.publish({ type: "session.updated", session: latest });
      });

    return user;
  }

  abort(sessionID: string): boolean {
    const run = this.runs.get(sessionID);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  answerQuestion(questionID: string, answer: string[], custom?: string): boolean {
    const pending = this.questions.get(questionID);
    if (!pending) return false;
    this.questions.delete(questionID);
    pending.finish({ answer, custom });
    return true;
  }

  private async run(
    sessionID: string,
    userMessage: Message,
    controller: AbortController,
    options: PromptOptions,
  ): Promise<void> {
    const { store, registry, tools, bus, config } = this.deps;
    const session = store.getSession(sessionID);
    if (!session) return;

    let model: string | null = null;
    try {
      const requested = options.model?.trim() || session.model || config.agent.model;
      if (requested) {
        try {
          model = (await registry.resolve(requested)).ref;
        } catch (err) {
          if (options.model) throw err;
          model = await registry.defaultModel();
        }
      } else {
        model = await registry.defaultModel();
      }
      if (!model) {
        throw new Error("No model is available. Configure a provider key, start Ollama, or set agent.model in wandey config.");
      }
      const updated = store.updateSession(sessionID, { model });
      if (updated) bus.publish({ type: "session.updated", session: updated });
    } catch (err) {
      this.fail(sessionID, (err as Error).message);
      return;
    }

    let finalised = false;
    try {
      for (let step = 0; step < config.agent.maxSteps; step++) {
        if (controller.signal.aborted) break;

        const history = buildProviderHistory(store, sessionID, config.agent.contextChars);
        const system = buildSystemPrompt({
          config,
          session: store.getSession(sessionID) ?? session,
          tools,
          trimmedNote: history.note,
          model,
        });

        const assistant = store.createMessage(sessionID, "assistant", model);
        bus.publish({ type: "message.created", sessionID, message: assistant });
        bus.publish({ type: "session.status", sessionID, status: "streaming" });

        let text = "";
        let reasoning = "";
        let textPart: Part | null = null;
        let reasoningPart: Part | null = null;
        let textPartData = { text: "" };
        let reasoningPartData = { text: "" };
        let lastPersist = Date.now();
        const calls: ToolCallBlock[] = [];
        const usage: Usage = {};
        let finishReason: FinishReason = "stop";
        let streamError: string | null = null;

        const persistStreaming = (force = false) => {
          if (!force && Date.now() - lastPersist < 800) return;
          lastPersist = Date.now();
          if (textPart) store.updatePart(textPart.id, textPartData);
          if (reasoningPart) store.updatePart(reasoningPart.id, reasoningPartData);
        };

        const ensureTextPart = (): Part => {
          if (!textPart) {
            textPartData = { text: "" };
            textPart = store.addPart(sessionID, assistant.id, "text", textPartData);
            bus.publish({ type: "part.created", sessionID, messageID: assistant.id, part: textPart });
          }
          return textPart;
        };

        const ensureReasoningPart = (): Part => {
          if (!reasoningPart) {
            reasoningPartData = { text: "" };
            reasoningPart = store.addPart(sessionID, assistant.id, "reasoning", reasoningPartData);
            bus.publish({ type: "part.created", sessionID, messageID: assistant.id, part: reasoningPart });
          }
          return reasoningPart;
        };

        try {
          for await (const event of registry.stream(model, {
            system,
            messages: history.messages,
            tools: tools.schemas(),
            temperature: config.agent.temperature,
            signal: controller.signal,
          })) {
            this.consumeEvent(event, {
              onText: (delta) => {
                const part = ensureTextPart();
                text += delta;
                textPartData = { text };
                bus.publish({ type: "part.delta", sessionID, messageID: assistant.id, partID: part.id, kind: "text", delta });
                persistStreaming();
              },
              onReasoning: (delta) => {
                if (!config.agent.streamReasoning) return;
                const part = ensureReasoningPart();
                reasoning += delta;
                reasoningPartData = { text: reasoning };
                bus.publish({ type: "part.delta", sessionID, messageID: assistant.id, partID: part.id, kind: "reasoning", delta });
                persistStreaming();
              },
              onToolCall: (call) => calls.push(call),
              onUsage: (value) => mergeUsage(usage, value),
              onFinish: (reason, error) => {
                finishReason = reason;
                if (error) streamError = error;
              },
            });
          }
        } catch (err) {
          if (controller.signal.aborted || (err as Error).name === "AbortError") {
            finishReason = "aborted";
          } else {
            streamError = (err as Error).message;
            finishReason = "error";
          }
        }

        persistStreaming(true);
        const finalTextPart = textPart as Part | null;
        const finalReasoningPart = reasoningPart as Part | null;
        if (finalTextPart) {
          const saved = store.updatePart(finalTextPart.id, textPartData);
          if (saved) bus.publish({ type: "part.updated", sessionID, part: saved });
        }
        if (finalReasoningPart) {
          const saved = store.updatePart(finalReasoningPart.id, reasoningPartData);
          if (saved) bus.publish({ type: "part.updated", sessionID, part: saved });
        }

        if (controller.signal.aborted) finishReason = "aborted";
        if (streamError) finishReason = "error";
        else if (calls.length > 0) finishReason = "tool_calls";

        const hasUsage = Object.values(usage).some((value) => value !== undefined);
        const savedMessage = store.updateMessage(assistant.id, {
          finishReason,
          usage: hasUsage ? usage : null,
          error: streamError,
        });
        if (savedMessage) bus.publish({ type: "message.updated", sessionID, message: savedMessage });

        if (streamError) {
          this.addErrorPart(sessionID, assistant.id, streamError);
          bus.publish({ type: "session.error", sessionID, message: streamError });
          break;
        }
        if (controller.signal.aborted) {
          if (!textPart && calls.length === 0) this.addErrorPart(sessionID, assistant.id, "Stopped by user.");
          break;
        }
        if (!text.trim() && reasoning.trim() && calls.length === 0) {
          // A model that only produced reasoning didn't answer. Surface it.
          this.addErrorPart(sessionID, assistant.id, "The model ended without producing an answer.");
          break;
        }
        if (calls.length === 0) {
          finalised = true;
          break;
        }

        bus.publish({ type: "session.status", sessionID, status: "tool" });
        for (const call of calls) {
          if (controller.signal.aborted) break;
          await this.runTool(sessionID, assistant.id, call, controller);
        }
        if (controller.signal.aborted) break;

        if (step === config.agent.maxSteps - 1) {
          this.addErrorPart(
            sessionID,
            assistant.id,
            `Reached the step limit (${config.agent.maxSteps}). The task may be incomplete; raise agent.maxSteps if needed.`,
          );
        }
      }

      if (!finalised && controller.signal.aborted) {
        // The last message was already marked aborted; nothing extra needed.
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        this.fail(sessionID, (err as Error).message);
      }
    } finally {
      bus.publish({ type: "session.status", sessionID, status: "idle" });
      bus.publish({ type: "session.updated", session: store.getSession(sessionID) ?? session });
    }
  }

  private consumeEvent(
    event: ProviderEvent,
    handlers: {
      onText: (delta: string) => void;
      onReasoning: (delta: string) => void;
      onToolCall: (call: ToolCallBlock) => void;
      onUsage: (usage: Usage) => void;
      onFinish: (reason: FinishReason, error?: string) => void;
    },
  ): void {
    switch (event.type) {
      case "text":
        handlers.onText(event.delta);
        break;
      case "reasoning":
        handlers.onReasoning(event.delta);
        break;
      case "tool_call":
        handlers.onToolCall({ type: "tool_call", id: event.id, name: event.name, args: event.args, raw: event.raw });
        break;
      case "usage":
        handlers.onUsage(event.usage);
        break;
      case "finish":
        handlers.onFinish(event.reason, event.error);
        break;
    }
  }

  private async runTool(
    sessionID: string,
    messageID: string,
    call: ToolCallBlock,
    controller: AbortController,
  ): Promise<void> {
    const { store, tools, bus } = this.deps;
    const callID = call.id || newID("call");
    const toolPart = store.addPart(sessionID, messageID, "tool", {
      callID,
      name: call.name,
      args: call.args,
      status: "running",
      startedAt: now(),
    });
    bus.publish({ type: "part.created", sessionID, messageID, part: toolPart });

    const context: ToolContext = {
      sessionID,
      messageID,
      callID,
      signal: controller.signal,
      emit: (event) => bus.publish(event),
      store,
      config: this.deps.config,
      fetcher: this.deps.fetcher,
      search: this.deps.search,
      registry: this.deps.registry,
      ask: (request) => this.askUser(sessionID, messageID, request, controller),
      deepResearch: (question, depth, options) =>
        this.runDeepResearch(sessionID, question, depth, options),
    };

    const result = await tools.execute(call.name, call.args, context);
    const toolData = toolPart.data as import("../core/types.ts").ToolPartData;
    const updated = store.updatePart(toolPart.id, {
      ...toolData,
      status: result.isError ? "error" : "done",
      title: result.title,
      output: result.output,
      metadata: result.metadata,
      endedAt: now(),
    });
    if (updated) bus.publish({ type: "part.updated", sessionID, part: updated });

    if (result.sources && result.sources.length > 0) {
      const existing = new Set(
        store.listParts(messageID).filter((part) => part.type === "source").map((part) => part.data.sourceID),
      );
      for (const source of result.sources) {
        if (existing.has(source.sourceID)) continue;
        existing.add(source.sourceID);
        const part = store.addPart(sessionID, messageID, "source", source);
        bus.publish({ type: "part.created", sessionID, messageID, part });
      }
    }
  }

  private async runDeepResearch(
    sessionID: string,
    question: string,
    depth: ResearchDepth | undefined,
    options: DeepResearchOptions,
  ): Promise<ToolResult> {
    const session = this.deps.store.getSession(sessionID);
    const outcome = await this.research.run({
      sessionID,
      messageID: options.messageID,
      question,
      depth,
      model: session?.model ?? this.deps.config.agent.model,
      signal: options.signal,
    });

    const header = [
      `Deep research complete: ${outcome.sources.length} sources, ${outcome.notes} evidence notes, ${outcome.cited.length} cited.`,
      `Report file: ${outcome.outputPath}`,
      outcome.warnings.length > 0 ? `Warnings: ${outcome.warnings.slice(0, 6).join("; ")}` : "",
      "",
      "Use the report below to answer the user. Cite its [sN] ids; they match the source cards in this session.",
      "",
    ].filter(Boolean).join("\n");

    return {
      title: `Researched: ${truncate(question, 64)}`,
      output: truncate(`${header}${outcome.report}`, 48_000),
      metadata: {
        jobID: outcome.job.id,
        outputPath: outcome.outputPath,
        sources: outcome.sources.map((source) => ({
          sourceID: source.sourceID,
          title: source.title,
          url: source.url,
        })),
        cited: outcome.cited,
        notes: outcome.notes,
        warnings: outcome.warnings,
      },
    };
  }

  private askUser(
    sessionID: string,
    messageID: string,
    request: AskRequest,
    controller: AbortController,
  ): Promise<AskResponse> {
    const { store, bus } = this.deps;
    const questionID = newID("q");
    const data: QuestionPartData = {
      questionID,
      question: request.question,
      header: request.header,
      options: request.options,
      multiple: request.multiple ?? false,
      allowCustom: request.allowCustom ?? true,
      status: "pending",
    };
    const part = store.addPart(sessionID, messageID, "question", data);
    bus.publish({ type: "part.created", sessionID, messageID, part });
    bus.publish({ type: "question", sessionID, part });
    bus.publish({ type: "session.status", sessionID, status: "waiting" });

    return new Promise<AskResponse>((resolve) => {
      let done = false;
      const finish = (response: AskResponse, status: "answered" | "expired") => {
        if (done) return;
        done = true;
        this.questions.delete(questionID);
        const saved = store.updatePart(part.id, {
          ...data,
          answer: response.answer,
          custom: response.custom,
          status,
        });
        if (saved) {
          bus.publish({ type: "part.updated", sessionID, part: saved });
          bus.publish({ type: "question.done", sessionID, part: saved });
        }
        bus.publish({ type: "session.status", sessionID, status: "tool" });
        resolve(response);
      };

      this.questions.set(questionID, {
        sessionID,
        partID: part.id,
        finish: (response) => finish(response, "answered"),
      });

      const onAbort = () => finish({ answer: [] }, "expired");
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Called from run() when a step produced no tool calls; keeps timelines tidy. */
  private addErrorPart(sessionID: string, messageID: string, message: string): void {
    const part = this.deps.store.addPart(sessionID, messageID, "error", { message });
    this.deps.bus.publish({ type: "part.created", sessionID, messageID, part });
  }

  private fail(sessionID: string, message: string): void {
    const { store, bus, config } = this.deps;
    const assistant = store.createMessage(sessionID, "assistant", null);
    const part = store.addPart(sessionID, assistant.id, "error", { message });
    store.updateMessage(assistant.id, { error: message, finishReason: "error" });
    bus.publish({ type: "message.created", sessionID, message: assistant });
    bus.publish({ type: "part.created", sessionID, messageID: assistant.id, part });
    bus.publish({ type: "session.error", sessionID, message });
    void config;
  }
}

function mergeUsage(target: Usage, source: Usage): void {
  for (const key of Object.keys(source) as Array<keyof Usage>) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
  if (target.total === undefined && target.input !== undefined && target.output !== undefined) {
    target.total = target.input + target.output;
  }
}
