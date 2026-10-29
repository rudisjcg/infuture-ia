import { createContext, Script } from "node:vm";
import { uuidv7 } from "@infuture/events";
import {
  getWorkspaceMemoriesMap,
  getWorkspaceKnowledgeMap,
  searchWorkspaceMemories,
  searchKnowledgeDocuments,
  type MemoryItem,
} from "./memory";

export type ToolParameter = {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
  enum?: string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  requiresApproval?: boolean;
  execute: (
    args: Record<string, unknown>,
    context: { runId: string; workspaceId: string; taskId?: string },
  ) => Promise<ToolExecutionResult>;
};

export type ToolExecutionResult = {
  summary: string;
  data?: unknown;
  artifact?: {
    id: string;
    kind: string;
    uri: string;
    meta?: Record<string, unknown>;
  };
};

/**
 * In-memory simulated workspace artifacts storage for file_read and file_write tools.
 */
const workspaceFileStore = new Map<string, Map<string, string>>();

export function getWorkspaceFileStore(workspaceId: string): Map<string, string> {
  let store = workspaceFileStore.get(workspaceId);
  if (!store) {
    store = new Map<string, string>();
    workspaceFileStore.set(workspaceId, store);
  }
  return store;
}

/**
 * Built-in standard tool catalog for specialized agents.
 */
export const BUILTIN_TOOLS: Record<string, ToolDefinition> = {
  web_search: {
    name: "web_search",
    description: "Search for authoritative knowledge, facts, documentation, and technical references.",
    parameters: {
      query: { type: "string", description: "Search query or question", required: true },
      maxResults: { type: "number", description: "Maximum results to retrieve (1-5)", required: false },
    },
    requiresApproval: false,
    execute: async (args) => {
      const query = String(args.query ?? "").toLowerCase();
      const results: Array<{ title: string; snippet: string; url: string }> = [];

      if (query.includes("security") || query.includes("zero trust")) {
        results.push({
          title: "NIST SP 800-207: Zero Trust Architecture",
          snippet: "Zero trust security model assumes breach and verifies each request explicitly.",
          url: "https://csrc.nist.gov/publications/detail/sp/800-207/final",
        });
        results.push({
          title: "OWASP Top 10 API Security Risks",
          snippet:
            "Identifies broken object level authorization and secret exposure as critical vulnerabilities.",
          url: "https://owasp.org/www-project-api-security/",
        });
      } else if (query.includes("multi-agent") || query.includes("architecture")) {
        results.push({
          title: "Multi-Agent System Design Patterns",
          snippet:
            "Supervised decomposition, peer review, and shared board architectures yield highest reliability.",
          url: "https://arxiv.org/abs/2308.08155",
        });
      } else {
        results.push({
          title: `Information reference for "${args.query}"`,
          snippet: `Synthesized reference and verified domain facts relating to ${args.query}.`,
          url: `https://infuture.internal/kb/${encodeURIComponent(String(args.query))}`,
        });
      }

      return {
        summary: `Found ${results.length} relevant reference(s) for "${args.query}".`,
        data: { query: args.query, results },
      };
    },
  },

  code_eval: {
    name: "code_eval",
    description: "Safely execute a JavaScript calculation or transformation expression in a sandbox.",
    parameters: {
      code: { type: "string", description: "JavaScript expression to evaluate", required: true },
    },
    // LLM-written code is untrusted: it runs in an isolated node:vm context and needs human approval.
    requiresApproval: true,
    execute: async (args) => {
      const code = String(args.code ?? "");
      try {
        const result = runInSandbox(`(${code})`, {});
        return {
          summary: `Evaluated successfully. Result: ${JSON.stringify(result)}`,
          data: { result },
        };
      } catch (err) {
        return {
          summary: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
          data: { error: String(err) },
        };
      }
    },
  },

  file_write: {
    name: "file_write",
    description: "Write an artifact file to the workspace. Requires human approval for sensitive changes.",
    parameters: {
      filename: { type: "string", description: "Relative file path or artifact name", required: true },
      content: { type: "string", description: "Full file content to save", required: true },
      format: {
        type: "string",
        description: "File format",
        enum: ["markdown", "json", "text"],
        required: false,
      },
    },
    requiresApproval: true, // Sensitive operation triggers Human-In-The-Loop approval!
    execute: async (args, context) => {
      const filename = String(args.filename ?? "artifact.txt");
      const content = String(args.content ?? "");
      const store = getWorkspaceFileStore(context.workspaceId);
      store.set(filename, content);

      const artifactId = uuidv7();
      return {
        summary: `File "${filename}" successfully written (${content.length} characters).`,
        data: { filename, bytes: content.length },
        artifact: {
          id: artifactId,
          kind: String(args.format ?? "file"),
          uri: `workspace://${context.workspaceId}/${filename}`,
          meta: { filename, bytes: content.length },
        },
      };
    },
  },

  file_read: {
    name: "file_read",
    description: "Read an existing artifact file from the workspace.",
    parameters: {
      filename: { type: "string", description: "Relative file path to read", required: true },
    },
    requiresApproval: false,
    execute: async (args, context) => {
      const filename = String(args.filename ?? "");
      const store = getWorkspaceFileStore(context.workspaceId);
      const content = store.get(filename);
      if (content === undefined) {
        return {
          summary: `File not found: "${filename}".`,
          data: { error: "not_found", filename },
        };
      }
      return {
        summary: `Read "${filename}" (${content.length} characters).`,
        data: { filename, content },
      };
    },
  },

  calc: {
    name: "calc",
    description: "Perform accurate mathematical or statistical calculations.",
    parameters: {
      expression: {
        type: "string",
        description: "Math expression e.g. '12 * 450 + (100 / 4)'",
        required: true,
      },
    },
    requiresApproval: false,
    execute: async (args) => {
      const expr = String(args.expression ?? "0");
      try {
        const val = evaluateArithmetic(expr);
        return {
          summary: `${expr} = ${val}`,
          data: { expression: expr, result: val },
        };
      } catch (err) {
        return {
          summary: `Failed to evaluate math expression: ${String(err)}`,
          data: { error: String(err) },
        };
      }
    },
  },

  memory_recall: {
    name: "memory_recall",
    description: "Search the workspace agent memory bank for past insights, guidelines, and decisions.",
    parameters: {
      query: { type: "string", description: "Search query or concept to recall", required: true },
      role: { type: "string", description: "Filter by agent role or 'all'", required: false },
      limit: { type: "number", description: "Maximum memories to return (1-10)", required: false },
    },
    requiresApproval: false,
    execute: async (args, context) => {
      const q = String(args.query ?? "");
      const role = args.role ? String(args.role) : undefined;
      const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 10) : 5;
      const memMap = getWorkspaceMemoriesMap(context.workspaceId);
      const list = Array.from(memMap.values());
      const matches = searchWorkspaceMemories(list, q, { role, limit });
      return {
        summary: `Recalled ${matches.length} relevant memory item(s) for "${q}".`,
        data: { query: q, count: matches.length, memories: matches },
      };
    },
  },

  memory_store: {
    name: "memory_store",
    description: "Save a key learning, decision, or fact into the long-term agent memory bank.",
    parameters: {
      content: { type: "string", description: "The insight, fact, or decision to remember", required: true },
      tags: { type: "string", description: "Comma-separated tags for categorization", required: false },
      importance: {
        type: "number",
        description: "Importance score from 1 (low) to 5 (critical)",
        required: false,
      },
      role: { type: "string", description: "Agent role context or 'all'", required: false },
    },
    requiresApproval: false,
    execute: async (args, context) => {
      const content = String(args.content ?? "");
      const tagsRaw =
        typeof args.tags === "string"
          ? args.tags
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
      const importance = typeof args.importance === "number" ? Math.min(Math.max(args.importance, 1), 5) : 3;
      const role = args.role ? String(args.role) : "all";
      const id = `mem-${uuidv7().slice(0, 8)}`;
      const item: MemoryItem = {
        id,
        workspaceId: context.workspaceId,
        role,
        content,
        tags: tagsRaw,
        importance,
        runId: context.runId,
        createdAt: new Date(),
      };
      const memMap = getWorkspaceMemoriesMap(context.workspaceId);
      memMap.set(id, item);
      return {
        summary: `Saved memory item "${id}" (importance: ${importance}).`,
        data: item,
      };
    },
  },

  knowledge_search: {
    name: "knowledge_search",
    description: "Perform semantic retrieval (RAG) over ingested workspace documentation and specifications.",
    parameters: {
      query: { type: "string", description: "Semantic search query or question", required: true },
      category: { type: "string", description: "Document category filter (optional)", required: false },
      limit: { type: "number", description: "Maximum chunks to retrieve (1-10)", required: false },
    },
    requiresApproval: false,
    execute: async (args, context) => {
      const q = String(args.query ?? "");
      const category = args.category ? String(args.category) : undefined;
      const limit = typeof args.limit === "number" ? Math.min(Math.max(args.limit, 1), 10) : 4;
      const docMap = getWorkspaceKnowledgeMap(context.workspaceId);
      const docs = Array.from(docMap.values());
      const matches = searchKnowledgeDocuments(docs, q, { category, limit });
      return {
        summary: `Found ${matches.length} knowledge chunk(s) matching "${q}".`,
        data: { query: q, count: matches.length, chunks: matches },
      };
    },
  },
};

/* ----------------------------- Dynamic Tools & MCP Registry ----------------------------- */

/**
 * Known limitation: this registry is process-global (not scoped per workspace) and in-memory,
 * so custom/MCP tools are visible to every workspace and are lost on restart.
 */
const dynamicTools = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  dynamicTools.set(tool.name, tool);
}

export function unregisterTool(name: string): boolean {
  return dynamicTools.delete(name);
}

export function getTool(name: string): ToolDefinition | undefined {
  return dynamicTools.get(name) ?? BUILTIN_TOOLS[name];
}

export function getAllTools(): ToolDefinition[] {
  const merged = new Map<string, ToolDefinition>();
  for (const [name, tool] of Object.entries(BUILTIN_TOOLS)) {
    merged.set(name, tool);
  }
  for (const [name, tool] of dynamicTools.entries()) {
    merged.set(name, tool);
  }
  return Array.from(merged.values());
}

export async function testToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  context: { runId?: string; workspaceId: string },
): Promise<{ ok: boolean; summary: string; data?: unknown; error?: string; durationMs: number }> {
  const tool = getTool(toolName);
  if (!tool) {
    return {
      ok: false,
      summary: `Tool "${toolName}" not found.`,
      error: "not_found",
      durationMs: 0,
    };
  }

  const start = Date.now();
  try {
    const result = await tool.execute(args, {
      runId: context.runId ?? "test-run",
      workspaceId: context.workspaceId,
    });
    const durationMs = Date.now() - start;
    return {
      ok: true,
      summary: result.summary,
      data: result.data,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      summary: `Execution failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
      durationMs,
    };
  }
}

export function createCustomSandboxTool(input: {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  code: string;
  requiresApproval?: boolean;
}): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    parameters: input.parameters,
    // Custom code is user-supplied: always require approval regardless of the requested flag.
    requiresApproval: true,
    execute: async (args) => {
      try {
        // Wrapped in a function so custom code can use `return`; `args` is copied in as plain JSON.
        const result = runInSandbox(`(function (args) { "use strict"; ${input.code}\n})(__args)`, {
          __args: JSON.parse(JSON.stringify(args ?? {})),
        });
        const data = typeof result === "object" && result !== null ? result : { result };
        const summary = `Executed custom tool "${input.name}". Result: ${JSON.stringify(result).slice(0, 100)}`;
        return { summary, data };
      } catch (err) {
        return {
          summary: `Custom tool "${input.name}" error: ${err instanceof Error ? err.message : String(err)}`,
          data: { error: String(err) },
        };
      }
    },
  };
}

export function createMcpToolDefinition(input: {
  serverName: string;
  toolName: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  requiresApproval?: boolean;
  execute?: (args: Record<string, unknown>) => Promise<{ summary: string; data?: unknown }>;
}): ToolDefinition {
  return {
    name: input.toolName,
    description: `[MCP: ${input.serverName}] ${input.description}`,
    parameters: input.parameters,
    requiresApproval: input.requiresApproval ?? false,
    execute: async (args) => {
      if (input.execute) {
        return input.execute(args);
      }
      // No MCP client transport is wired up yet: report it instead of faking success.
      throw new Error(
        `MCP server "${input.serverName}" is not connected: tool "${input.toolName}" cannot be executed (MCP client not implemented).`,
      );
    },
  };
}

/* ----------------------------- Sandbox & Safe Arithmetic ----------------------------- */

export const SANDBOX_TIMEOUT_MS = 1000;

/**
 * Runs code in a fresh node:vm context that only sees the given plain-data globals
 * (no process, require, fetch or host objects) and is killed after SANDBOX_TIMEOUT_MS.
 * node:vm is an isolation layer, not a hardened security boundary, so tools using it also require approval.
 */
export function runInSandbox(code: string, globals: Record<string, unknown>): unknown {
  const context = createContext(Object.assign(Object.create(null), globals), {
    codeGeneration: { strings: false, wasm: false },
  });
  const result: unknown = new Script(code).runInContext(context, { timeout: SANDBOX_TIMEOUT_MS });
  // Round-trip through JSON so no object from the sandbox realm leaks back to the host.
  if (result === undefined) return undefined;
  const json = JSON.stringify(result);
  return json === undefined ? undefined : JSON.parse(json);
}

/** Evaluates numbers with + - * / % ** and parentheses without eval/Function. */
export function evaluateArithmetic(input: string): number {
  const tokens = input.match(/\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+|\*\*|[-+*/%()]|\S/gi) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string | undefined => tokens[pos++];

  const parsePrimary = (): number => {
    const token = next();
    if (token === undefined) throw new Error("Unexpected end of expression");
    if (token === "(") {
      const value = parseExpr();
      if (next() !== ")") throw new Error("Missing closing parenthesis");
      return value;
    }
    if (!/^\.?\d/.test(token)) throw new Error(`Unexpected token "${token}"`);
    return Number(token);
  };
  const parseUnary = (): number => {
    if (peek() === "-") {
      next();
      return -parseUnary();
    }
    if (peek() === "+") {
      next();
      return parseUnary();
    }
    const base = parsePrimary();
    if (peek() === "**") {
      next();
      return base ** parseUnary();
    }
    return base;
  };
  const parseTerm = (): number => {
    let value = parseUnary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = next();
      const rhs = parseUnary();
      value = op === "*" ? value * rhs : op === "/" ? value / rhs : value % rhs;
    }
    return value;
  };
  function parseExpr(): number {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = next();
      const rhs = parseTerm();
      value = op === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new Error(`Unexpected token "${tokens[pos]}"`);
  return result;
}
