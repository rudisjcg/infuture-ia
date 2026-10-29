import { createEvent, uuidv7, type CCEvent, type EventPayloadInput, type EventType } from "@infuture/events";
import type { Locale } from "@infuture/i18n";
import { callModel } from "@infuture/providers";
import { redactDeep } from "@infuture/vault";
import { getSystemPrompt, type WorkerIdentity, type WorkerRole } from "./index";

export type MultiAgentInput = {
  workspaceId: string;
  runId?: string;
  goal: string;
  locale?: Locale;
  defaultWorker: WorkerIdentity;
  workerPool?: Partial<Record<WorkerRole, WorkerIdentity>>;
  customPrompts?: Partial<Record<WorkerRole | string, string>>;
  fetch?: typeof fetch;
  onEvent?: (event: CCEvent) => void | Promise<void>;
};

export type SubtaskSummary = {
  taskId: string;
  role: WorkerRole;
  workerId: string;
  title: string;
  output: string;
  status: "done" | "failed";
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
};

export type MultiAgentReview = {
  reviewId: string;
  taskId: string;
  round: number;
  verdict: "approve" | "request_changes" | "reject";
  critique?: string;
};

export type MultiAgentBoardPost = {
  postId: string;
  topic: string;
  kind: "finding" | "idea" | "question" | "decision" | "warning";
  content: string;
};

export type MultiAgentResult = {
  runId: string;
  workspaceId: string;
  goal: string;
  status: "done" | "failed";
  finalOutput: string;
  tasks: SubtaskSummary[];
  reviews: MultiAgentReview[];
  boardPosts: MultiAgentBoardPost[];
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  totalDurationMs: number;
  events: CCEvent[];
};

/**
 * Model Router: selects the most suitable worker configuration for a given role.
 * Uses workerPool if provided, otherwise adapts defaultWorker with role-specific parameters.
 */
export function resolveWorkerForRole(
  role: WorkerRole,
  defaultWorker: WorkerIdentity,
  workerPool?: Partial<Record<WorkerRole, WorkerIdentity>>,
): WorkerIdentity {
  if (workerPool && workerPool[role]) {
    return { ...workerPool[role]!, role };
  }

  // Fallback to defaultWorker with custom workerId and name per role
  return {
    ...defaultWorker,
    workerId: uuidv7(),
    role,
    name: `${defaultWorker.name} (${role})`,
  };
}

export async function executeMultiAgentRun(input: MultiAgentInput): Promise<MultiAgentResult> {
  const runId = input.runId ?? uuidv7();
  const workspaceId = input.workspaceId;
  const locale = input.locale ?? "en";
  const startedAt = Date.now();

  const emittedEvents: CCEvent[] = [];
  const completedTasks: SubtaskSummary[] = [];
  const reviews: MultiAgentReview[] = [];
  const boardPosts: MultiAgentBoardPost[] = [];

  let currentSeq = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalCostUsd = 0;

  function getPrompt(role: WorkerRole): string {
    if (input.customPrompts && input.customPrompts[role]) {
      return input.customPrompts[role]!;
    }
    return getSystemPrompt(role, locale);
  }

  // Track all secrets for envelope redaction
  const secrets: string[] = [];
  if (input.defaultWorker.secret) secrets.push(input.defaultWorker.secret);
  if (input.workerPool) {
    for (const w of Object.values(input.workerPool)) {
      if (w?.secret) secrets.push(w.secret);
    }
  }

  async function emit<T extends EventType>(
    type: T,
    payload: EventPayloadInput<T>,
    meta?: { taskId?: string; workerId?: string },
  ) {
    const rawEvent = createEvent({
      type,
      workspaceId,
      runId,
      taskId: meta?.taskId,
      workerId: meta?.workerId,
      seq: currentSeq++,
      payload,
    });
    const safeEvent = redactDeep(rawEvent, secrets) as CCEvent;
    emittedEvents.push(safeEvent);
    if (input.onEvent) {
      await input.onEvent(safeEvent);
    }
    return safeEvent;
  }

  // 1. Initialize multi-agent run
  await emit("run.created", { goal: input.goal });

  // 2. Supervisor plans the team workflow
  const supervisor = resolveWorkerForRole("supervisor", input.defaultWorker, input.workerPool);
  const planThought =
    locale === "es"
      ? `Supervisor coordinando el equipo: dividiendo "${input.goal}" en investigación, desarrollo y revisión.`
      : `Supervisor coordinating team: splitting "${input.goal}" into research, development, and cross-review.`;

  await emit(
    "worker.status_changed",
    { status: "thinking", activity: planThought },
    { workerId: supervisor.workerId },
  );
  await emit("agent.thought", { text: planThought }, { workerId: supervisor.workerId });

  // -------------------------------------------------------------------------
  // Subtask 1: Research & Discovery (Researcher)
  // -------------------------------------------------------------------------
  const researcher = resolveWorkerForRole("researcher", input.defaultWorker, input.workerPool);
  const task1Id = uuidv7();
  const task1Title =
    locale === "es" ? `Investigación de base: ${input.goal}` : `Foundational research: ${input.goal}`;

  await emit("task.created", { title: task1Title, dependsOn: [] }, { taskId: task1Id });
  await emit("task.assigned", { workerId: researcher.workerId, role: "researcher" }, { taskId: task1Id });

  const rThought =
    locale === "es"
      ? `Investigador analizando antecedentes y requerimientos clave.`
      : `Researcher analyzing context and key requirements.`;
  await emit(
    "worker.status_changed",
    { status: "thinking", activity: rThought },
    { taskId: task1Id, workerId: researcher.workerId },
  );
  await emit("agent.thought", { text: rThought }, { taskId: task1Id, workerId: researcher.workerId });

  await emit(
    "llm.request.started",
    { providerId: researcher.providerId, model: researcher.model, messages: 2 },
    { taskId: task1Id, workerId: researcher.workerId },
  );

  const researchStart = Date.now();
  const researchCompletion = await callModel({
    providerId: researcher.providerId,
    model: researcher.model,
    baseUrl: researcher.baseUrl,
    secret: researcher.secret,
    messages: [
      { role: "system", content: getPrompt("researcher") },
      {
        role: "user",
        content:
          locale === "es"
            ? `Investiga y sintetiza los puntos clave para resolver el siguiente objetivo:\n"${input.goal}"`
            : `Investigate and synthesize the key aspects to solve the following goal:\n"${input.goal}"`,
      },
    ],
    fetch: input.fetch,
  });

  const researchDuration = Date.now() - researchStart;
  totalTokensIn += researchCompletion.tokensIn;
  totalTokensOut += researchCompletion.tokensOut;
  totalCostUsd += researchCompletion.costUsd;

  await emit(
    "llm.message.completed",
    {
      providerId: researcher.providerId,
      model: researcher.model,
      text: researchCompletion.text,
      tokensIn: researchCompletion.tokensIn,
      tokensOut: researchCompletion.tokensOut,
      costUsd: researchCompletion.costUsd,
      latencyMs: researchCompletion.latencyMs,
    },
    { taskId: task1Id, workerId: researcher.workerId },
  );

  await emit("usage.updated", { tokensIn: totalTokensIn, tokensOut: totalTokensOut, costUsd: totalCostUsd });
  await emit("task.status_changed", { status: "done" }, { taskId: task1Id });
  await emit(
    "worker.status_changed",
    { status: "idle", activity: "Research complete" },
    { taskId: task1Id, workerId: researcher.workerId },
  );

  completedTasks.push({
    taskId: task1Id,
    role: "researcher",
    workerId: researcher.workerId,
    title: task1Title,
    output: researchCompletion.text,
    status: "done",
    tokensIn: researchCompletion.tokensIn,
    tokensOut: researchCompletion.tokensOut,
    costUsd: researchCompletion.costUsd,
    durationMs: researchDuration,
  });

  // Post findings to team board
  const post1Id = uuidv7();
  const boardFinding = {
    postId: post1Id,
    topic: "research",
    kind: "finding" as const,
    content: researchCompletion.text.slice(0, 300) + (researchCompletion.text.length > 300 ? "…" : ""),
  };
  boardPosts.push(boardFinding);
  await emit("board.posted", boardFinding, { taskId: task1Id, workerId: researcher.workerId });

  // -------------------------------------------------------------------------
  // Subtask 2: Solution Development (Developer)
  // -------------------------------------------------------------------------
  const developer = resolveWorkerForRole("developer", input.defaultWorker, input.workerPool);
  const task2Id = uuidv7();
  const task2Title =
    locale === "es" ? `Desarrollo de la solución: ${input.goal}` : `Solution development: ${input.goal}`;

  await emit("task.created", { title: task2Title, dependsOn: [task1Id] }, { taskId: task2Id });
  await emit("task.assigned", { workerId: developer.workerId, role: "developer" }, { taskId: task2Id });

  const devThought =
    locale === "es"
      ? `Desarrollador construyendo la propuesta a partir de los hallazgos de investigación.`
      : `Developer constructing solution using research findings.`;
  await emit(
    "worker.status_changed",
    { status: "thinking", activity: devThought },
    { taskId: task2Id, workerId: developer.workerId },
  );
  await emit("agent.thought", { text: devThought }, { taskId: task2Id, workerId: developer.workerId });

  await emit(
    "llm.request.started",
    { providerId: developer.providerId, model: developer.model, messages: 2 },
    { taskId: task2Id, workerId: developer.workerId },
  );

  const devStart = Date.now();
  const devCompletion = await callModel({
    providerId: developer.providerId,
    model: developer.model,
    baseUrl: developer.baseUrl,
    secret: developer.secret,
    messages: [
      { role: "system", content: getPrompt("developer") },
      {
        role: "user",
        content:
          locale === "es"
            ? `Objetivo del usuario:\n"${input.goal}"\n\nHallazgos previos del investigador:\n${researchCompletion.text}\n\nProduce una solución completa, estructurada y robusta.`
            : `User goal:\n"${input.goal}"\n\nPrior research findings:\n${researchCompletion.text}\n\nProduce a complete, structured, and robust solution.`,
      },
    ],
    fetch: input.fetch,
  });

  const devDuration = Date.now() - devStart;
  totalTokensIn += devCompletion.tokensIn;
  totalTokensOut += devCompletion.tokensOut;
  totalCostUsd += devCompletion.costUsd;

  await emit(
    "llm.message.completed",
    {
      providerId: developer.providerId,
      model: developer.model,
      text: devCompletion.text,
      tokensIn: devCompletion.tokensIn,
      tokensOut: devCompletion.tokensOut,
      costUsd: devCompletion.costUsd,
      latencyMs: devCompletion.latencyMs,
    },
    { taskId: task2Id, workerId: developer.workerId },
  );

  await emit("usage.updated", { tokensIn: totalTokensIn, tokensOut: totalTokensOut, costUsd: totalCostUsd });
  await emit("task.status_changed", { status: "done" }, { taskId: task2Id });
  await emit(
    "worker.status_changed",
    { status: "idle", activity: "Development complete" },
    { taskId: task2Id, workerId: developer.workerId },
  );

  completedTasks.push({
    taskId: task2Id,
    role: "developer",
    workerId: developer.workerId,
    title: task2Title,
    output: devCompletion.text,
    status: "done",
    tokensIn: devCompletion.tokensIn,
    tokensOut: devCompletion.tokensOut,
    costUsd: devCompletion.costUsd,
    durationMs: devDuration,
  });

  const devArtifactId = uuidv7();
  await emit(
    "artifact.created",
    {
      artifactId: devArtifactId,
      kind: "markdown",
      name: "solution.md",
      uri: `workspace://${workspaceId}/solution.md`,
      bytes: devCompletion.text.length,
      content: devCompletion.text,
    },
    { taskId: task2Id, workerId: developer.workerId },
  );

  // Post solution to board
  const post2Id = uuidv7();
  const boardSolution = {
    postId: post2Id,
    topic: "solution",
    kind: "decision" as const,
    content: devCompletion.text.slice(0, 300) + (devCompletion.text.length > 300 ? "…" : ""),
  };
  boardPosts.push(boardSolution);
  await emit("board.posted", boardSolution, { taskId: task2Id, workerId: developer.workerId });

  // -------------------------------------------------------------------------
  // Subtask 3: Cross-Agent Supervision & Review (Reviewer)
  // -------------------------------------------------------------------------
  const reviewer = resolveWorkerForRole("reviewer", input.defaultWorker, input.workerPool);
  const task3Id = uuidv7();
  const task3Title =
    locale === "es" ? `Revisión y auditoría: ${input.goal}` : `Quality review & audit: ${input.goal}`;

  await emit("task.created", { title: task3Title, dependsOn: [task2Id] }, { taskId: task3Id });
  await emit("task.assigned", { workerId: reviewer.workerId, role: "reviewer" }, { taskId: task3Id });

  const reviewId = uuidv7();
  await emit(
    "review.requested",
    { reviewId, reviewerWorkerId: reviewer.workerId, round: 1 },
    { taskId: task3Id, workerId: reviewer.workerId },
  );

  const revThought =
    locale === "es"
      ? `Revisor auditando la solución técnica y verificando cumplimiento.`
      : `Reviewer auditing the technical solution and verifying compliance.`;
  await emit(
    "worker.status_changed",
    { status: "reviewing", activity: revThought },
    { taskId: task3Id, workerId: reviewer.workerId },
  );
  await emit("agent.thought", { text: revThought }, { taskId: task3Id, workerId: reviewer.workerId });

  await emit(
    "llm.request.started",
    { providerId: reviewer.providerId, model: reviewer.model, messages: 2 },
    { taskId: task3Id, workerId: reviewer.workerId },
  );

  const revStart = Date.now();
  const revCompletion = await callModel({
    providerId: reviewer.providerId,
    model: reviewer.model,
    baseUrl: reviewer.baseUrl,
    secret: reviewer.secret,
    messages: [
      { role: "system", content: getPrompt("reviewer") },
      {
        role: "user",
        content:
          locale === "es"
            ? `Objetivo inicial:\n"${input.goal}"\n\nSolución entregada por el desarrollador:\n${devCompletion.text}\n\nEvalúa la solución con rigor. Comienza indicando el veredicto en la primera línea como: VEREDICTO: APROBADO (o RECHAZADO). Luego proporciona tu crítica detallada.`
            : `Initial goal:\n"${input.goal}"\n\nDeveloper solution:\n${devCompletion.text}\n\nCritique the solution thoroughly. Begin by stating the verdict on the first line as: VERDICT: APPROVED (or REJECTED). Follow with your detailed critique.`,
      },
    ],
    fetch: input.fetch,
  });

  const revDuration = Date.now() - revStart;
  totalTokensIn += revCompletion.tokensIn;
  totalTokensOut += revCompletion.tokensOut;
  totalCostUsd += revCompletion.costUsd;

  await emit(
    "llm.message.completed",
    {
      providerId: reviewer.providerId,
      model: reviewer.model,
      text: revCompletion.text,
      tokensIn: revCompletion.tokensIn,
      tokensOut: revCompletion.tokensOut,
      costUsd: revCompletion.costUsd,
      latencyMs: revCompletion.latencyMs,
    },
    { taskId: task3Id, workerId: reviewer.workerId },
  );

  const isRejected =
    revCompletion.text.toUpperCase().includes("VERDICT: REJECTED") ||
    revCompletion.text.toUpperCase().includes("VEREDICTO: RECHAZADO");
  const verdict = isRejected ? ("request_changes" as const) : ("approve" as const);

  const reviewRecord: MultiAgentReview = {
    reviewId,
    taskId: task3Id,
    round: 1,
    verdict,
    critique: revCompletion.text,
  };
  reviews.push(reviewRecord);

  await emit(
    "review.completed",
    {
      reviewId,
      round: 1,
      verdict,
      critique: revCompletion.text,
    },
    { taskId: task3Id, workerId: reviewer.workerId },
  );

  await emit("task.status_changed", { status: "done" }, { taskId: task3Id });
  await emit(
    "worker.status_changed",
    { status: "idle", activity: "Review complete" },
    { taskId: task3Id, workerId: reviewer.workerId },
  );

  completedTasks.push({
    taskId: task3Id,
    role: "reviewer",
    workerId: reviewer.workerId,
    title: task3Title,
    output: revCompletion.text,
    status: "done",
    tokensIn: revCompletion.tokensIn,
    tokensOut: revCompletion.tokensOut,
    costUsd: revCompletion.costUsd,
    durationMs: revDuration,
  });

  // Post review notice to board
  const post3Id = uuidv7();
  const boardReview = {
    postId: post3Id,
    topic: "review",
    kind: "decision" as const,
    content: `Review verdict: ${verdict.toUpperCase()}.\n${revCompletion.text.slice(0, 200)}…`,
  };
  boardPosts.push(boardReview);
  await emit("board.posted", boardReview, { taskId: task3Id, workerId: reviewer.workerId });

  // -------------------------------------------------------------------------
  // 4. Run Completed
  // -------------------------------------------------------------------------
  const totalDurationMs = Date.now() - startedAt;

  await emit("usage.updated", { tokensIn: totalTokensIn, tokensOut: totalTokensOut, costUsd: totalCostUsd });
  await emit("run.completed", {
    status: "done",
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    costUsd: totalCostUsd,
    durationMs: totalDurationMs,
  });

  // Consolidate final output: developer deliverable + reviewer signoff
  const finalOutput = `${devCompletion.text}\n\n---\n### ${locale === "es" ? "Dictamen del Revisor" : "Reviewer Audit"}\n${revCompletion.text}`;

  const deliverableId = uuidv7();
  await emit(
    "artifact.created",
    {
      artifactId: deliverableId,
      kind: "markdown",
      name: "final-deliverable.md",
      uri: `workspace://${workspaceId}/final-deliverable.md`,
      bytes: finalOutput.length,
      content: finalOutput,
    },
    { workerId: supervisor.workerId },
  );

  return {
    runId,
    workspaceId,
    goal: input.goal,
    status: "done",
    finalOutput,
    tasks: completedTasks,
    reviews,
    boardPosts,
    totalTokensIn,
    totalTokensOut,
    totalCostUsd,
    totalDurationMs,
    events: emittedEvents,
  };
}
