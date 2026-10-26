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
  ResearchJob,
  Run,
  RunStatus,
  RunStep,
  RunStepUsage,
  RunStopReason,
  Session,
  SourcePartData,
  ToolCallBlock,
  Usage,
} from "../core/types.ts";
import { estimateTokens, normalizeRunBudget } from "../core/run-usage.ts";
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
 *
 * Every prompt is also a durable run: model attempts and tool calls are written
 * to `run_step`, and checkpoints make an interrupted run resumable.
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

interface ActiveRun {
  controller: AbortController;
  sessionID: string;
  runID: string;
  promise: Promise<void>;
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

export interface PromptResult {
  message: Message;
  run: Run;
}

const DEFAULT_TITLES = new Set(["New research", "New chat", "Untitled"]);
const TRACE_INPUT_CHARS = 4_096;
const TRACE_OUTPUT_CHARS = 8_192;

export class Agent {
  private runs = new Map<string, ActiveRun>();
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
   * user message and run immediately so the HTTP layer can acknowledge them.
   */
  async prompt(sessionID: string, text: string, options: PromptOptions = {}): Promise<PromptResult> {
    const { store, bus, config } = this.deps;
    const prompt = text.trim();
    if (!prompt) throw new Error("Prompt is empty");
    if (this.runs.has(sessionID) || store.activeRun(sessionID)) {
      throw new Error("This session is already running. Abort it or wait for it to finish.");
    }

    const session = store.getSession(sessionID);
    if (!session) throw new Error(`Session ${sessionID} not found`);

    // The prompt and the run commit together: a unique active-run conflict must
    // not leave an orphaned user message in the conversation.
    const { user, run } = store.transaction(() => {
      const user = store.createMessage(sessionID, "user");
      store.addPart(sessionID, user.id, "text", { text: prompt });
      const run = store.createRun({
        sessionID,
        userMessageID: user.id,
        prompt,
        mode: options.mode ?? session.mode,
        model: options.model?.trim() || session.model || config.agent.model || null,
        // Budget configuration is added in a later commit; all-zero means
        // unlimited and matches today's behavior.
        budget: normalizeRunBudget(undefined),
      });
      return { user, run };
    });

    bus.publish({ type: "message.created", sessionID, message: user });
    const part = store.listParts(user.id)[0];
    if (part) bus.publish({ type: "part.created", sessionID, messageID: user.id, part });
    bus.publish({ type: "run.created", sessionID, run });

    let updated = session;
    if (
      config.agent.autoTitle &&
      (DEFAULT_TITLES.has(session.title) || !session.title.trim())
    ) {
      updated = store.updateSession(sessionID, { title: truncate(prompt.replace(/\s+/g, " "), 72) }) ?? session;
    }
    if (options.mode && options.mode !== updated.mode) {
      updated = store.updateSession(sessionID, { mode: options.mode }) ?? updated;
    }
    if (updated !== session) bus.publish({ type: "session.updated", session: updated });

    const controller = new AbortController();
    const active: ActiveRun = { controller, sessionID, runID: run.id, promise: Promise.resolve() };
    this.runs.set(sessionID, active);
    active.promise = this.executeRun(run.id, controller)
      .catch((err) => {
        // executeRun handles its own errors; this is only a guard for the finally.
        if (!controller.signal.aborted) console.error("[agent] unhandled run error:", err);
      })
      .finally(() => {
        this.runs.delete(sessionID);
        store.touchSession(sessionID);
        bus.publish({ type: "session.status", sessionID, status: "idle" });
        const latest = store.getSession(sessionID);
        if (latest) bus.publish({ type: "session.updated", session: latest });
      });

    return { message: user, run };
  }

  abort(sessionID: string): boolean {
    const run = this.runs.get(sessionID);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  abortAll(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  /**
   * Continue a stopped research job outside the chat/tool loop. The job already
   * owns its conversation, sources, and notes; this only creates a fresh
   * assistant message so the resumed research card is visible in the timeline.
   */
  async resumeResearch(jobID: string): Promise<Message> {
    const { store, bus, config } = this.deps;
    const job = store.getResearchJob(jobID);
    if (!job) throw new Error(`Research job ${jobID} not found`);
    if (job.status === "done") throw new Error("This research job is already complete.");
    if (this.runs.has(job.sessionID) || store.activeRun(job.sessionID)) {
      throw new Error("This session is already running. Wait for it to finish or stop it first.");
    }
    const session = store.getSession(job.sessionID);
    if (!session) throw new Error("The session for this research job no longer exists.");

    const model = job.state?.model?.trim() || session.model || config.agent.model || null;
    const assistant = store.createMessage(job.sessionID, "assistant", model);
    bus.publish({ type: "message.created", sessionID: job.sessionID, message: assistant });

    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      sessionID: job.sessionID,
      runID: "",
      promise: Promise.resolve(),
    };
    this.runs.set(job.sessionID, active);
    active.promise = this.runResearchResume(job, assistant, model, controller)
      .catch((err) => {
        if (!controller.signal.aborted) console.error("[agent] research resume error:", err);
      })
      .finally(() => {
        this.runs.delete(job.sessionID);
        store.touchSession(job.sessionID);
        bus.publish({ type: "session.status", sessionID: job.sessionID, status: "idle" });
        const latest = store.getSession(job.sessionID);
        if (latest) bus.publish({ type: "session.updated", session: latest });
      });
    return assistant;
  }

  private async runResearchResume(
    job: ResearchJob,
    message: Message,
    model: string | null,
    controller: AbortController,
  ): Promise<void> {
    const { store, bus } = this.deps;
    bus.publish({ type: "session.status", sessionID: job.sessionID, status: "streaming" });
    try {
      await this.research.resume({
        jobID: job.id,
        messageID: message.id,
        model: model ?? undefined,
        signal: controller.signal,
      });
      const saved = store.updateMessage(message.id, { finishReason: "stop" });
      if (saved) bus.publish({ type: "message.updated", sessionID: job.sessionID, message: saved });
    } catch (err) {
      const aborted = controller.signal.aborted || (err as Error).name === "AbortError";
      const detail = aborted ? "Stopped by user." : (err as Error).message;
      const saved = store.updateMessage(message.id, {
        finishReason: aborted ? "aborted" : "error",
        error: aborted ? null : detail,
      });
      if (saved) bus.publish({ type: "message.updated", sessionID: job.sessionID, message: saved });
      if (!aborted) {
        this.addErrorPart(job.sessionID, message.id, detail);
        bus.publish({ type: "session.error", sessionID: job.sessionID, message: detail });
      }
    }
  }

  answerQuestion(questionID: string, answer: string[], custom?: string): boolean {
    const pending = this.questions.get(questionID);
    if (!pending) return false;
    this.questions.delete(questionID);
    pending.finish({ answer, custom });
    return true;
  }

  private async executeRun(runID: string, controller: AbortController): Promise<void> {
    const { store, registry, tools, bus, config } = this.deps;
    const run = store.getRun(runID);
    if (!run) return;
    const sessionID = run.sessionID;
    const baseElapsedMs = run.usage.elapsedMs;
    const activeStart = Date.now();
    const elapsed = () => baseElapsedMs + (Date.now() - activeStart);

    let terminal: { status: RunStatus; stopReason: RunStopReason; error: string | null } | null = null;

    try {
      const session = store.getSession(sessionID);
      if (!session) {
        terminal = { status: "failed", stopReason: "error", error: "Session not found" };
        return;
      }

      let model: string | null = null;
      try {
        const requested = run.model?.trim() || session.model || config.agent.model;
        if (requested) {
          try {
            model = (await registry.resolve(requested)).ref;
          } catch (err) {
            if (run.model?.trim()) throw err;
            model = await registry.defaultModel();
          }
        } else {
          model = await registry.defaultModel();
        }
        if (!model) {
          throw new Error("No model is available. Configure a provider key, start Ollama, or set agent.model in wandey config.");
        }
        const updatedSession = store.updateSession(sessionID, { model });
        if (updatedSession) bus.publish({ type: "session.updated", session: updatedSession });
        store.updateRun(runID, { model });
      } catch (err) {
        const message = (err as Error).message;
        this.fail(sessionID, message);
        terminal = { status: "failed", stopReason: "error", error: message };
        return;
      }

      const canUseTools = await registry.supportsTools(model);
      let finalised = false;

      for (let step = 0; step < config.agent.maxSteps; step++) {
        if (controller.signal.aborted) break;

        const history = buildProviderHistory(store, sessionID, config.agent.contextChars);
        const system = buildSystemPrompt({
          config,
          session: store.getSession(sessionID) ?? session,
          tools,
          toolsEnabled: canUseTools,
          trimmedNote: history.note,
          model,
        });

        const assistant = store.createMessage(sessionID, "assistant", model);
        bus.publish({ type: "message.created", sessionID, message: assistant });
        store.updateRun(runID, { assistantMessageID: assistant.id });
        bus.publish({ type: "session.status", sessionID, status: "streaming" });

        const modelStep = store.createRunStep({
          runID,
          stepKey: `model:${step}`,
          kind: "model",
          name: "model",
          model,
          messageID: assistant.id,
          input: traceInput({
            systemChars: system.length,
            messages: history.messages.length,
            tools: canUseTools ? tools.names() : [],
          }),
        });
        this.publishRunStep(sessionID, modelStep);

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
            tools: canUseTools ? tools.schemas() : [],
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

        const stepUsage = this.stepUsage(
          usage,
          system.length + historyChars(history.messages),
          text.length + reasoning.length,
        );

        if (streamError) {
          this.finishStep(modelStep, sessionID, {
            status: "failed",
            error: streamError,
            output: truncate(text, TRACE_OUTPUT_CHARS),
            usage: stepUsage,
            endedAt: now(),
          });
          this.addErrorPart(sessionID, assistant.id, streamError);
          bus.publish({ type: "session.error", sessionID, message: streamError });
          terminal = { status: "failed", stopReason: "error", error: streamError };
          break;
        }
        if (controller.signal.aborted) {
          this.finishStep(modelStep, sessionID, {
            status: "aborted",
            error: "Stopped by user.",
            output: truncate(text, TRACE_OUTPUT_CHARS),
            usage: stepUsage,
            endedAt: now(),
          });
          if (!textPart && calls.length === 0) this.addErrorPart(sessionID, assistant.id, "Stopped by user.");
          terminal = { status: "aborted", stopReason: "user", error: null };
          break;
        }
        if (!text.trim() && reasoning.trim() && calls.length === 0) {
          const message = "The model ended without producing an answer.";
          this.finishStep(modelStep, sessionID, {
            status: "failed",
            error: message,
            output: truncate(reasoning, TRACE_OUTPUT_CHARS),
            usage: stepUsage,
            endedAt: now(),
          });
          this.addErrorPart(sessionID, assistant.id, message);
          terminal = { status: "failed", stopReason: "error", error: message };
          break;
        }

        this.finishStep(modelStep, sessionID, {
          status: "completed",
          output: truncate(text, TRACE_OUTPUT_CHARS),
          usage: stepUsage,
          endedAt: now(),
        });
        this.syncRunUsage(runID, elapsed());

        if (calls.length === 0) {
          finalised = true;
          break;
        }

        bus.publish({ type: "session.status", sessionID, status: "tool" });
        for (let index = 0; index < calls.length; index++) {
          if (controller.signal.aborted) break;
          await this.runTool(run, assistant.id, calls[index]!, controller, step, index, elapsed);
        }
        if (controller.signal.aborted) break;

        if (step === config.agent.maxSteps - 1) {
          const message = `Reached the step limit (${config.agent.maxSteps}). The task may be incomplete; raise agent.maxSteps if needed.`;
          this.addErrorPart(sessionID, assistant.id, message);
          terminal = { status: "failed", stopReason: "step_limit", error: message };
        }
      }

      if (!terminal) {
        if (finalised) {
          terminal = { status: "completed", stopReason: "completed", error: null };
        } else if (controller.signal.aborted) {
          terminal = { status: "aborted", stopReason: "user", error: null };
        } else {
          terminal = {
            status: "failed",
            stopReason: "error",
            error: "The run ended without a final answer.",
          };
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      if (!controller.signal.aborted) {
        this.fail(sessionID, message);
        terminal = { status: "failed", stopReason: "error", error: message };
      } else {
        terminal = { status: "aborted", stopReason: "user", error: null };
      }
    } finally {
      if (terminal) {
        this.finishRun(runID, terminal.status, terminal.stopReason, terminal.error, elapsed());
      }
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
    run: Run,
    messageID: string,
    call: ToolCallBlock,
    controller: AbortController,
    loopStep: number,
    callIndex: number,
    elapsed: () => number,
  ): Promise<void> {
    const { store, tools, bus } = this.deps;
    const sessionID = run.sessionID;
    const callID = call.id || newID("call");
    const toolPart = store.addPart(sessionID, messageID, "tool", {
      callID,
      name: call.name,
      args: call.args,
      status: "running",
      startedAt: now(),
    });
    bus.publish({ type: "part.created", sessionID, messageID, part: toolPart });

    const step = store.createRunStep({
      runID: run.id,
      stepKey: `tool:${loopStep}:${callIndex}:${callID}`,
      kind: "tool",
      name: call.name,
      messageID,
      callID,
      input: traceInput(call.args),
    });
    this.publishRunStep(sessionID, step);

    // crawl_site reports a cumulative fetched count; keep the high-water mark
    // so the run budget counts pages, not progress ticks.
    let crawlPages = 0;
    const context: ToolContext = {
      sessionID,
      messageID,
      callID,
      signal: controller.signal,
      emit: (event) => {
        if (event.type === "crawl.progress") {
          crawlPages = Math.max(crawlPages, event.progress.fetched);
        }
        bus.publish(event);
      },
      store,
      config: this.deps.config,
      fetcher: this.deps.fetcher,
      search: this.deps.search,
      registry: this.deps.registry,
      ask: (request) => this.askUser(sessionID, messageID, request, controller, callID),
      deepResearch: (question, depth, options) =>
        this.runDeepResearch(sessionID, question, depth, options),
    };

    try {
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

      this.finishStep(step, sessionID, {
        status: "completed",
        title: result.title,
        output: truncate(result.output, TRACE_OUTPUT_CHARS),
        error: result.isError ? truncate(result.output, 2_000) : null,
        crawlPages,
        endedAt: now(),
      });
    } catch (err) {
      const message = (err as Error).message;
      this.finishStep(step, sessionID, {
        status: controller.signal.aborted ? "aborted" : "failed",
        error: message,
        crawlPages,
        endedAt: now(),
      });
      if (!controller.signal.aborted) throw err;
    } finally {
      this.syncRunUsage(run.id, elapsed());
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
    callID?: string,
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
      callID,
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

  private publishRunStep(sessionID: string, step: RunStep): void {
    this.deps.bus.publish({ type: "run.step", sessionID, runID: step.runID, step });
  }

  private finishStep(
    step: RunStep,
    sessionID: string,
    patch: Parameters<Store["updateRunStep"]>[1],
  ): RunStep | null {
    const updated = this.deps.store.updateRunStep(step.id, patch);
    if (updated) this.publishRunStep(sessionID, updated);
    return updated;
  }

  private syncRunUsage(runID: string, elapsedMs: number): Run | null {
    const { store, bus } = this.deps;
    const usage = store.sumRunUsage(runID);
    usage.elapsedMs = elapsedMs;
    const updated = store.updateRun(runID, { usage });
    if (updated) bus.publish({ type: "run.updated", sessionID: updated.sessionID, run: updated });
    return updated;
  }

  private finishRun(
    runID: string,
    status: RunStatus,
    stopReason: RunStopReason,
    error: string | null,
    elapsedMs: number,
  ): void {
    const { store, bus } = this.deps;
    const run = store.getRun(runID);
    if (!run) return;
    const usage = store.sumRunUsage(runID);
    usage.elapsedMs = elapsedMs;
    const updated = store.updateRun(runID, {
      status,
      stopReason,
      error,
      usage,
      endedAt: now(),
    });
    if (updated) bus.publish({ type: "run.updated", sessionID: updated.sessionID, run: updated });
  }

  private stepUsage(usage: Usage, inputChars: number, outputChars: number): RunStepUsage {
    const hasUsage = Object.values(usage).some((value) => value !== undefined);
    if (hasUsage) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      return { ...usage, total: usage.total ?? input + output };
    }
    const input = estimateTokens(inputChars);
    const output = estimateTokens(outputChars);
    return { input, output, total: input + output, estimated: true };
  }

  /** Called from run() when a step produced no tool calls; keeps timelines tidy. */
  private addErrorPart(sessionID: string, messageID: string, message: string): void {
    const part = this.deps.store.addPart(sessionID, messageID, "error", { message });
    this.deps.bus.publish({ type: "part.created", sessionID, messageID, part });
  }

  private fail(sessionID: string, message: string): void {
    const { store, bus } = this.deps;
    const assistant = store.createMessage(sessionID, "assistant", null);
    const part = store.addPart(sessionID, assistant.id, "error", { message });
    store.updateMessage(assistant.id, { error: message, finishReason: "error" });
    bus.publish({ type: "message.created", sessionID, message: assistant });
    bus.publish({ type: "part.created", sessionID, messageID: assistant.id, part });
    bus.publish({ type: "session.error", sessionID, message });
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

function historyChars(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case "text":
        case "reasoning":
          total += block.text.length;
          break;
        case "tool_call":
          total += block.name.length + JSON.stringify(block.args).length;
          break;
        case "tool_result":
          total += block.output.length;
          break;
      }
    }
  }
  return total;
}

function traceInput(value: unknown): string {
  try {
    return truncate(JSON.stringify(value), TRACE_INPUT_CHARS);
  } catch {
    return truncate(String(value), TRACE_INPUT_CHARS);
  }
}
