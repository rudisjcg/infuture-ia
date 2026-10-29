import { describe, expect, it, vi } from "vitest";
import { executeGoal, executeMultiAgentRun, getSystemPrompt } from "./index";

const mockFetchSuccess = (text = "Task executed successfully") =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 30, completion_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

describe("getSystemPrompt", () => {
  it("returns Spanish prompts when requested", () => {
    const prompt = getSystemPrompt("researcher", "es");
    expect(prompt).toContain("Investigador");
  });

  it("returns English prompt by default", () => {
    const prompt = getSystemPrompt("developer", "en");
    expect(prompt).toContain("Software Developer");
  });
});

describe("executeGoal", () => {
  it("emits the full lifecycle of events and returns output", async () => {
    const emitted: string[] = [];
    const fetch = mockFetchSuccess("Analysis completed.");

    const result = await executeGoal({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Analyze quantum computing trends",
      locale: "en",
      worker: {
        workerId: "00000000-0000-4000-8000-000000000002",
        role: "researcher",
        name: "Research Worker",
        providerId: "openai",
        model: "gpt-4o",
        secret: "sk-super-secret-key-123456",
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onEvent: (event) => {
        emitted.push(event.type);
      },
    });

    expect(result.status).toBe("done");
    expect(result.output).toBe("Analysis completed.");
    expect(result.tokensIn).toBe(30);
    expect(result.tokensOut).toBe(15);
    expect(result.costUsd).toBeGreaterThan(0);

    // Verify event sequence
    expect(emitted).toEqual([
      "run.created",
      "task.created",
      "task.assigned",
      "worker.status_changed",
      "agent.thought",
      "worker.status_changed",
      "llm.request.started",
      "llm.message.completed",
      "usage.updated",
      "task.status_changed",
      "worker.status_changed",
      "run.completed",
    ]);

    // Check seq ordering
    for (let i = 0; i < result.events.length; i++) {
      expect(result.events[i]?.seq).toBe(i);
    }

    // Verify secret redaction
    const serializedEvents = JSON.stringify(result.events);
    expect(serializedEvents).not.toContain("sk-super-secret-key-123456");
  });

  it("handles model failure gracefully and emits failure events", async () => {
    const fetch = vi.fn(async () => new Response("Rate limit exceeded", { status: 429 }));
    const emitted: string[] = [];

    const result = await executeGoal({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Fail test",
      worker: {
        workerId: "00000000-0000-4000-8000-000000000002",
        role: "analyst",
        name: "Analyst Worker",
        providerId: "openai",
        model: "gpt-4o",
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onEvent: (event) => {
        emitted.push(event.type);
      },
    });

    expect(result.status).toBe("failed");
    expect(emitted).toContain("task.status_changed");
    expect(emitted).toContain("run.completed");
    const lastEvent = result.events[result.events.length - 1];
    expect(lastEvent?.type).toBe("run.completed");
    expect((lastEvent?.payload as { status: string }).status).toBe("failed");
  });

  it("coordinates multi-agent execution with research, development, and cross-review", async () => {
    let callIndex = 0;
    const fetch = vi.fn(async () => {
      callIndex++;
      const content =
        callIndex === 1
          ? "Research: Microservices provide isolation and scalability."
          : callIndex === 2
            ? "Development: Implemented auth service and gateway in TypeScript."
            : "VERDICT: APPROVED\nReview: Architecture is sound and follows security best practices.";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
          usage: { prompt_tokens: 25, completion_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const emitted: string[] = [];
    const result = await executeMultiAgentRun({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Build secure authentication architecture",
      defaultWorker: {
        workerId: "00000000-0000-4000-8000-000000000010",
        role: "supervisor",
        name: "General Worker",
        providerId: "openai",
        model: "gpt-4o",
        secret: "sk-multiagent-secret-key-999",
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onEvent: (event) => {
        emitted.push(event.type);
      },
    });

    expect(result.status).toBe("done");
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.map((t) => t.role)).toEqual(["researcher", "developer", "reviewer"]);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]?.verdict).toBe("approve");
    expect(result.boardPosts).toHaveLength(3);

    // Verify key multi-agent events emitted
    expect(emitted).toContain("board.posted");
    expect(emitted).toContain("review.requested");
    expect(emitted).toContain("review.completed");
    expect(emitted).toContain("run.completed");

    // Total tokens aggregated across all agents
    expect(result.totalTokensIn).toBe(75); // 25 * 3
    expect(result.totalTokensOut).toBe(45); // 15 * 3
    expect(result.totalCostUsd).toBeGreaterThan(0);

    // Verify secret redaction across all emitted events
    expect(JSON.stringify(result.events)).not.toContain("sk-multiagent-secret-key-999");
  });

  it("executes tools and emits tool lifecycle events", async () => {
    const emitted: string[] = [];
    const fetch = mockFetchSuccess("Search completed with findings.");

    const result = await executeGoal({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Search and investigate zero trust architecture",
      worker: {
        workerId: "00000000-0000-4000-8000-000000000002",
        role: "researcher",
        name: "Research Worker",
        providerId: "openai",
        model: "gpt-4o",
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onEvent: (event) => {
        emitted.push(event.type);
      },
    });

    expect(result.status).toBe("done");
    expect(emitted).toContain("tool.call.started");
    expect(emitted).toContain("tool.call.completed");
  });

  it("triggers human-in-the-loop approval when sensitive tool is called", async () => {
    const emitted: string[] = [];
    const fetch = mockFetchSuccess("File write processed.");

    let requestedAction = "";
    const result = await executeGoal({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Write file and save deployment report",
      worker: {
        workerId: "00000000-0000-4000-8000-000000000002",
        role: "developer",
        name: "Dev Worker",
        providerId: "openai",
        model: "gpt-4o",
      },
      onRequestApproval: async (req) => {
        requestedAction = req.action;
        return { decision: "approved", note: "Approved by lead architect" };
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onEvent: (event) => {
        emitted.push(event.type);
      },
    });

    expect(result.status).toBe("done");
    expect(requestedAction).toBe("file_write");
    expect(emitted).toContain("approval.requested");
    expect(emitted).toContain("approval.resolved");
    expect(emitted).toContain("tool.call.started");
    expect(emitted).toContain("tool.call.completed");
  });

  it("emits watchdog alert when budget threshold is exceeded", async () => {
    const emitted: string[] = [];
    const fetch = mockFetchSuccess("Finished.");

    await executeGoal({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      goal: "Test watchdog budget limit",
      watchdog: {
        maxCostUsd: 0.00001, // ultra low threshold to trigger watchdog
      },
      worker: {
        workerId: "00000000-0000-4000-8000-000000000002",
        role: "supervisor",
        name: "Supervisor Worker",
        providerId: "openai",
        model: "gpt-4o",
      },
      fetch: fetch as unknown as typeof globalThis.fetch,
      onEvent: (event) => {
        emitted.push(event.type);
      },
    });

    expect(emitted).toContain("watchdog.alert");
    expect(emitted).toContain("worker.intervention");
  });

  it("tests and executes tools directly in sandbox testbed", async () => {
    const {
      testToolExecution,
      createCustomSandboxTool,
      registerTool,
      unregisterTool,
      createMcpToolDefinition,
    } = await import("./tools");

    // 1. Test builtin calc tool
    const calcRes = await testToolExecution(
      "calc",
      { expression: "25 * 4 + 10" },
      { workspaceId: "00000000-0000-4000-8000-000000000001" },
    );
    expect(calcRes.ok).toBe(true);
    expect(calcRes.summary).toContain("110");

    // 2. Register and test a custom sandbox tool
    const customTool = createCustomSandboxTool({
      name: "currency_convert",
      description: "Convert USD to EUR",
      parameters: { amount: { type: "number", description: "USD amount", required: true } },
      code: "return { eur: args.amount * 0.92, rate: 0.92 };",
    });
    registerTool(customTool);

    const customRes = await testToolExecution(
      "currency_convert",
      { amount: 100 },
      { workspaceId: "00000000-0000-4000-8000-000000000001" },
    );
    expect(customRes.ok).toBe(true);
    expect((customRes.data as { eur: number }).eur).toBe(92);

    // 3. Test MCP tool definition
    const mcpTool = createMcpToolDefinition({
      serverName: "sqlite-mcp",
      toolName: "sqlite_query",
      description: "Run query on db",
      parameters: { sql: { type: "string", description: "SQL query" } },
    });
    registerTool(mcpTool);

    const mcpRes = await testToolExecution(
      "sqlite_query",
      { sql: "SELECT count(*) FROM users" },
      { workspaceId: "00000000-0000-4000-8000-000000000001" },
    );
    // MCP client is not implemented: execution must fail loudly instead of faking success.
    expect(mcpRes.ok).toBe(false);
    expect(mcpRes.summary).toContain("not connected");
    expect(customTool.requiresApproval).toBe(true);

    // Cleanup
    unregisterTool("currency_convert");
    unregisterTool("sqlite_query");
  });

  it("sandboxes code_eval and custom tools away from host globals", async () => {
    const { testToolExecution, getTool, createCustomSandboxTool } = await import("./tools");
    const ws = { workspaceId: "00000000-0000-4000-8000-000000000001" };

    expect(getTool("code_eval")?.requiresApproval).toBe(true);
    const ok = await testToolExecution("code_eval", { code: "[1, 2, 3].map((n) => n * 2)" }, ws);
    expect(ok.data).toEqual({ result: [2, 4, 6] });

    const escape = await testToolExecution("code_eval", { code: "typeof process + typeof require" }, ws);
    expect((escape.data as { result: string }).result).toBe("undefinedundefined");

    const ctorEscape = await testToolExecution(
      "code_eval",
      { code: "this.constructor.constructor('return process')()" },
      ws,
    );
    expect((ctorEscape.data as { error?: string }).error).toBeDefined();

    const loop = await testToolExecution("code_eval", { code: "(() => { while (true) {} })()" }, ws);
    expect(loop.summary).toMatch(/timed out/i);

    const evil = createCustomSandboxTool({
      name: "evil",
      description: "tries to reach process",
      parameters: {},
      code: "return { env: typeof process };",
      requiresApproval: false,
    });
    expect(evil.requiresApproval).toBe(true);
    const res = await evil.execute({}, { runId: "r", workspaceId: ws.workspaceId });
    expect(res.data).toEqual({ env: "undefined" });
  });

  it("evaluates arithmetic without eval", async () => {
    const { evaluateArithmetic, testToolExecution } = await import("./tools");
    expect(evaluateArithmetic("12 * 450 + (100 / 4)")).toBe(5425);
    expect(evaluateArithmetic("-2 ** 2 + 10 % 3")).toBe(-3);
    expect(evaluateArithmetic("(1.5 + .5) * -3")).toBe(-6);
    expect(() => evaluateArithmetic("2 + alert(1)")).toThrow();
    expect(() => evaluateArithmetic("(1 + 2")).toThrow();
    const res = await testToolExecution("calc", { expression: "constructor" }, { workspaceId: "w" });
    expect(res.summary).toContain("Failed");
  });

  it("chunks documents, performs semantic RAG search and recalls agent memories", async () => {
    const {
      chunkText,
      extractKeywords,
      searchKnowledgeDocuments,
      searchWorkspaceMemories,
      testToolExecution,
    } = await import("./index");

    const sampleDoc = `
# Autonomous Multi-Agent Systems
Multi-agent systems coordinate independent worker personas across shared task boards.
Supervisor breaks goals down into discrete steps.

# Zero Trust Security
Zero Trust Architecture requires explicit authentication for every request and envelope encryption.
Never store plaintext API keys in memory or database logs.
    `.trim();

    const keywords = extractKeywords("What are the zero trust security requirements?");
    expect(keywords).toContain("zero");
    expect(keywords).toContain("trust");
    expect(keywords).toContain("security");
    expect(keywords).not.toContain("what"); // Stopword filtered

    const chunks = chunkText(sampleDoc, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);

    const doc = {
      id: "doc-test-1",
      workspaceId: "ws-test",
      title: "Security & Multi-Agent Spec",
      category: "specifications",
      content: sampleDoc,
      chunks,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const results = searchKnowledgeDocuments([doc], "envelope encryption plaintext keys");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.text).toContain("Zero Trust");
    expect(results[0]?.score).toBeGreaterThan(0.3);

    // Test memory search
    const memories = [
      {
        id: "mem-1",
        workspaceId: "ws-test",
        role: "developer",
        content: "Always use AES-256-GCM envelope encryption for stored secrets",
        tags: ["security", "encryption"],
        importance: 5,
        createdAt: new Date(),
      },
      {
        id: "mem-2",
        workspaceId: "ws-test",
        role: "writer",
        content: "Use dark theme palette matching cybernetic aesthetics",
        tags: ["ui", "design"],
        importance: 2,
        createdAt: new Date(),
      },
    ];

    const recalled = searchWorkspaceMemories(memories, "envelope encryption");
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0]?.id).toBe("mem-1");
    expect(recalled[0]?.score).toBeGreaterThan(0.5);

    // Test tools execution
    const testWs = { workspaceId: "ws-test-sandbox" };
    const storeRes = await testToolExecution(
      "memory_store",
      {
        content: "Always write unit tests for new agent tools",
        tags: "testing,quality",
        importance: 4,
      },
      testWs,
    );
    expect(storeRes.ok).toBe(true);

    const recallRes = await testToolExecution("memory_recall", { query: "unit tests quality" }, testWs);
    expect(recallRes.ok).toBe(true);
    expect(recallRes.summary).toContain("Recalled");

    const ragRes = await testToolExecution(
      "knowledge_search",
      { query: "zero trust envelope encryption" },
      testWs,
    );
    expect(ragRes.ok).toBe(true);
    expect(ragRes.summary).toContain("Found");
  });
});
