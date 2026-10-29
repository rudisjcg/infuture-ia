import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCurrency, formatNumber } from "@infuture/i18n";
import type { CCEvent } from "@infuture/events";
import { useLocale } from "../i18n";

type TerminalLineKind =
  | "input"
  | "output"
  | "info"
  | "warn"
  | "error"
  | "success"
  | "thought"
  | "event"
  | "board"
  | "review";

type TerminalLine = {
  id: string;
  kind: TerminalLineKind;
  text: string;
  timestamp?: string;
  meta?: Record<string, unknown>;
};

const SUGGESTED_COMMANDS = [
  "help",
  "status",
  "connections",
  "workers",
  "approvals",
  "team Design a resilient multi-tenant AI architecture",
  "run Search and investigate zero trust architecture",
  "ask How does the multi-agent cross-review work?",
  "clear",
];

const ROLES_CATALOG = [
  { role: "supervisor", color: "var(--accent)" },
  { role: "researcher", color: "var(--sky)" },
  { role: "analyst", color: "var(--ok)" },
  { role: "developer", color: "var(--warn)" },
  { role: "writer", color: "var(--pink)" },
  { role: "reviewer", color: "var(--coral)" },
  { role: "receptionist", color: "#2dd4bf" },
] as const;

export function Terminal() {
  const { t, i18n } = useTranslation();
  const locale = useLocale();

  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [inputVal, setInputVal] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);

  const terminalBodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const getTimestamp = () => {
    const d = new Date();
    return d.toTimeString().split(" ")[0] ?? "";
  };

  const addLine = useCallback((kind: TerminalLineKind, text: string, meta?: Record<string, unknown>) => {
    const line: TerminalLine = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      kind,
      text,
      timestamp: new Date().toTimeString().split(" ")[0],
      meta,
    };
    setLines((prev) => [...prev, line]);
  }, []);

  // Initialize terminal welcome message
  useEffect(() => {
    setLines([
      {
        id: "welcome-1",
        kind: "info",
        text: t("terminal.welcome"),
        timestamp: getTimestamp(),
      },
    ]);
  }, [t]);

  // Auto-scroll to bottom on new lines
  useEffect(() => {
    if (terminalBodyRef.current) {
      terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight;
    }
  }, [lines]);

  // Focus input on click anywhere inside terminal body
  const handleContainerClick = () => {
    inputRef.current?.focus();
  };

  const handleEventMessage = useCallback(
    (ev: CCEvent) => {
      const payload = ev.payload as Record<string, unknown> | undefined;

      switch (ev.type) {
        case "run.created":
          addLine("info", `[RUN CREATED] id=${ev.runId ?? ""} goal="${String(payload?.goal ?? "")}"`);
          break;

        case "worker.status_changed":
          addLine(
            "event",
            `[WORKER STATUS] ${String(payload?.role ?? "worker")} -> ${String(payload?.to ?? "")} (${String(payload?.reason ?? "")})`,
          );
          break;

        case "agent.thought":
          addLine(
            "thought",
            `[THOUGHT - ${String(payload?.role ?? "agent")}] ${String(payload?.thought ?? "")}`,
          );
          break;

        case "llm.request.started":
          addLine(
            "event",
            `[LLM CALL] provider=${String(payload?.providerId ?? "")} model=${String(payload?.model ?? "")}`,
          );
          break;

        case "llm.message.completed":
          addLine(
            "success",
            `[LLM COMPLETED] Output generated (${String(payload?.text ?? "").length} chars)`,
          );
          break;

        case "board.posted":
          addLine(
            "board",
            `[TEAM BOARD - ${String(payload?.kind ?? "").toUpperCase()}] ${String(payload?.topic ?? "")}: "${String(payload?.content ?? "")}"`,
          );
          break;

        case "review.requested":
          addLine(
            "review",
            `[REVIEW REQUESTED] Task ${String(payload?.taskId ?? "")} sent to ${String(payload?.reviewerWorkerId ?? "reviewer")}`,
          );
          break;

        case "review.completed":
          addLine(
            "review",
            `[REVIEW VERDICT: ${String(payload?.verdict ?? "").toUpperCase()}] ${String(payload?.critique ?? "Approved")}`,
          );
          break;

        case "tool.call.started":
          addLine(
            "event",
            `[TOOL CALL] tool=${String(payload?.tool ?? "")} args=${JSON.stringify(payload?.args ?? {})}`,
          );
          break;

        case "tool.call.completed":
          addLine("success", `[TOOL COMPLETED] ${String(payload?.summary ?? "")}`);
          break;

        case "tool.call.failed":
          addLine(
            "error",
            `[TOOL FAILED] tool=${String(payload?.tool ?? "")} error=${String(payload?.error ?? "")}`,
          );
          break;

        case "approval.requested":
          addLine(
            "warn",
            `[APPROVAL REQUIRED] id=${String(payload?.approvalId ?? "")} action=${String(payload?.action ?? "")}. Type: approve ${String(payload?.approvalId ?? "")}`,
          );
          break;

        case "approval.resolved":
          addLine(
            "info",
            `[APPROVAL RESOLVED] id=${String(payload?.approvalId ?? "")} decision=${String(payload?.decision ?? "").toUpperCase()}`,
          );
          break;

        case "watchdog.alert":
          addLine(
            "warn",
            `[WATCHDOG ALERT - ${String(payload?.severity ?? "").toUpperCase()}] ${String(payload?.rule ?? "")}: ${String(payload?.message ?? "")}`,
          );
          break;

        case "worker.intervention":
          addLine(
            "error",
            `[WATCHDOG INTERVENTION] action=${String(payload?.action ?? "").toUpperCase()} reason="${String(payload?.reason ?? "")}"`,
          );
          break;

        case "usage.updated":
          addLine(
            "info",
            `[METRICS] Tokens: ${formatNumber(locale, Number(payload?.tokensIn ?? 0) + Number(payload?.tokensOut ?? 0))} | Cost: ${formatCurrency(locale, Number(payload?.costUsd ?? 0))}`,
          );
          break;

        case "run.completed":
          addLine(
            "success",
            `[RUN COMPLETE] Status: ${String(payload?.status ?? "").toUpperCase()} in ${String(payload?.durationMs ?? 0)}ms`,
          );
          break;

        case "memory.stored":
          addLine(
            "info",
            `[MEMORY STORED - @${String(payload?.role ?? "all")}] "${String(payload?.snippet ?? "")}" (importance: ${String(payload?.importance ?? 3)}/5)`,
          );
          break;

        case "knowledge.ingested":
          addLine(
            "info",
            `[KNOWLEDGE INGESTED] "${String(payload?.title ?? "")}" [${String(payload?.category ?? "")}] (${String(payload?.chunksCount ?? 0)} chunks)`,
          );
          break;

        case "workspace.created":
          addLine(
            "success",
            `[WORKSPACE CREATED] "${String(payload?.name ?? "")}" (id: ${String(payload?.workspaceId ?? "")})`,
          );
          break;

        case "token.created":
          addLine(
            "warn",
            `[API TOKEN CREATED] "${String(payload?.name ?? "")}" role=${String(payload?.role ?? "")} (${String(payload?.prefix ?? "")})`,
          );
          break;

        case "token.revoked":
          addLine(
            "error",
            `[API TOKEN REVOKED] "${String(payload?.name ?? "")}" (id: ${String(payload?.tokenId ?? "")})`,
          );
          break;

        case "webhook.dispatched":
          addLine(
            "info",
            `[WEBHOOK DISPATCHED] event=${String(payload?.eventType ?? "")} success=${String(payload?.success ?? "")} (${String(payload?.durationMs ?? 0)}ms)`,
          );
          break;

        default:
          break;
      }
    },
    [addLine, locale],
  );

  // WebSocket live connection to stream agent events into terminal
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/v1/realtime`;

    let ws: WebSocket | null = null;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setSocketConnected(true);
        ws?.send(JSON.stringify({ op: "subscribe", topics: ["workspace"] }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.op === "event" && msg.event) {
            handleEventMessage(msg.event as CCEvent);
          } else if (msg.op === "batch" && Array.isArray(msg.events)) {
            for (const ev of msg.events) {
              handleEventMessage(ev as CCEvent);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        setSocketConnected(false);
      };

      ws.onerror = () => {
        setSocketConnected(false);
      };
    };

    connect();

    const pingTimer = window.setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: "ping" }));
      }
    }, 15000);

    return () => {
      clearInterval(pingTimer);
      if (ws) {
        ws.close();
      }
    };
  }, [handleEventMessage]);

  const executeCommand = async (cmdString: string) => {
    const trimmed = cmdString.trim();
    if (!trimmed) return;

    // Echo input command
    addLine("input", `${t("terminal.prompt")} ${trimmed}`);

    // Add to history
    setHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    setInputVal("");

    const parts = trimmed.split(" ");
    const command = parts[0]?.toLowerCase() ?? "";
    const arg = parts.slice(1).join(" ").trim();

    switch (command) {
      case "help":
      case "ayuda":
      case "?":
        addLine(
          "info",
          t("terminal.help") +
            "\n  roles                List registered agent personas" +
            "\n  tools                List available sandboxed tools" +
            "\n  test-tool <name> [args] Test tool execution in safe sandbox" +
            "\n  mcp [sync <id>]      List or synchronize MCP servers" +
            "\n  memory [add|q]       List or search long-term agent memories" +
            "\n  knowledge / rag      Query or ingest workspace documentation (RAG)" +
            "\n  workspaces           List or create multi-tenant workspaces" +
            "\n  tokens               Manage workspace API access tokens" +
            "\n  webhooks             Manage webhook subscribers and test deliveries" +
            "\n  analytics            Display workspace execution observatory" +
            "\n  artifacts            List workspace artifacts and generated files" +
            "\n  cat <file>           Display content of an artifact file" +
            "\n  schedules            List scheduled autonomous routines" +
            "\n  trigger <id>         Trigger immediate execution of a schedule" +
            "\n  export <runId>       Export complete run dossier (md/html/json)" +
            "\n  steer <id> <inst>    Steer an existing run with operator instructions" +
            "\n  cancel <id>          Cancel an ongoing run",
        );
        break;

      case "clear":
      case "limpiar":
      case "cls":
        setLines([]);
        break;

      case "status":
      case "estado": {
        try {
          const [healthRes, connRes, runsRes] = await Promise.all([
            fetch("/api/v1/health", { headers: { "X-Infuture-Locale": locale } }),
            fetch("/api/v1/connections", { headers: { "X-Infuture-Locale": locale } }),
            fetch("/api/v1/runs", { headers: { "X-Infuture-Locale": locale } }),
          ]);

          const healthy = healthRes.ok;
          const conns = connRes.ok ? await connRes.json() : [];
          const runs = runsRes.ok ? await runsRes.json() : [];

          addLine(
            "info",
            t("terminal.systemStatus", {
              connections: conns.length,
              runs: runs.length,
              lang: locale.toUpperCase(),
            }),
          );

          addLine(
            "output",
            `  • API Gateway:     ${healthy ? "ONLINE (Fastify 5)" : "OFFLINE"}\n` +
              `  • Realtime Hub:    ${socketConnected ? "CONNECTED (ws://)" : "OFFLINE"}\n` +
              `  • Security Vault:  ACTIVE (AES-256-GCM envelope encryption)\n` +
              `  • Available Roles: 7 specialized agents (supervisor, researcher, analyst, developer, writer, reviewer, receptionist)`,
          );
        } catch {
          addLine("error", "Failed to retrieve status from command center API.");
        }
        break;
      }

      case "connections":
      case "conexiones": {
        try {
          const res = await fetch("/api/v1/connections", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const data = (await res.json()) as Array<{
            id: string;
            providerId: string;
            alias: string;
            status: string;
            models: string[];
          }>;

          if (data.length === 0) {
            addLine("warn", t("terminal.noConnections"));
          } else {
            addLine("info", `Configured Providers (${data.length}):`);
            for (const c of data) {
              addLine(
                "output",
                `  • [${c.providerId.toUpperCase()}] "${c.alias}" -> Status: ${c.status.toUpperCase()} (${c.models.length} models)`,
              );
            }
          }
        } catch {
          addLine("error", "Could not query connections endpoint.");
        }
        break;
      }

      case "workers":
      case "agentes": {
        addLine("info", `Specialized Agent Roster (7 roles):`);
        for (const item of ROLES_CATALOG) {
          const roleName = t(`roles.${item.role}.name`);
          const roleDesc = t(`roles.${item.role}.description`);
          addLine("output", `  • [${roleName.toUpperCase()}] ${roleDesc}`);
        }
        break;
      }

      case "approvals":
      case "aprobaciones": {
        try {
          const res = await fetch("/api/v1/approvals", {
            headers: { "X-Infuture-Locale": locale },
          });
          const list = (await res.json()) as Array<{
            id: string;
            action: string;
            status: string;
            detail: Record<string, unknown>;
          }>;
          const pending = list.filter((a) => a.status === "pending");
          if (pending.length === 0) {
            addLine("info", "No pending human approvals.");
          } else {
            addLine("warn", `Pending Approvals (${pending.length}):`);
            for (const a of pending) {
              addLine(
                "output",
                `  • [${a.id.slice(0, 8)}] Action: "${a.action}" | Detail: ${JSON.stringify(a.detail)} -> Run: approve ${a.id}`,
              );
            }
          }
        } catch {
          addLine("error", "Failed to retrieve approvals list.");
        }
        break;
      }

      case "approve":
      case "aprobar": {
        if (!arg) {
          addLine("warn", "Usage: approve <approvalId>");
          return;
        }
        try {
          const res = await fetch(`/api/v1/approvals/${arg}/resolve`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Infuture-Locale": locale,
            },
            body: JSON.stringify({ decision: "approved", note: "Approved via terminal command" }),
          });
          if (res.ok) {
            addLine("success", `Approval ${arg} marked as APPROVED.`);
          } else {
            addLine("error", `Failed to resolve approval: ${res.statusText}`);
          }
        } catch (e) {
          addLine("error", `Error resolving approval: ${String(e)}`);
        }
        break;
      }

      case "reject":
      case "rechazar": {
        if (!arg) {
          addLine("warn", "Usage: reject <approvalId>");
          return;
        }
        try {
          const res = await fetch(`/api/v1/approvals/${arg}/resolve`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Infuture-Locale": locale,
            },
            body: JSON.stringify({ decision: "rejected", note: "Rejected via terminal command" }),
          });
          if (res.ok) {
            addLine("warn", `Approval ${arg} marked as REJECTED.`);
          } else {
            addLine("error", `Failed to reject approval: ${res.statusText}`);
          }
        } catch (e) {
          addLine("error", `Error rejecting approval: ${String(e)}`);
        }
        break;
      }

      case "lang":
      case "idioma": {
        if (!arg) {
          addLine("info", `Current language: ${locale} (supported: en, es). Usage: lang en | lang es`);
          return;
        }
        const nextLang = arg.toLowerCase();
        if (nextLang === "en" || nextLang === "es") {
          void i18n.changeLanguage(nextLang);
          addLine("success", t("terminal.langSwitched", { lang: nextLang.toUpperCase() }));
        } else {
          addLine("error", `Unsupported language: "${nextLang}". Use 'en' or 'es'.`);
        }
        break;
      }

      case "run": {
        if (!arg) {
          addLine("warn", t("terminal.noGoal"));
          return;
        }
        addLine("info", t("terminal.runningTask", { goal: arg }));
        await dispatchRun(arg, false, "supervisor");
        break;
      }

      case "team":
      case "multiagent": {
        if (!arg) {
          addLine("warn", t("terminal.noGoal"));
          return;
        }
        addLine("info", t("terminal.runningTeam", { goal: arg }));
        await dispatchRun(arg, true, "supervisor");
        break;
      }

      case "ask":
      case "preguntar": {
        if (!arg) {
          addLine("warn", t("terminal.noQuestion"));
          return;
        }
        addLine("info", `[RECEPTIONIST] Processing query: "${arg}"...`);
        await dispatchRun(arg, false, "receptionist");
        break;
      }

      case "cancel":
      case "cancelar": {
        if (!arg) {
          addLine("warn", "Usage: cancel <runId>");
          return;
        }
        try {
          const res = await fetch(`/api/v1/runs/${arg}/cancel`, {
            method: "POST",
            headers: { "X-Infuture-Locale": locale },
          });
          if (res.ok) {
            addLine("warn", `Run ${arg} has been CANCELLED.`);
          } else {
            const err = await res.json();
            addLine("error", `Failed to cancel run: ${err.error?.message ?? res.statusText}`);
          }
        } catch (e) {
          addLine("error", `Error cancelling run: ${String(e)}`);
        }
        break;
      }

      case "roles": {
        try {
          const res = await fetch("/api/v1/roles", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const roleList = (await res.json()) as Array<{
            id: string;
            name: string;
            isCustom: boolean;
            tools: string[];
          }>;
          addLine("info", `Registered Roles (${roleList.length}):`);
          for (const r of roleList) {
            const tag = r.isCustom ? "[CUSTOM]" : "[BUILT-IN]";
            addLine("output", `  • ${tag} @${r.id.padEnd(14)} "${r.name}" (tools: ${r.tools.join(", ")})`);
          }
        } catch {
          addLine("error", "Failed to query roles.");
        }
        break;
      }

      case "tools": {
        try {
          const res = await fetch("/api/v1/tools", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const toolList = (await res.json()) as Array<{
            name: string;
            description: string;
            requiresApproval: boolean;
          }>;
          addLine("info", `Available Tools (${toolList.length}):`);
          for (const tl of toolList) {
            const approvalTag = tl.requiresApproval ? "[APPROVAL REQUIRED]" : "[SANDBOXED]";
            addLine("output", `  • ${tl.name.padEnd(14)} ${approvalTag} ${tl.description}`);
          }
        } catch {
          addLine("error", "Failed to query tools.");
        }
        break;
      }

      case "test-tool":
      case "probar-herramienta": {
        if (!arg) {
          addLine("warn", t("terminal.testToolUsage"));
          break;
        }
        const firstSpace = arg.indexOf(" ");
        const toolName = (firstSpace === -1 ? arg : arg.slice(0, firstSpace)).trim();
        const rawArgs = firstSpace === -1 ? "{}" : arg.slice(firstSpace + 1).trim();

        let parsedArgs = {};
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch (e) {
          addLine("error", `Invalid JSON arguments: ${e instanceof Error ? e.message : String(e)}`);
          break;
        }

        try {
          addLine("info", `Executing "${toolName}" in sandbox...`);
          const res = await fetch(`/api/v1/tools/${toolName}/test`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Infuture-Locale": locale,
            },
            body: JSON.stringify({ args: parsedArgs }),
          });
          const data = await res.json();
          if (res.ok && data.ok) {
            addLine(
              "success",
              t("terminal.testToolSuccess", {
                name: toolName,
                duration: data.durationMs,
              }),
            );
            addLine("output", `Summary: ${data.summary}`);
            if (data.data !== undefined) {
              addLine("output", JSON.stringify(data.data, null, 2));
            }
          } else {
            addLine(
              "error",
              t("terminal.testToolError", {
                name: toolName,
                duration: data.durationMs ?? 0,
                error: data.summary ?? data.error?.message ?? res.statusText,
              }),
            );
          }
        } catch {
          addLine("error", "Failed to test tool.");
        }
        break;
      }

      case "mcp": {
        const [subcmd, serverId] = arg.split(/\s+/);
        if (subcmd === "sync") {
          if (!serverId) {
            addLine("warn", t("terminal.mcpUsage"));
            break;
          }
          try {
            addLine("info", `Synchronizing MCP server "${serverId}"...`);
            const res = await fetch(`/api/v1/mcp/servers/${serverId}/sync`, {
              method: "POST",
              headers: { "X-Infuture-Locale": locale },
            });
            if (res.ok) {
              const data = await res.json();
              addLine(
                "success",
                t("terminal.mcpSynced", {
                  name: data.name,
                  count: data.toolsCount,
                }),
              );
            } else {
              addLine("error", `Sync failed: ${res.statusText}`);
            }
          } catch {
            addLine("error", "Failed to sync MCP server.");
          }
          break;
        }

        try {
          const res = await fetch("/api/v1/mcp/servers", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const servers = (await res.json()) as Array<{
            id: string;
            name: string;
            transport: string;
            enabled: boolean;
            command?: string;
            args?: string[];
            url?: string;
            discoveredTools: Array<{ name: string }>;
          }>;
          addLine("info", t("terminal.mcpHeader", { count: servers.length }));
          for (const s of servers) {
            const statusTag = s.enabled ? "[ENABLED]" : "[DISABLED]";
            const transportTag = `[${s.transport.toUpperCase()}]`;
            const tools = s.discoveredTools?.map((t) => t.name).join(", ") || "none";
            addLine(
              "output",
              `  • ${statusTag} ${transportTag} ${s.name} (id: ${s.id}) -> tools: [${tools}] (sync: mcp sync ${s.id})`,
            );
          }
        } catch {
          addLine("error", "Failed to query MCP servers.");
        }
        break;
      }

      case "memory":
      case "memoria": {
        const parts = (arg || "").trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase();

        if (subcmd === "add" || subcmd === "guardar") {
          const content = parts.slice(1).join(" ").trim();
          if (!content) {
            addLine("warn", "Usage: memory add <content to remember>");
            break;
          }
          try {
            const res = await fetch("/api/v1/memory", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Infuture-Locale": locale,
              },
              body: JSON.stringify({ content, role: "all", importance: 4 }),
            });
            if (res.ok) {
              const data = await res.json();
              addLine("success", `Memory recorded! id=${data.id}`);
            } else {
              addLine("error", `Failed to save memory: ${res.statusText}`);
            }
          } catch {
            addLine("error", "Network error recording memory.");
          }
          break;
        }

        const q =
          subcmd === "search" || subcmd === "q" || subcmd === "buscar"
            ? parts.slice(1).join(" ").trim()
            : arg.trim();

        try {
          const url = q ? `/api/v1/memory?q=${encodeURIComponent(q)}` : "/api/v1/memory";
          const res = await fetch(url, { headers: { "X-Infuture-Locale": locale } });
          if (!res.ok) throw new Error("API error");
          const list = (await res.json()) as Array<{
            id: string;
            role: string;
            content: string;
            importance: number;
            tags: string[];
          }>;
          addLine("info", `Agent Memory Bank (${list.length}${q ? ` for "${q}"` : ""}):`);
          for (const m of list) {
            const stars = "★".repeat(m.importance) + "☆".repeat(5 - m.importance);
            const tagStr = m.tags?.length ? ` [${m.tags.join(", ")}]` : "";
            addLine("output", `  • ${stars} @${m.role.padEnd(11)} "${m.content}"${tagStr}`);
          }
        } catch {
          addLine("error", "Failed to query memory bank.");
        }
        break;
      }

      case "knowledge":
      case "conocimiento":
      case "rag": {
        const parts = (arg || "").trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase();

        if (subcmd === "query" || subcmd === "q" || subcmd === "buscar") {
          const query = parts.slice(1).join(" ").trim();
          if (!query) {
            addLine("warn", "Usage: knowledge query <search question>");
            break;
          }
          try {
            addLine("info", "Querying knowledge base with RAG retrieval...");
            const res = await fetch("/api/v1/knowledge/query", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Infuture-Locale": locale,
              },
              body: JSON.stringify({ query, limit: 3 }),
            });
            if (!res.ok) throw new Error("API error");
            const data = (await res.json()) as {
              count: number;
              results: Array<{ title: string; category: string; text: string; score: number }>;
            };
            addLine("info", `RAG Retrieval Results (${data.count}) for "${query}":`);
            for (const r of data.results) {
              const matchPct = `${Math.round(r.score * 100)}% match`;
              addLine("output", `  • [${matchPct}] ${r.title} (${r.category})`);
              addLine("output", `    ${r.text.replace(/\n/g, " ").slice(0, 180)}...`);
            }
          } catch {
            addLine("error", "Failed to query knowledge base.");
          }
          break;
        }

        if (subcmd === "ingest" || subcmd === "agregar") {
          const title = parts[1];
          const content = parts.slice(2).join(" ").trim();
          if (!title || !content) {
            addLine("warn", "Usage: knowledge ingest <title> <markdown/text content>");
            break;
          }
          try {
            const res = await fetch("/api/v1/knowledge", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Infuture-Locale": locale,
              },
              body: JSON.stringify({ title, content, category: "general" }),
            });
            if (res.ok) {
              const doc = await res.json();
              addLine("success", `Document ingested! id=${doc.id} (${doc.chunksCount} chunks)`);
            } else {
              addLine("error", `Ingest failed: ${res.statusText}`);
            }
          } catch {
            addLine("error", "Network error ingesting document.");
          }
          break;
        }

        try {
          const res = await fetch("/api/v1/knowledge", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const docs = (await res.json()) as Array<{
            id: string;
            title: string;
            category: string;
            chunksCount: number;
            totalTokensEstimate: number;
            preview: string;
          }>;
          addLine("info", `Workspace Knowledge Documents (${docs.length}):`);
          for (const d of docs) {
            addLine(
              "output",
              `  • [${d.category.toUpperCase()}] ${d.title} (${d.chunksCount} chunks, ~${d.totalTokensEstimate} tokens)`,
            );
            addLine("output", `    ${d.preview.replace(/\n/g, " ").slice(0, 120)}...`);
          }
        } catch {
          addLine("error", "Failed to query knowledge documents.");
        }
        break;
      }

      case "workspaces":
      case "espacios": {
        const parts = (arg || "").trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase();

        if (subcmd === "create" || subcmd === "crear") {
          const name = parts.slice(1).join(" ").trim();
          if (!name) {
            addLine("warn", "Usage: workspaces create <Workspace Name>");
            break;
          }
          try {
            const res = await fetch("/api/v1/workspaces", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
              body: JSON.stringify({ name, defaultLocale: locale }),
            });
            if (!res.ok) throw new Error("API error");
            const ws = (await res.json()) as { id: string; name: string; defaultLocale: string };
            addLine("success", `Workspace created! id=${ws.id} name="${ws.name}" (${ws.defaultLocale})`);
          } catch {
            addLine("error", "Failed to create workspace.");
          }
          break;
        }

        try {
          const res = await fetch("/api/v1/workspaces", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const data = (await res.json()) as {
            workspaces: Array<{ id: string; name: string; defaultLocale: string }>;
          };
          addLine("info", `Multi-tenant Workspaces (${data.workspaces.length}):`);
          for (const w of data.workspaces) {
            addLine("output", `  • ${w.name} (id: ${w.id}) [locale: ${w.defaultLocale}]`);
          }
        } catch {
          addLine("error", "Failed to list workspaces.");
        }
        break;
      }

      case "tokens":
      case "token": {
        const parts = (arg || "").trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase();

        if (subcmd === "create" || subcmd === "crear") {
          const name = parts[1];
          const role = parts[2] || "operator";
          if (!name) {
            addLine("warn", "Usage: tokens create <token_name> [admin|operator|viewer]");
            break;
          }
          try {
            const res = await fetch("/api/v1/tokens", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
              body: JSON.stringify({ name, role }),
            });
            if (!res.ok) throw new Error("API error");
            const issued = (await res.json()) as {
              token: string;
              record: { name: string; role: string; tokenPrefix: string };
            };
            addLine("success", `API Token Issued! Name: ${issued.record.name} (Role: ${issued.record.role})`);
            addLine("warn", `SECRET: ${issued.token} (Copy now, not shown again)`);
          } catch {
            addLine("error", "Failed to issue API token.");
          }
          break;
        }

        if (subcmd === "revoke" || subcmd === "del") {
          const id = parts[1];
          if (!id) {
            addLine("warn", "Usage: tokens revoke <token_id>");
            break;
          }
          try {
            const res = await fetch(`/api/v1/tokens/${id}`, {
              method: "DELETE",
              headers: { "X-Infuture-Locale": locale },
            });
            if (res.ok) {
              addLine("success", `Token ${id} revoked.`);
            } else {
              addLine("error", "Failed to revoke token.");
            }
          } catch {
            addLine("error", "Network error revoking token.");
          }
          break;
        }

        try {
          const res = await fetch("/api/v1/tokens", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const data = (await res.json()) as {
            tokens: Array<{ id: string; name: string; role: string; tokenPrefix: string }>;
          };
          addLine("info", `Active Workspace API Tokens (${data.tokens.length}):`);
          for (const t of data.tokens) {
            addLine("output", `  • [${t.role.toUpperCase()}] ${t.name} (${t.tokenPrefix}) - id: ${t.id}`);
          }
        } catch {
          addLine("error", "Failed to list API tokens.");
        }
        break;
      }

      case "webhooks":
      case "webhook": {
        const parts = (arg || "").trim().split(/\s+/);
        const subcmd = parts[0]?.toLowerCase();

        if (subcmd === "add" || subcmd === "create") {
          const url = parts[1];
          const events = parts.slice(2);
          if (!url) {
            addLine("warn", "Usage: webhooks add <https://endpoint> [event1 event2 ...]");
            break;
          }
          try {
            const res = await fetch("/api/v1/webhooks", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
              body: JSON.stringify({ url, events: events.length > 0 ? events : ["*"] }),
            });
            if (!res.ok) throw new Error("API error");
            const wh = (await res.json()) as { id: string; url: string; secret: string; events: string[] };
            addLine("success", `Webhook registered! id=${wh.id} URL=${wh.url}`);
            addLine("info", `Secret: ${wh.secret} (Events: ${wh.events.join(", ")})`);
          } catch {
            addLine("error", "Failed to register webhook.");
          }
          break;
        }

        if (subcmd === "test" || subcmd === "ping") {
          const id = parts[1];
          if (!id) {
            addLine("warn", "Usage: webhooks test <webhook_id>");
            break;
          }
          try {
            addLine("info", `Sending HMAC test ping to webhook ${id}...`);
            const res = await fetch(`/api/v1/webhooks/${id}/test`, {
              method: "POST",
              headers: { "X-Infuture-Locale": locale },
            });
            if (!res.ok) throw new Error("API error");
            const result = (await res.json()) as {
              success: boolean;
              statusCode: number | null;
              durationMs: number;
              error: string | null;
            };
            if (result.success) {
              addLine("success", `Delivery Successful! HTTP ${result.statusCode} in ${result.durationMs}ms`);
            } else {
              addLine("error", `Delivery Failed: ${result.error ?? "error"} (${result.durationMs}ms)`);
            }
          } catch {
            addLine("error", "Failed to test webhook.");
          }
          break;
        }

        if (subcmd === "del" || subcmd === "remove") {
          const id = parts[1];
          if (!id) {
            addLine("warn", "Usage: webhooks del <webhook_id>");
            break;
          }
          try {
            const res = await fetch(`/api/v1/webhooks/${id}`, {
              method: "DELETE",
              headers: { "X-Infuture-Locale": locale },
            });
            if (res.ok) {
              addLine("success", `Webhook ${id} removed.`);
            } else {
              addLine("error", "Failed to remove webhook.");
            }
          } catch {
            addLine("error", "Network error removing webhook.");
          }
          break;
        }

        try {
          const res = await fetch("/api/v1/webhooks", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const data = (await res.json()) as {
            webhooks: Array<{ id: string; url: string; events: string[]; enabled: boolean }>;
          };
          addLine("info", `Registered Webhooks (${data.webhooks.length}):`);
          for (const w of data.webhooks) {
            addLine(
              "output",
              `  • [${w.enabled ? "ACTIVE" : "DISABLED"}] ${w.url} (${w.events.join(", ")}) - id: ${w.id}`,
            );
          }
        } catch {
          addLine("error", "Failed to list webhooks.");
        }
        break;
      }

      case "analytics":
      case "stats": {
        try {
          const res = await fetch("/api/v1/analytics", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const a = await res.json();
          addLine("info", "Workspace Execution Analytics:");
          addLine(
            "output",
            `  • Total Runs:       ${a.totalRuns} (${a.byStatus.done} done, ${a.byStatus.failed} failed, ${a.byStatus.cancelled} cancelled)\n` +
              `  • Success Rate:     ${a.successRatePercent}%\n` +
              `  • Total Tokens:     ${formatNumber(locale, a.totalTokens)} (${formatNumber(locale, a.totalTokensIn)} in / ${formatNumber(locale, a.totalTokensOut)} out)\n` +
              `  • Total Cost:       ${formatCurrency(locale, a.totalCostUsd)}\n` +
              `  • Avg Cost / Run:   ${formatCurrency(locale, a.averageCostPerRun)}`,
          );
        } catch {
          addLine("error", "Failed to query analytics.");
        }
        break;
      }

      case "artifacts":
      case "artefactos": {
        try {
          const res = await fetch("/api/v1/artifacts", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const artifacts = (await res.json()) as Array<{
            id: string;
            name: string;
            kind: string;
            bytes: number;
            ts: string;
          }>;
          if (artifacts.length === 0) {
            addLine("warn", t("terminal.noArtifacts"));
          } else {
            addLine("info", t("terminal.artifactsHeader", { count: artifacts.length }));
            for (const a of artifacts) {
              addLine(
                "output",
                `  • [${a.kind.toUpperCase()}] ${a.name} (${a.bytes} bytes) - id: ${a.id.slice(0, 8)}`,
              );
            }
          }
        } catch {
          addLine("error", "Failed to retrieve artifacts.");
        }
        break;
      }

      case "cat":
      case "leer": {
        if (!arg) {
          addLine("warn", "Usage: cat <filename or artifactId>");
          return;
        }
        try {
          const res = await fetch("/api/v1/artifacts", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const artifacts = (await res.json()) as Array<{
            id: string;
            name: string;
            kind: string;
            content?: string;
          }>;
          const found = artifacts.find(
            (a) => a.name.toLowerCase() === arg.toLowerCase() || a.id === arg || a.id.startsWith(arg),
          );
          if (!found || !found.content) {
            addLine("error", t("terminal.artifactNotFound", { name: arg }));
          } else {
            addLine("info", `=== ${found.name} (${found.kind.toUpperCase()}) ===`);
            addLine("output", found.content);
          }
        } catch {
          addLine("error", `Failed to read artifact "${arg}".`);
        }
        break;
      }

      case "schedules":
      case "rutinas": {
        try {
          const res = await fetch("/api/v1/schedules", {
            headers: { "X-Infuture-Locale": locale },
          });
          if (!res.ok) throw new Error("API error");
          const list = (await res.json()) as Array<{
            id: string;
            name: string;
            interval: string;
            role: string;
            enabled: boolean;
            nextRunAt: string | null;
          }>;
          addLine("info", t("terminal.schedulesHeader", { count: list.length }));
          for (const s of list) {
            addLine(
              "output",
              `  • [${s.enabled ? "ACTIVE" : "PAUSED"}] ${s.name} (${s.interval}, role: ${s.role}) - id: ${s.id}`,
            );
          }
        } catch {
          addLine("error", "Failed to list schedules.");
        }
        break;
      }

      case "trigger":
      case "ejecutar": {
        if (!arg) {
          addLine("warn", "Usage: trigger <scheduleId>");
          return;
        }
        try {
          const res = await fetch(`/api/v1/schedules/${arg}/trigger`, {
            method: "POST",
            headers: { "X-Infuture-Locale": locale },
          });
          if (res.ok) {
            const data = await res.json();
            addLine("warn", t("terminal.scheduleTriggered", { name: data.name }));
            if (data.dispatch) {
              await dispatchRun(data.dispatch.goal, data.dispatch.multiagent, data.dispatch.role);
            }
          } else {
            addLine("error", `Failed to trigger schedule: ${res.statusText}`);
          }
        } catch (e) {
          addLine("error", `Error triggering schedule: ${String(e)}`);
        }
        break;
      }

      case "export":
      case "exportar": {
        if (!arg) {
          addLine("warn", "Usage: export <runId> [md|html|json]");
          return;
        }
        const [targetRunId, fmt = "md"] = arg.split(" ");
        const format = fmt === "html" ? "html" : fmt === "json" ? "json" : "markdown";
        try {
          const res = await fetch(`/api/v1/runs/${targetRunId}/export?format=${format}`, {
            headers: { "X-Infuture-Locale": locale },
          });
          if (res.ok) {
            const text = await res.text();
            addLine("info", `=== RUN DOSSIER: ${targetRunId?.slice(0, 8)} (${format.toUpperCase()}) ===`);
            addLine(
              "output",
              text.slice(0, 1500) + (text.length > 1500 ? "\n... (truncated for terminal display)" : ""),
            );
          } else {
            addLine("error", `Failed to export run ${targetRunId}: ${res.statusText}`);
          }
        } catch (e) {
          addLine("error", `Error exporting run: ${String(e)}`);
        }
        break;
      }

      case "steer":
      case "guiar": {
        const firstSpace = arg.indexOf(" ");
        if (!arg || firstSpace === -1) {
          addLine("warn", "Usage: steer <runId> <instruction here>");
          return;
        }
        const targetRunId = arg.slice(0, firstSpace).trim();
        const instruction = arg.slice(firstSpace + 1).trim();
        addLine("info", `Steering run ${targetRunId} with instruction: "${instruction}"...`);
        try {
          const res = await fetch(`/api/v1/runs/${targetRunId}/feedback`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Infuture-Locale": locale,
            },
            body: JSON.stringify({ prompt: instruction }),
          });
          if (res.ok) {
            const data = await res.json();
            addLine("success", `Run ${targetRunId} successfully steered! Output updated.`);
            if (data.output) {
              addLine("output", String(data.output).slice(-500));
            }
          } else {
            const err = await res.json().catch(() => ({}));
            addLine("error", `Failed to steer run: ${err.message ?? res.statusText}`);
          }
        } catch (e) {
          addLine("error", `Error steering run: ${String(e)}`);
        }
        break;
      }

      default:
        addLine("error", t("terminal.unknownCommand", { cmd: command }));
        break;
    }
  };

  const dispatchRun = async (goalText: string, isMultiagent: boolean, role: string) => {
    try {
      // Find a healthy connection first
      const connRes = await fetch("/api/v1/connections", {
        headers: { "X-Infuture-Locale": locale },
      });
      const conns = connRes.ok ? await connRes.json() : [];
      const healthy = conns.find((c: { status: string }) => c.status === "healthy") ?? conns[0];

      if (!healthy) {
        addLine("warn", t("terminal.noConnections"));
        return;
      }

      const res = await fetch("/api/v1/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify({
          goal: goalText,
          role,
          connectionId: healthy.id,
          multiagent: isMultiagent,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        addLine("error", `Execution failed: ${err.message ?? res.statusText}`);
        return;
      }

      const result = await res.json();
      setActiveRunId(result.id);
      addLine("success", `Run accepted! [id: ${result.id}] Streaming live telemetry...`);
    } catch (e) {
      addLine("error", `Network error dispatching run: ${String(e)}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void executeCommand(inputVal);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const nextIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      setInputVal(history[nextIndex] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex === -1) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(-1);
        setInputVal("");
      } else {
        setHistoryIndex(nextIndex);
        setInputVal(history[nextIndex] ?? "");
      }
    }
  };

  return (
    <section className="terminal-view card card-wide" onClick={handleContainerClick}>
      {/* Terminal Title Bar */}
      <div className="terminal-header">
        <div className="terminal-controls">
          <span className="dot dot-close" />
          <span className="dot dot-minimize" />
          <span className="dot dot-expand" />
        </div>
        <div className="terminal-title mono">infuture-ia // command-center-terminal</div>
        <div className="terminal-badges">
          <span className={`pill small ${socketConnected ? "pill-ok" : "pill-warn"}`}>
            {socketConnected ? "WS: LIVE" : "WS: OFF"}
          </span>
          <span className="pill small mono">{locale.toUpperCase()}</span>
          {activeRunId && <span className="pill small pill-accent mono">RUN: {activeRunId.slice(0, 8)}</span>}
        </div>
      </div>

      {/* Quick Action Suggestion Chips */}
      <div className="terminal-chips">
        {SUGGESTED_COMMANDS.map((cmd) => (
          <button
            key={cmd}
            type="button"
            className="terminal-chip mono small"
            onClick={(e) => {
              e.stopPropagation();
              void executeCommand(cmd);
            }}
          >
            {cmd}
          </button>
        ))}
      </div>

      {/* Terminal Scroll Body */}
      <div className="terminal-body" ref={terminalBodyRef}>
        {lines.map((line) => {
          let lineClass = "terminal-line-output";
          if (line.kind === "input") lineClass = "terminal-line-input";
          if (line.kind === "info") lineClass = "terminal-line-info";
          if (line.kind === "warn") lineClass = "terminal-line-warn";
          if (line.kind === "error") lineClass = "terminal-line-error";
          if (line.kind === "success") lineClass = "terminal-line-success";
          if (line.kind === "thought") lineClass = "terminal-line-thought";
          if (line.kind === "board") lineClass = "terminal-line-board";
          if (line.kind === "review") lineClass = "terminal-line-review";

          return (
            <div key={line.id} className={`terminal-line mono ${lineClass}`}>
              {line.timestamp && <span className="terminal-time">[{line.timestamp}]</span>}
              <span className="terminal-text">{line.text}</span>
            </div>
          );
        })}

        {/* Input prompt line */}
        <div className="terminal-prompt-line mono">
          <span className="terminal-prompt">{t("terminal.prompt")}</span>
          <input
            ref={inputRef}
            type="text"
            className="terminal-input mono"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("terminal.placeholder")}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
          <span className="terminal-cursor" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
