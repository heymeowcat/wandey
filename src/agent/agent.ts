import type { Config } from "../core/config.ts";
import type { EventBus } from "../core/events.ts";
import type {
  ChatMessage,
  FinishReason,
  Message,
  ModelInfo,
  Part,
  ProviderEvent,
  QuestionPartData,
  ResearchDepth,
  ResearchJob,
  Run,
  RunCheckpointState,
  RunStatus,
  RunStep,
  RunStepUsage,
  RunStopReason,
  Session,
  SourcePartData,
  ToolCallBlock,
  ToolPartData,
  Usage,
} from "../core/types.ts";
import { estimateTokens, normalizeRunBudget } from "../core/run-usage.ts";
import { newID, now, truncate } from "../core/util.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { Store } from "../storage/store.ts";
import type { PageFetcher } from "../crawl/fetcher.ts";
import type { SearchService } from "../search/search.ts";
import type { AskRequest, AskResponse, DeepResearchOptions, ToolContext, ToolRegistry, ToolResult } from "../tools/types.ts";
import { ResearchEngine, type ResearchObserver } from "../research/engine.ts";
import { buildProviderHistory } from "./history.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { BudgetExceededError, RunBudgetController, usageCost } from "./budget.ts";

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
        // Budget snapshots are per run: changing config affects new runs only.
        budget: normalizeRunBudget(config.agent.budget),
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

    this.startRun(run.id, sessionID, new AbortController());

    return { message: user, run };
  }

  /**
   * Continue an interrupted/failed/user-aborted run from its last checkpoint.
   * Partial model output is discarded, completed tool steps are reused, and a
   * linked deep-research job resumes instead of starting over.
   */
  async resumeRun(runID: string): Promise<Run> {
    const { store, bus } = this.deps;
    const run = store.getRun(runID);
    if (!run) throw new Error(`Run ${runID} not found`);
    if (run.dismissedAt) throw new Error("This run was dismissed. Start a new prompt instead.");
    if (run.status === "running" || run.status === "waiting") {
      throw new Error("This run is already running.");
    }
    if (run.status === "completed") throw new Error("This run is already complete.");
    if (run.stopReason === "budget") {
      throw new Error("This run stopped because its budget was exhausted. Start a new prompt to continue.");
    }
    if (this.runs.has(run.sessionID) || store.activeRun(run.sessionID)) {
      throw new Error("This session is already running. Abort it or wait for it to finish.");
    }
    if (!store.getSession(run.sessionID)) throw new Error("The session for this run no longer exists.");

    // A crash can leave an assistant message with no parts before the first
    // checkpoint was written. Those rows are noise, not answers.
    store.deleteEmptyAssistantMessages(run.sessionID);

    const checkpoint = store.latestRunCheckpoint(runID);
    const state = checkpoint?.state ?? null;

    if (state?.phase === "done") {
      this.completeInterruptedModelStep(state, run.sessionID);
      const usage = store.sumRunUsage(runID);
      const updated = store.updateRun(runID, {
        status: "completed",
        stopReason: "completed",
        error: null,
        usage,
        endedAt: run.endedAt ?? now(),
      });
      if (updated) bus.publish({ type: "run.updated", sessionID: updated.sessionID, run: updated });
      return updated ?? run;
    }

    if (state?.phase === "model" && state.assistantMessageID) {
      // Delete the partial stream before retrying. This is what prevents a
      // resumed answer from containing the first half twice.
      const step = state.modelStepID ? store.getRunStep(state.modelStepID) : null;
      if (step && step.status !== "completed") {
        this.finishStep(step, run.sessionID, {
          status: "failed",
          error: "Interrupted before completion",
          endedAt: now(),
        });
      }
      store.deleteMessage(state.assistantMessageID);
      store.createRunCheckpoint(runID, {
        version: 1,
        loopStep: state.loopStep,
        phase: "model",
        assistantMessageID: null,
        modelStepID: null,
        toolCalls: [],
        nextToolIndex: 0,
      });
    } else if (state?.phase === "tools") {
      // The checkpoint is written only after the model message and parts are
      // durable, so a still-running step is complete even if its final update
      // was lost.
      this.completeInterruptedModelStep(state, run.sessionID);
    }

    const usage = store.sumRunUsage(runID);
    const updated = store.updateRun(runID, {
      status: "running",
      error: null,
      stopReason: null,
      endedAt: null,
      usage,
      resumeCount: run.resumeCount + 1,
    });
    if (updated) bus.publish({ type: "run.updated", sessionID: updated.sessionID, run: updated });
    this.startRun(runID, run.sessionID, new AbortController());
    return updated ?? run;
  }

  private startRun(runID: string, sessionID: string, controller: AbortController): void {
    const active: ActiveRun = { controller, sessionID, runID, promise: Promise.resolve() };
    this.runs.set(sessionID, active);
    active.promise = this.executeRun(runID, controller)
      .catch((err) => {
        // executeRun handles its own errors; this is only a guard for the finally.
        if (!controller.signal.aborted) console.error("[agent] unhandled run error:", err);
      })
      .finally(() => {
        this.runs.delete(sessionID);
        this.deps.store.touchSession(sessionID);
        this.deps.bus.publish({ type: "session.status", sessionID, status: "idle" });
        const latest = this.deps.store.getSession(sessionID);
        if (latest) this.deps.bus.publish({ type: "session.updated", session: latest });
      });
  }

  private completeInterruptedModelStep(state: RunCheckpointState, sessionID: string): void {
    if (!state.modelStepID) return;
    const step = this.deps.store.getRunStep(state.modelStepID);
    if (step?.status === "running") {
      this.finishStep(step, sessionID, { status: "completed", endedAt: now() });
    }
  }

  private nextAttempt(runID: string, stepKey: string): number {
    return (this.deps.store.latestRunStep(runID, stepKey)?.attempt ?? 0) + 1;
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
    let stopBudget: (() => void) | null = null;
    let budgetError: BudgetExceededError | null = null;

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
      // Prefer the cached catalog; only probe providers when a cost budget
      // actually needs pricing data.
      const modelInfo =
        registry.modelInfoSync(model) ??
        (run.budget.maxCostUsd > 0 ? await registry.modelInfo(model) : null);
      const budget = new RunBudgetController({
        budget: run.budget,
        usage: store.sumRunUsage(runID),
        toolKeys: store
          .listRunSteps(runID)
          .filter((step) => step.kind === "tool" && step.status === "completed")
          .map((step) => step.stepKey),
        onExceeded: (error) => {
          budgetError = error;
          if (!controller.signal.aborted) controller.abort(error);
        },
      });
      stopBudget = budget.start();
      const checkpoint = store.latestRunCheckpoint(runID);
      let state: RunCheckpointState = checkpoint?.state ?? {
        version: 1,
        loopStep: 0,
        phase: "model",
        assistantMessageID: null,
        modelStepID: null,
        toolCalls: [],
        nextToolIndex: 0,
      };
      let finalised = false;

      while (state.loopStep < config.agent.maxSteps) {
        if (controller.signal.aborted) break;

        if (state.phase === "done") {
          finalised = true;
          break;
        }

        if (state.phase === "tools") {
          // The checkpoint is written after the model message and parts are
          // durable, so a still-running step completed even if its final
          // update was lost.
          this.completeInterruptedModelStep(state, sessionID);
          const messageID = state.assistantMessageID;
          if (!messageID) throw new Error("Run checkpoint is missing its assistant message.");
          bus.publish({ type: "session.status", sessionID, status: "tool" });

          for (let index = state.nextToolIndex; index < state.toolCalls.length; index++) {
            if (controller.signal.aborted) break;
            const call = state.toolCalls[index]!;
            const completed = await this.runTool(
              run,
              messageID,
              { type: "tool_call", id: call.id, name: call.name, args: call.args },
              controller,
              state.loopStep,
              index,
              elapsed,
              budget,
            );
            if (!completed) break;
            state = { ...state, nextToolIndex: index + 1 };
            store.createRunCheckpoint(runID, state);
          }
          if (controller.signal.aborted) break;
          if (state.nextToolIndex < state.toolCalls.length) break;

          if (state.loopStep >= config.agent.maxSteps - 1) {
            const message = `Reached the step limit (${config.agent.maxSteps}). The task may be incomplete; raise agent.maxSteps if needed.`;
            this.addErrorPart(sessionID, messageID, message);
            terminal = { status: "failed", stopReason: "step_limit", error: message };
            break;
          }

          state = {
            version: 1,
            loopStep: state.loopStep + 1,
            phase: "model",
            assistantMessageID: null,
            modelStepID: null,
            toolCalls: [],
            nextToolIndex: 0,
          };
          store.createRunCheckpoint(runID, state);
          continue;
        }

        budget.checkModel();
        budget.beginModelAttempt();

        const history = buildProviderHistory(store, sessionID, config.agent.contextChars);
        const system = buildSystemPrompt({
          config,
          session: store.getSession(sessionID) ?? session,
          tools,
          toolsEnabled: canUseTools,
          trimmedNote: history.note,
          model,
        });

        const assistant = state.assistantMessageID
          ? store.getMessage(state.assistantMessageID) ?? store.createMessage(sessionID, "assistant", model)
          : store.createMessage(sessionID, "assistant", model);
        if (!state.assistantMessageID) {
          bus.publish({ type: "message.created", sessionID, message: assistant });
          store.updateRun(runID, { assistantMessageID: assistant.id });
        }
        bus.publish({ type: "session.status", sessionID, status: "streaming" });

        const stepKey = `model:${state.loopStep}`;
        const modelStep = store.createRunStep({
          runID,
          stepKey,
          kind: "model",
          name: "model",
          attempt: this.nextAttempt(runID, stepKey),
          model,
          messageID: assistant.id,
          input: traceInput({
            systemChars: system.length,
            messages: history.messages.length,
            tools: canUseTools ? tools.names() : [],
          }),
        });
        this.publishRunStep(sessionID, modelStep);

        // Save the cursor before streaming so a crash always has a message and
        // step to clean up instead of a half-written conversation.
        state = {
          version: 1,
          loopStep: state.loopStep,
          phase: "model",
          assistantMessageID: assistant.id,
          modelStepID: modelStep.id,
          toolCalls: [],
          nextToolIndex: 0,
        };
        store.createRunCheckpoint(runID, state);

        let text = "";
        let reasoning = "";
        let textPart: Part | null = null;
        let reasoningPart: Part | null = null;
        let textPartData = { text: "" };
        let reasoningPartData = { text: "" };
        let lastPersist = Date.now();
        const calls: ToolCallBlock[] = [];
        const usage: Usage = {};
        let sawUsage = false;
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
              onUsage: (value) => {
                sawUsage = true;
                mergeUsage(usage, value);
                budget.addUsage(model, value, modelInfo);
              },
              onFinish: (reason, error) => {
                finishReason = reason;
                if (error) streamError = error;
              },
            });
          }
        } catch (err) {
          if (controller.signal.aborted) {
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
        const traceOutput = truncate(text, TRACE_OUTPUT_CHARS);

        // Providers sometimes omit usage entirely. Estimate from the prompt and
        // output so the budget still sees the spend.
        if (!sawUsage) {
          try {
            budget.addEstimatedUsage(
              system.length + historyChars(history.messages),
              text.length + reasoning.length,
              modelInfo,
            );
          } catch (err) {
            if (!(err instanceof BudgetExceededError)) throw err;
          }
        }

        if (budgetError) {
          this.finishStep(modelStep, sessionID, {
            status: "aborted",
            error: budgetError.message,
            output: traceOutput,
            usage: stepUsage,
            endedAt: now(),
          });
          terminal = this.budgetTerminal(sessionID, assistant.id, budgetError);
          break;
        }
        if (streamError) {
          this.finishStep(modelStep, sessionID, {
            status: "failed",
            error: streamError,
            output: traceOutput,
            usage: stepUsage,
            endedAt: now(),
          });
          this.addErrorPart(sessionID, assistant.id, streamError);
          bus.publish({ type: "session.error", sessionID, message: streamError });
          // A mid-stream failure is resumable. Resume deletes this partial
          // message and retries the same model step with the next attempt.
          terminal = { status: "interrupted", stopReason: "error", error: streamError };
          break;
        }
        if (controller.signal.aborted) {
          this.finishStep(modelStep, sessionID, {
            status: "aborted",
            error: "Stopped by user.",
            output: traceOutput,
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

        // Persist the step's output and usage before advancing the checkpoint.
        // If the process dies between the two writes, resume can trust the
        // checkpoint and still keep the trace's token counts.
        store.updateRunStep(modelStep.id, { output: traceOutput, usage: stepUsage });
        this.syncRunUsage(runID, elapsed());

        if (calls.length === 0) {
          state = { ...state, phase: "done" };
          store.createRunCheckpoint(runID, state);
          this.finishStep(modelStep, sessionID, { status: "completed", endedAt: now() });
          finalised = true;
          break;
        }

        const normalizedCalls = calls.map((call) => ({
          id: call.id || newID("call"),
          name: call.name,
          args: call.args,
        }));
        state = { ...state, phase: "tools", toolCalls: normalizedCalls, nextToolIndex: 0 };
        store.createRunCheckpoint(runID, state);
        this.finishStep(modelStep, sessionID, { status: "completed", endedAt: now() });
        this.syncRunUsage(runID, elapsed());
      }

      if (!terminal) {
        if (budgetError) {
          terminal = this.budgetTerminal(
            sessionID,
            store.getRun(runID)?.assistantMessageID ?? null,
            budgetError,
          );
        } else if (finalised) {
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
      const failure = budgetError ?? (err instanceof BudgetExceededError ? err : null);
      if (failure) {
        terminal = this.budgetTerminal(
          sessionID,
          store.getRun(runID)?.assistantMessageID ?? null,
          failure,
        );
      } else if (!controller.signal.aborted) {
        const message = (err as Error).message;
        this.fail(sessionID, message);
        terminal = { status: "failed", stopReason: "error", error: message };
      } else {
        terminal = { status: "aborted", stopReason: "user", error: null };
      }
    } finally {
      stopBudget?.();
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
    budget: RunBudgetController,
  ): Promise<boolean> {
    const { store, tools, bus } = this.deps;
    const sessionID = run.sessionID;
    const callID = call.id || newID("call");
    const stepKey = `tool:${loopStep}:${callIndex}:${callID}`;
    const existingPart = store
      .listParts(messageID)
      .find((part): part is Part & { type: "tool" } => part.type === "tool" && part.data.callID === callID);
    const existingStep = store.latestRunStep(run.id, stepKey);

    // A completed tool step already has a durable result. Reuse it instead of
    // calling the tool twice after a resume.
    if (existingStep?.status === "completed" && existingPart && existingPart.data.status !== "running") {
      return true;
    }
    if (existingStep?.status === "running") {
      this.finishStep(existingStep, sessionID, {
        status: "aborted",
        error: "Interrupted before completion",
        endedAt: now(),
      });
    }

    // Pre-flight before creating a new attempt, so a budget stop never leaves
    // a half-created tool part behind.
    budget.checkTool();
    budget.addToolCall(stepKey);

    let toolPart: Part;
    if (existingPart) {
      const updated = store.updatePart(existingPart.id, {
        ...existingPart.data,
        name: call.name,
        args: call.args,
        status: "running",
        title: undefined,
        output: undefined,
        metadata: undefined,
        endedAt: undefined,
        startedAt: now(),
      });
      toolPart = updated ?? existingPart;
      bus.publish({ type: "part.updated", sessionID, part: toolPart });
    } else {
      toolPart = store.addPart(sessionID, messageID, "tool", {
        callID,
        name: call.name,
        args: call.args,
        status: "running",
        startedAt: now(),
      });
      bus.publish({ type: "part.created", sessionID, messageID, part: toolPart });
    }

    const step = store.createRunStep({
      runID: run.id,
      stepKey,
      kind: "tool",
      name: call.name,
      attempt: this.nextAttempt(run.id, stepKey),
      messageID,
      callID,
      refID: existingStep?.refID ?? null,
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
          const fetched = Math.max(0, event.progress.fetched);
          if (fetched > crawlPages) {
            const delta = fetched - crawlPages;
            crawlPages = fetched;
            budget.addCrawlPages(delta);
          }
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
        this.runDeepResearch(sessionID, question, depth, options, run, step, budget, (delta) => {
          crawlPages += delta;
        }),
    };

    try {
      const result = await tools.execute(call.name, call.args, context);
      const toolData = toolPart.data as ToolPartData;
      const aborted = controller.signal.aborted;
      const updated = store.updatePart(toolPart.id, {
        ...toolData,
        status: aborted || result.isError ? "error" : "done",
        title: result.title,
        output: result.output,
        metadata: result.metadata,
        endedAt: now(),
      });
      if (updated) bus.publish({ type: "part.updated", sessionID, part: updated });

      if (aborted) {
        this.finishStep(step, sessionID, {
          status: "aborted",
          error: "Stopped by user.",
          crawlPages,
          endedAt: now(),
        });
        return false;
      }

      // fetch_url does not emit crawl progress; count the page it read.
      if (!result.isError && call.name === "fetch_url" && (result.sources?.length ?? 0) > 0) {
        crawlPages += 1;
        budget.addCrawlPages(1);
      }

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
      return true;
    } catch (err) {
      const message = (err as Error).message;
      const budgetFailure = (err as Error)?.name === "BudgetExceededError";
      this.finishStep(step, sessionID, {
        status: controller.signal.aborted || budgetFailure ? "aborted" : "failed",
        error: message,
        crawlPages,
        endedAt: now(),
      });
      if (budgetFailure || !controller.signal.aborted) throw err;
      return false;
    } finally {
      this.syncRunUsage(run.id, elapsed());
    }
  }

  private async runDeepResearch(
    sessionID: string,
    question: string,
    depth: ResearchDepth | undefined,
    options: DeepResearchOptions,
    run: Run,
    step: RunStep,
    budget: RunBudgetController,
    onPages: (delta: number) => void,
  ): Promise<ToolResult> {
    const { store, registry } = this.deps;
    const session = store.getSession(sessionID);
    const model = session?.model ?? this.deps.config.agent.model;
    const normalized = question.replace(/\s+/g, " ").trim();

    // Research uses up to three model refs. Resolve their pricing once so the
    // observer can account for batch calls without doing I/O in a callback.
    const researchModels = new Set([
      model,
      this.deps.config.research.planModel.trim() || model,
      this.deps.config.research.workerModel.trim() || model,
      this.deps.config.research.synthModel.trim() || model,
    ]);
    const modelInfo = new Map<string, ModelInfo | null>();
    for (const ref of researchModels) modelInfo.set(ref, registry.modelInfoSync(ref));

    const usage: RunStepUsage = { input: 0, output: 0, total: 0, cost: 0 };
    const observer: ResearchObserver = {
      onJobCreated: (job) => {
        const updated = store.updateRunStep(step.id, { refID: job.id });
        if (updated) this.publishRunStep(sessionID, updated);
      },
      onModelAttempt: () => budget.beginModelAttempt(),
      onModelUsage: (ref, value, estimated) => {
        const info = modelInfo.get(ref) ?? registry.modelInfoSync(ref);
        usage.input = (usage.input ?? 0) + (value.input ?? 0);
        usage.output = (usage.output ?? 0) + (value.output ?? 0);
        usage.total = (usage.total ?? 0) + (value.total ?? (value.input ?? 0) + (value.output ?? 0));
        usage.cost = (usage.cost ?? 0) + usageCost(value, info);
        usage.estimated = usage.estimated || estimated;
        const saved = store.updateRunStep(step.id, { usage: { ...usage } });
        if (saved) this.publishRunStep(sessionID, saved);
        budget.addUsage(ref, value, info, estimated);
      },
      onPagesFetched: (delta) => {
        const current = store.getRunStep(step.id);
        const saved = store.updateRunStep(step.id, { crawlPages: (current?.crawlPages ?? 0) + delta });
        if (saved) this.publishRunStep(sessionID, saved);
        onPages(delta);
        budget.addCrawlPages(delta);
      },
      assertBudget: () => budget.check(),
    };

    // A linked job is authoritative: resume it instead of creating a second
    // research run with the same question.
    let job = step.refID ? store.getResearchJob(step.refID) : null;
    if (job?.status === "done") return this.researchJobResult(job, question);

    if (!job) {
      // Crash window: the job row was inserted but the ref update was lost.
      job = store.findUnlinkedResearchJob(sessionID, normalized, run.startedAt);
      if (job) {
        const updated = store.updateRunStep(step.id, { refID: job.id });
        if (updated) this.publishRunStep(sessionID, updated);
      }
    }

    if (job?.status === "done") return this.researchJobResult(job, question);

    if (job) {
      const outcome = await this.research.resume({
        jobID: job.id,
        messageID: options.messageID,
        model,
        signal: options.signal,
        observer,
      });
      return this.researchOutcomeResult(outcome, question);
    }

    const outcome = await this.research.run({
      sessionID,
      messageID: options.messageID,
      question,
      depth,
      model,
      signal: options.signal,
      observer,
    });
    return this.researchOutcomeResult(outcome, question);
  }

  private researchOutcomeResult(
    outcome: {
      job: ResearchJob;
      report: string;
      outputPath: string | null;
      sources: SourcePartData[];
      cited: string[];
      notes: number;
      warnings: string[];
    },
    question: string,
  ): ToolResult {
    return this.researchResult(
      question,
      outcome.job,
      outcome.report,
      outcome.outputPath,
      outcome.sources,
      outcome.cited,
      outcome.notes,
      outcome.warnings,
    );
  }

  /** Rebuild a completed job's tool result without another model call. */
  private researchJobResult(job: ResearchJob, question: string): ToolResult {
    const report = job.report ?? "";
    const sourceIDs = new Set(job.state?.pages.map((page) => page.sourceID) ?? []);
    const sources = this.deps.store
      .listSources(job.sessionID)
      .filter((source) => sourceIDs.size === 0 || sourceIDs.has(source.sourceID));
    const cited = [...new Set([...report.matchAll(/\[(s\d+)\]/g)].map((match) => match[1]!))];
    return this.researchResult(
      question,
      job,
      report,
      job.outputPath,
      sources,
      cited,
      this.deps.store.listNotes(job.id).length,
      job.state?.warnings ?? [],
    );
  }

  private researchResult(
    question: string,
    job: ResearchJob,
    report: string,
    outputPath: string | null,
    sources: SourcePartData[],
    cited: string[],
    notes: number,
    warnings: string[],
  ): ToolResult {
    const header = [
      `Deep research complete: ${sources.length} sources, ${notes} evidence notes, ${cited.length} cited.`,
      `Report file: ${outputPath ?? "(not saved)"}`,
      warnings.length > 0 ? `Warnings: ${warnings.slice(0, 6).join("; ")}` : "",
      "",
      "Use the report below to answer the user. Cite its [sN] ids; they match the source cards in this session.",
      "",
    ].filter(Boolean).join("\n");

    return {
      title: `Researched: ${truncate(question, 64)}`,
      output: truncate(`${header}${report}`, 48_000),
      metadata: {
        jobID: job.id,
        outputPath,
        sources: sources.map((source) => ({
          sourceID: source.sourceID,
          title: source.title,
          url: source.url,
        })),
        cited,
        notes,
        warnings,
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

    // On resume, a question answered before the crash is still valid. A stale
    // pending question cannot be answered by the old process, so expire it and
    // ask again with a fresh part.
    if (callID) {
      const existing = store
        .listParts(messageID)
        .find((part): part is Part & { type: "question" } => part.type === "question" && part.data.callID === callID);
      if (existing?.data.status === "answered") {
        return Promise.resolve({ answer: existing.data.answer ?? [], custom: existing.data.custom });
      }
      if (existing?.data.status === "pending") {
        const expired = store.updatePart(existing.id, { ...existing.data, status: "expired" });
        if (expired) bus.publish({ type: "part.updated", sessionID, part: expired });
      }
    }

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

  private budgetTerminal(
    sessionID: string,
    messageID: string | null,
    error: BudgetExceededError,
  ): { status: "aborted"; stopReason: "budget"; error: string } {
    const message = error.message;
    if (messageID && this.deps.store.getMessage(messageID)) {
      this.addErrorPart(sessionID, messageID, message);
      this.deps.bus.publish({ type: "session.error", sessionID, message });
    } else {
      // No assistant message exists yet (for example, a stop before the first
      // model call). Surface the reason in a fresh error message.
      this.fail(sessionID, message);
    }
    return { status: "aborted", stopReason: "budget", error: message };
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
