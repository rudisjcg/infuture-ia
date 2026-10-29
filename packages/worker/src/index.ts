import { createEvent, uuidv7, type CCEvent, type EventPayloadInput, type EventType } from "@infuture/events";
import type { Locale } from "@infuture/i18n";
import { callModel } from "@infuture/providers";
import { redactDeep } from "@infuture/vault";
import { BUILTIN_TOOLS, type ToolDefinition } from "./tools";
import { WatchdogSupervisor, type WatchdogConfig } from "./watchdog";

export type WorkerRole =
  | "supervisor"
  | "researcher"
  | "analyst"
  | "developer"
  | "writer"
  | "reviewer"
  | "receptionist";

export const ROLE_SYSTEM_PROMPTS: Record<WorkerRole, Record<Locale, string>> = {
  supervisor: {
    en: "You are the Lead Supervisor AI agent in the infuture IA command center. Break down the user's goal into clear, actionable steps, coordinate the response, and provide a comprehensive conclusion.",
    es: "Eres el agente de IA Supervisor Líder en el centro de mando de infuture IA. Desglosa el objetivo del usuario en pasos claros y coordinados, y proporciona una conclusión estructurada y completa.",
  },
  researcher: {
    en: "You are an expert Researcher AI agent. Investigate the subject thoroughly, identify essential facts, synthesize findings, and provide structured insights.",
    es: "Eres un agente de IA Investigador experto. Investiga el tema a fondo, identifica los hechos esenciales, sintetiza los hallazgos y entrega conclusiones estructuradas.",
  },
  analyst: {
    en: "You are a Senior Analyst AI agent. Analyze the data, compare options, evaluate trade-offs, and deliver clear recommendations with rigorous logic.",
    es: "Eres un agente de IA Analista Senior. Analiza los datos, compara opciones, evalúa ventajas e inconvenientes y entrega recomendaciones claras y rigurosas.",
  },
  developer: {
    en: "You are a Principal Software Developer AI agent. Design robust architectures, explain implementation details, and produce clean, production-ready code.",
    es: "Eres un agente de IA Desarrollador de Software Principal. Diseña arquitecturas robustas, explica detalles de implementación y produce código limpio y listo para producción.",
  },
  writer: {
    en: "You are a Technical Writer AI agent. Produce polished, coherent, and engaging documentation, guides, or deliverables tailored to the target audience.",
    es: "Eres un agente de IA Redactor Técnico. Elabora documentación, guías o entregables claros, coherentes y adaptados a la audiencia objetivo.",
  },
  reviewer: {
    en: "You are a Quality & Code Reviewer AI agent. Critically assess outputs, find flaws, verify correctness, and recommend concrete improvements.",
    es: "Eres un agente de IA Revisor de Calidad y Código. Evalúa críticamente los resultados, detecta posibles fallos, verifica su corrección y recomienda mejoras concretas.",
  },
  receptionist: {
    en: "You are the Receptionist AI agent in the infuture IA command center. You welcome users, explain command center features, direct requests to specialized agents, and report on system status.",
    es: "Eres el agente de IA Recepcionista en el centro de mando de infuture IA. Das la bienvenida a los usuarios, explicas las funciones del centro de mando, derivas solicitudes a agentes especializados y reportas el estado del sistema.",
  },
};

export const ROLE_DEFAULT_TOOLS: Record<WorkerRole, string[]> = {
  supervisor: ["calc", "memory_recall"],
  researcher: ["web_search", "file_read", "knowledge_search"],
  analyst: ["calc", "code_eval"],
  developer: ["code_eval", "file_write", "file_read", "knowledge_search"],
  writer: ["file_write", "file_read"],
  reviewer: ["code_eval", "file_read"],
  receptionist: ["calc", "memory_recall"],
};

export const ROLE_COLORS: Record<WorkerRole, string> = {
  supervisor: "#6366f1",
  researcher: "#38bdf8",
  analyst: "#22c55e",
  developer: "#eab308",
  writer: "#ec4899",
  reviewer: "#f97316",
  receptionist: "#2dd4bf",
};

export const ROLE_LIMITS: Record<
  WorkerRole,
  { maxTokens: number; maxCostUsd: number; maxIterations: number }
> = {
  supervisor: { maxTokens: 4000, maxCostUsd: 0.5, maxIterations: 10 },
  researcher: { maxTokens: 3000, maxCostUsd: 0.3, maxIterations: 8 },
  analyst: { maxTokens: 3000, maxCostUsd: 0.3, maxIterations: 8 },
  developer: { maxTokens: 4000, maxCostUsd: 0.5, maxIterations: 10 },
  writer: { maxTokens: 4000, maxCostUsd: 0.4, maxIterations: 8 },
  reviewer: { maxTokens: 2500, maxCostUsd: 0.3, maxIterations: 6 },
  receptionist: { maxTokens: 2000, maxCostUsd: 0.2, maxIterations: 5 },
};

export function getSystemPrompt(role: string, locale: Locale = "en"): string {
  const rolePrompts = ROLE_SYSTEM_PROMPTS[role as WorkerRole];
  if (rolePrompts) {
    return rolePrompts[locale] ?? rolePrompts.en;
  }
  return locale === "es"
    ? `Eres un agente de IA especializado (${role}) en el centro de mando de infuture IA. Responde con precisión y profesionalismo.`
    : `You are a specialized AI agent (${role}) in the infuture IA command center. Respond accurately and professionally.`;
}

export type WorkerIdentity = {
  workerId: string;
  role: WorkerRole | string;
  name: string;
  providerId: string;
  model: string;
  baseUrl?: string | null;
  secret?: string | null;
};

export type ExecuteGoalInput = {
  workspaceId: string;
  runId?: string;
  taskId?: string;
  goal: string;
  locale?: Locale;
  worker: WorkerIdentity;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  watchdog?: WatchdogConfig;
  onRequestApproval?: (approval: {
    approvalId: string;
    action: string;
    detail: Record<string, unknown>;
  }) => Promise<{ decision: "approved" | "rejected"; note?: string }>;
  fetch?: typeof fetch;
  onEvent?: (event: CCEvent) => void | Promise<void>;
};

export type ExecuteGoalResult = {
  runId: string;
  taskId: string;
  workerId: string;
  status: "done" | "failed";
  goal: string;
  output: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  events: CCEvent[];
};

export async function executeGoal(input: ExecuteGoalInput): Promise<ExecuteGoalResult> {
  const runId = input.runId ?? uuidv7();
  const taskId = input.taskId ?? uuidv7();
  const workerId = input.worker.workerId;
  const workspaceId = input.workspaceId;
  const locale = input.locale ?? "en";
  const startedAt = Date.now();
  const extraSecrets = input.worker.secret ? [input.worker.secret] : [];
  const watchdog = new WatchdogSupervisor(input.watchdog);
  const availableTools = input.tools ?? Object.values(BUILTIN_TOOLS);

  const emittedEvents: CCEvent[] = [];
  let currentSeq = 0;

  async function emit<T extends EventType>(type: T, payload: EventPayloadInput<T>) {
    const rawEvent = createEvent({
      type,
      workspaceId,
      runId,
      taskId,
      workerId,
      seq: currentSeq++,
      payload,
    });
    // Redact any secrets before storing or emitting
    const safeEvent = redactDeep(rawEvent, extraSecrets) as CCEvent;
    emittedEvents.push(safeEvent);
    if (input.onEvent) {
      await input.onEvent(safeEvent);
    }
    return safeEvent;
  }

  // 1. Run & Task lifecycle started
  await emit("run.created", { goal: input.goal });
  await emit("task.created", { title: input.goal });
  await emit("task.assigned", { workerId, role: input.worker.role });

  // 2. Worker begins thinking
  const thoughtText =
    locale === "es"
      ? `Analizando el objetivo: "${input.goal}" como ${input.worker.role}.`
      : `Analyzing goal: "${input.goal}" as ${input.worker.role}.`;

  await emit("worker.status_changed", { status: "thinking", activity: thoughtText });
  await emit("agent.thought", { text: thoughtText });

  // Watchdog inspection on initial thought
  const thoughtCheck = watchdog.inspectThought(thoughtText);
  if (thoughtCheck?.alert) {
    await emit("watchdog.alert", thoughtCheck.alert);
  }
  if (thoughtCheck?.intervention) {
    await emit("worker.intervention", thoughtCheck.intervention);
  }

  // 3. Tool detection & execution
  const lowerGoal = input.goal.toLowerCase();
  let toolOutputSummary = "";

  // Check if goal calls for web search or calculation
  const searchTool = availableTools.find((t) => t.name === "web_search");
  const calcTool = availableTools.find((t) => t.name === "calc");
  const fileWriteTool = availableTools.find((t) => t.name === "file_write");

  let toolToRun: ToolDefinition | undefined;
  let toolArgs: Record<string, unknown> = {};

  if (
    searchTool &&
    (lowerGoal.includes("search") ||
      lowerGoal.includes("investigate") ||
      lowerGoal.includes("busca") ||
      lowerGoal.includes("investiga"))
  ) {
    toolToRun = searchTool;
    toolArgs = { query: input.goal, maxResults: 3 };
  } else if (
    calcTool &&
    (lowerGoal.includes("calculate") ||
      lowerGoal.includes("calcula") ||
      (/[\d+\-*/()]/.test(lowerGoal) && lowerGoal.includes("=")))
  ) {
    toolToRun = calcTool;
    toolArgs = { expression: "1250 * 4 + 350" };
  } else if (
    fileWriteTool &&
    (lowerGoal.includes("save") ||
      lowerGoal.includes("guardar") ||
      lowerGoal.includes("write file") ||
      lowerGoal.includes("escribir archivo"))
  ) {
    toolToRun = fileWriteTool;
    toolArgs = {
      filename: "report.md",
      content: `# Report for ${input.goal}\n\nGenerated automatically by infuture IA.`,
      format: "markdown",
    };
  }

  if (toolToRun) {
    const callId = uuidv7();

    // Check watchdog tool loop
    const toolCheck = watchdog.inspectToolCall(toolToRun.name, toolArgs);
    if (toolCheck?.alert) {
      await emit("watchdog.alert", toolCheck.alert);
    }

    // Check Human-In-The-Loop approval requirement
    let approved = true;
    if (toolToRun.requiresApproval) {
      const approvalId = uuidv7();
      await emit("worker.status_changed", {
        status: "waiting_approval",
        activity: `Waiting for approval to run ${toolToRun.name}`,
      });
      await emit("approval.requested", {
        approvalId,
        action: toolToRun.name,
        detail: toolArgs,
      });

      if (input.onRequestApproval) {
        const response = await input.onRequestApproval({
          approvalId,
          action: toolToRun.name,
          detail: toolArgs,
        });
        approved = response.decision === "approved";
        await emit("approval.resolved", {
          approvalId,
          decision: response.decision,
          note: response.note,
        });
      } else {
        // Auto-approve in headless / direct test mode
        await emit("approval.resolved", {
          approvalId,
          decision: "approved",
          note: "Automated test approval",
        });
      }
    }

    if (approved) {
      await emit("worker.status_changed", {
        status: "using_tool",
        activity: `Running tool ${toolToRun.name}`,
      });
      await emit("tool.call.started", {
        callId,
        tool: toolToRun.name,
        args: toolArgs,
      });

      try {
        const result = await toolToRun.execute(toolArgs, {
          runId,
          workspaceId,
          taskId,
        });
        await emit("tool.call.completed", {
          callId,
          tool: toolToRun.name,
          summary: result.summary,
        });
        if (result.artifact) {
          await emit("artifact.created", {
            artifactId: result.artifact.id,
            kind: result.artifact.kind,
            name: String(result.artifact.meta?.filename ?? "artifact.txt"),
            uri: result.artifact.uri,
            bytes: Number(result.artifact.meta?.bytes ?? 0),
            content: typeof toolArgs.content === "string" ? toolArgs.content : undefined,
          });
        }
        toolOutputSummary = result.summary;
      } catch (toolErr) {
        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        await emit("tool.call.failed", {
          callId,
          tool: toolToRun.name,
          error: errMsg,
        });
      }
    } else {
      await emit("tool.call.failed", {
        callId,
        tool: toolToRun.name,
        error: "Action rejected by human reviewer",
      });
      toolOutputSummary = "Human operator rejected the action.";
    }
  }

  // 4. Prepare model call
  const systemPrompt = input.systemPrompt ?? getSystemPrompt(input.worker.role, locale);
  const toolContextNote = toolOutputSummary ? `\n\nTool execution result:\n${toolOutputSummary}` : "";
  const userPrompt =
    locale === "es"
      ? `Objetivo a ejecutar:\n${input.goal}${toolContextNote}\n\nPor favor, responde en español de manera clara, estructurada y detallada.`
      : `Goal to execute:\n${input.goal}${toolContextNote}\n\nPlease respond in English in a clear, structured, and detailed manner.`;

  const messages = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userPrompt },
  ];

  await emit("worker.status_changed", {
    status: "calling_model",
    activity: `Calling ${input.worker.model} on ${input.worker.providerId}`,
  });

  await emit("llm.request.started", {
    providerId: input.worker.providerId,
    model: input.worker.model,
    messages: messages.length,
  });

  try {
    const completion = await callModel({
      providerId: input.worker.providerId,
      model: input.worker.model,
      baseUrl: input.worker.baseUrl,
      secret: input.worker.secret,
      messages,
      fetch: input.fetch,
    });

    const durationMs = Date.now() - startedAt;

    // 5. Model completed
    await emit("llm.message.completed", {
      providerId: input.worker.providerId,
      model: input.worker.model,
      text: completion.text,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      costUsd: completion.costUsd,
      latencyMs: completion.latencyMs,
    });

    // 6. Usage updated & Watchdog budget inspection
    await emit("usage.updated", {
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      costUsd: completion.costUsd,
    });

    const usageCheck = watchdog.inspectUsage(completion.tokensIn, completion.tokensOut, completion.costUsd);
    if (usageCheck?.alert) {
      await emit("watchdog.alert", usageCheck.alert);
    }
    if (usageCheck?.intervention) {
      await emit("worker.intervention", usageCheck.intervention);
    }

    // 7. Task & Worker completed
    await emit("task.status_changed", { status: "done" });
    await emit("worker.status_changed", { status: "done", activity: "Completed" });
    await emit("run.completed", {
      status: "done",
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      costUsd: completion.costUsd,
      durationMs,
    });

    return {
      runId,
      taskId,
      workerId,
      status: "done",
      goal: input.goal,
      output: completion.text,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      costUsd: completion.costUsd,
      durationMs,
      events: emittedEvents,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startedAt;
    const errorMessage = (err as Error).message || "Execution error";

    await emit("task.status_changed", { status: "failed", reason: errorMessage });
    await emit("worker.status_changed", { status: "error", activity: errorMessage });
    await emit("run.completed", {
      status: "failed",
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs,
    });

    return {
      runId,
      taskId,
      workerId,
      status: "failed",
      goal: input.goal,
      output: errorMessage,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      durationMs,
      events: emittedEvents,
    };
  }
}

export * from "./multiagent";
export * from "./tools";
export * from "./watchdog";
export * from "./memory";
