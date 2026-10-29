#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const API_BASE = process.env.API_BASE ?? "http://localhost:4000";
const WS_BASE = process.env.WS_BASE ?? "ws://localhost:4000";
const LOCALE = process.env.LOCALE ?? (process.env.LANG?.startsWith("es") ? "es" : "en");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════╗${C.reset}`);
console.log(`${C.bold}${C.cyan}║             infuture IA · Interactive Terminal CLI           ║${C.reset}`);
console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════╝${C.reset}`);
console.log(`${C.dim}API: ${API_BASE} | WS: ${WS_BASE} | Lang: ${LOCALE}${C.reset}`);
console.log(`Type ${C.yellow}help${C.reset} for commands or ${C.yellow}exit${C.reset} to quit.\n`);

// Setup WebSocket live event listener
let ws;
try {
  ws = new WebSocket(`${WS_BASE}/api/v1/realtime`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ op: "subscribe", topics: ["workspace"] }));
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.op === "event" && msg.event) {
        printLiveEvent(msg.event);
      }
    } catch {
      // Ignore parse errors
    }
  };
  ws.onerror = () => {
    // Silent on background WS error
  };
} catch {
  // Silent fallback
}

function printLiveEvent(ev) {
  const p = ev.payload ?? {};
  switch (ev.type) {
    case "run.created":
      console.log(`\n${C.cyan}[RUN CREATED]${C.reset} id=${ev.runId} goal="${p.goal ?? ""}"`);
      break;
    case "worker.status_changed":
      console.log(
        `${C.blue}[WORKER]${C.reset} ${p.role ?? "agent"} -> ${C.yellow}${p.to}${C.reset} (${p.reason ?? ""})`,
      );
      break;
    case "agent.thought":
      console.log(`${C.magenta}[THOUGHT - ${p.role ?? "agent"}]${C.reset} ${p.thought}`);
      break;
    case "llm.request.started":
      console.log(`${C.dim}[LLM CALL] provider=${p.providerId} model=${p.model}${C.reset}`);
      break;
    case "tool.call.started":
      console.log(`${C.cyan}[TOOL CALL]${C.reset} ${p.tool}(${JSON.stringify(p.args ?? {})})`);
      break;
    case "tool.call.completed":
      console.log(`${C.green}[TOOL DONE]${C.reset} ${p.summary}`);
      break;
    case "approval.requested":
      console.log(
        `${C.yellow}${C.bold}[APPROVAL REQUIRED]${C.reset} Action: ${p.action} (id: ${p.approvalId}). Run: ${C.green}approve ${p.approvalId}${C.reset}`,
      );
      break;
    case "approval.resolved":
      console.log(`${C.green}[APPROVAL RESOLVED]${C.reset} Decision: ${(p.decision ?? "").toUpperCase()}`);
      break;
    case "watchdog.alert":
      console.log(
        `${C.red}${C.bold}[WATCHDOG ALERT - ${(p.severity ?? "").toUpperCase()}]${C.reset} ${p.rule}: ${p.message}`,
      );
      break;
    case "worker.intervention":
      console.log(
        `${C.red}[WATCHDOG INTERVENTION]${C.reset} Action: ${(p.action ?? "").toUpperCase()} (${p.reason ?? ""})`,
      );
      break;
    case "board.posted":
      console.log(
        `${C.yellow}[BOARD - ${(p.kind ?? "").toUpperCase()}]${C.reset} ${p.topic}: "${p.content}"`,
      );
      break;
    case "review.completed":
      console.log(
        `${C.bold}${C.green}[REVIEW VERDICT: ${(p.verdict ?? "").toUpperCase()}]${C.reset} ${p.critique ?? "Approved"}`,
      );
      break;
    case "memory.stored":
      console.log(
        `${C.magenta}[MEMORY STORED - @${p.role}]${C.reset} "${p.snippet}" (importance: ${p.importance}/5)`,
      );
      break;
    case "knowledge.ingested":
      console.log(
        `${C.cyan}[KNOWLEDGE INGESTED]${C.reset} "${p.title}" [${p.category}] (${p.chunksCount} chunks)`,
      );
      break;
    case "workspace.created":
      console.log(`${C.green}[WORKSPACE CREATED]${C.reset} "${p.name}" (id: ${p.workspaceId})`);
      break;
    case "token.created":
      console.log(`${C.yellow}[API TOKEN CREATED]${C.reset} "${p.name}" role=${p.role} (${p.prefix})`);
      break;
    case "token.revoked":
      console.log(`${C.red}[API TOKEN REVOKED]${C.reset} "${p.name}" (id: ${p.tokenId})`);
      break;
    case "webhook.dispatched":
      console.log(
        `${C.cyan}[WEBHOOK DISPATCHED]${C.reset} event=${p.eventType} success=${p.success} (${p.durationMs}ms)`,
      );
      break;
    case "run.completed":
      console.log(`${C.bold}${C.green}[RUN COMPLETED]${C.reset} Status: ${p.status} in ${p.durationMs}ms\n`);
      break;
    default:
      break;
  }
}

const rl = readline.createInterface({ input, output });

async function main() {
  while (true) {
    let line = "";
    try {
      line = await rl.question(`${C.green}infuture:~$ ${C.reset}`);
    } catch {
      break;
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(" ");
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ").trim();

    if (cmd === "exit" || cmd === "quit") {
      console.log(`${C.dim}Closing command center session. Bye!${C.reset}`);
      if (ws) ws.close();
      rl.close();
      process.exit(0);
    }

    if (cmd === "help" || cmd === "ayuda" || cmd === "?") {
      console.log(`
${C.bold}Available Commands:${C.reset}
  ${C.yellow}status${C.reset}                 Check API health, active connections, and workers
  ${C.yellow}connections${C.reset}            List configured AI model providers (OpenAI, Anthropic, etc.)
  ${C.yellow}workers / roles${C.reset}        Display configured agent personas and custom roles
  ${C.yellow}tools${C.reset}                  List available sandboxed tools and permissions
  ${C.yellow}test-tool <name> [args]${C.reset} Test tool execution in safe sandbox
  ${C.yellow}mcp [sync <id>]${C.reset}         List or synchronize Model Context Protocol servers
  ${C.yellow}memory [add|q]${C.reset}          List or search long-term agent memories
  ${C.yellow}knowledge / rag${C.reset}         Query or ingest workspace documentation (RAG)
  ${C.yellow}workspaces [create <name>]${C.reset} List or create multi-tenant workspaces
  ${C.yellow}tokens [create|revoke]${C.reset}     Manage workspace API access tokens
  ${C.yellow}webhooks [add|test|del]${C.reset}    Manage webhook subscribers and test event delivery
  ${C.yellow}analytics / stats${C.reset}      Show workspace execution observatory & token costs
  ${C.yellow}artifacts${C.reset}              List generated workspace artifacts
  ${C.yellow}cat <file>${C.reset}             Inspect content of an artifact
  ${C.yellow}schedules${C.reset}              List scheduled autonomous routines
  ${C.yellow}trigger <id>${C.reset}           Trigger immediate execution of a schedule
  ${C.yellow}export <runId>${C.reset}         Export complete run dossier (md/html/json)
  ${C.yellow}steer <id> <inst>${C.reset}      Steer an existing run with operator instructions
  ${C.yellow}approvals${C.reset}              List pending human approvals
  ${C.yellow}approve <id>${C.reset}           Approve a pending sensitive action
  ${C.yellow}reject <id>${C.reset}            Reject a pending sensitive action
  ${C.yellow}cancel <id>${C.reset}            Cancel an active running task
  ${C.yellow}run <goal>${C.reset}             Execute a single-worker task with live stream
  ${C.yellow}team <goal>${C.reset}            Dispatch a multi-agent team (Supervisor, Researcher, Dev, Reviewer)
  ${C.yellow}ask <question>${C.reset}         Ask the Receptionist agent for help
  ${C.yellow}clear${C.reset}                  Clear the console screen
  ${C.yellow}exit${C.reset}                   Exit the terminal
`);
      continue;
    }

    if (cmd === "clear" || cmd === "cls") {
      console.clear();
      continue;
    }

    if (cmd === "status") {
      try {
        const [healthRes, connRes, runsRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/health`, { headers: { "X-Infuture-Locale": LOCALE } }),
          fetch(`${API_BASE}/api/v1/connections`, { headers: { "X-Infuture-Locale": LOCALE } }),
          fetch(`${API_BASE}/api/v1/runs`, { headers: { "X-Infuture-Locale": LOCALE } }),
        ]);

        const healthy = healthRes.ok;
        const conns = connRes.ok ? await connRes.json() : [];
        const runs = runsRes.ok ? await runsRes.json() : [];

        console.log(`\n${C.bold}System Status:${C.reset}`);
        console.log(
          `  • API:         ${healthy ? `${C.green}ONLINE${C.reset}` : `${C.red}OFFLINE${C.reset}`}`,
        );
        console.log(`  • Providers:   ${conns.length} configured`);
        console.log(`  • Runs:        ${runs.length} recorded`);
        console.log(`  • Vault:       ${C.green}AES-256-GCM Envelope Encryption${C.reset}\n`);
      } catch (e) {
        console.log(`${C.red}Error fetching status: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "connections") {
      try {
        const res = await fetch(`${API_BASE}/api/v1/connections`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const conns = await res.json();
        if (conns.length === 0) {
          console.log(
            `${C.yellow}No connections configured. Add one via the web dashboard at http://localhost:5173${C.reset}`,
          );
        } else {
          console.log(`\n${C.bold}Configured AI Providers (${conns.length}):${C.reset}`);
          for (const c of conns) {
            const statusColor = c.status === "healthy" ? C.green : C.yellow;
            console.log(
              `  • [${c.providerId.toUpperCase()}] "${c.alias}" -> ${statusColor}${c.status.toUpperCase()}${C.reset} (${c.models.length} models)`,
            );
          }
          console.log("");
        }
      } catch (e) {
        console.log(`${C.red}Error querying connections: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "workers") {
      console.log(`\n${C.bold}Specialized Agent Roles (7):${C.reset}`);
      const roles = [
        ["supervisor", "Breaks down goals and coordinates the team"],
        ["researcher", "Investigates, reads sources, and summarizes facts"],
        ["analyst", "Analyzes data, compares options, and calculates metrics"],
        ["developer", "Designs architectures and writes production code"],
        ["writer", "Creates polished technical deliverables"],
        ["reviewer", "Audits other workers' work using a cross-model review"],
        ["receptionist", "Welcomes users and answers terminal queries"],
      ];
      for (const [r, desc] of roles) {
        console.log(`  • ${C.cyan}${r.padEnd(14)}${C.reset} ${desc}`);
      }
      console.log("");
      continue;
    }

    if (cmd === "approvals") {
      try {
        const res = await fetch(`${API_BASE}/api/v1/approvals`, { headers: { "X-Infuture-Locale": LOCALE } });
        const list = await res.json();
        const pending = list.filter((a) => a.status === "pending");
        if (pending.length === 0) {
          console.log(`${C.green}No pending human approvals.${C.reset}`);
        } else {
          console.log(`\n${C.bold}Pending Human Approvals (${pending.length}):${C.reset}`);
          for (const a of pending) {
            console.log(
              `  • [${a.id.slice(0, 8)}] Action: "${a.action}" | Run: ${C.green}approve ${a.id}${C.reset}`,
            );
          }
          console.log("");
        }
      } catch (e) {
        console.log(`${C.red}Error querying approvals: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "approve" || cmd === "reject") {
      if (!arg) {
        console.log(`${C.yellow}Usage: ${cmd} <approvalId>${C.reset}`);
        continue;
      }
      try {
        const decision = cmd === "approve" ? "approved" : "rejected";
        const res = await fetch(`${API_BASE}/api/v1/approvals/${arg}/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Infuture-Locale": LOCALE },
          body: JSON.stringify({ decision, note: `Resolved via terminal CLI` }),
        });
        if (res.ok) {
          console.log(`${C.green}Approval ${arg} marked as ${decision.toUpperCase()}.${C.reset}`);
        } else {
          console.log(`${C.red}Failed: ${res.statusText}${C.reset}`);
        }
      } catch (e) {
        console.log(`${C.red}Network error: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "cancel") {
      if (!arg) {
        console.log(`${C.yellow}Usage: cancel <runId>${C.reset}`);
        continue;
      }
      try {
        const res = await fetch(`${API_BASE}/api/v1/runs/${arg}/cancel`, {
          method: "POST",
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (res.ok) {
          console.log(`${C.green}Run ${arg} successfully cancelled.${C.reset}`);
        } else {
          const err = await res.json().catch(() => ({}));
          console.log(`${C.red}Cancel failed: ${err.error?.message ?? res.statusText}${C.reset}`);
        }
      } catch (e) {
        console.log(`${C.red}Error: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "roles") {
      try {
        const res = await fetch(`${API_BASE}/api/v1/roles`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const roleList = await res.json();
        console.log(`\n${C.bold}Configured Agent Personas (${roleList.length}):${C.reset}`);
        for (const r of roleList) {
          const tag = r.isCustom ? `${C.yellow}[CUSTOM]${C.reset}` : `${C.blue}[BUILT-IN]${C.reset}`;
          console.log(
            `  • ${tag} ${C.cyan}@${r.id.padEnd(14)}${C.reset} "${r.name}" -> tools: [${r.tools.join(", ")}]`,
          );
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error querying roles: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "tools") {
      try {
        const res = await fetch(`${API_BASE}/api/v1/tools`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const toolList = await res.json();
        console.log(`\n${C.bold}Available Agent Tools (${toolList.length}):${C.reset}`);
        for (const tl of toolList) {
          const reqApproval = tl.requiresApproval
            ? `${C.yellow}[APPROVAL REQUIRED]${C.reset}`
            : `${C.green}[SANDBOXED]${C.reset}`;
          console.log(`  • ${C.cyan}${tl.name.padEnd(14)}${C.reset} ${reqApproval} ${tl.description}`);
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error querying tools: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "test-tool" || cmd === "probar-herramienta") {
      if (!arg) {
        console.log(`${C.yellow}Usage: test-tool <toolName> [jsonArgs]${C.reset}`);
        console.log(`${C.dim}Example: test-tool calc {"expression":"42 * 10"}${C.reset}`);
        continue;
      }
      const firstSpace = arg.indexOf(" ");
      const toolName = (firstSpace === -1 ? arg : arg.slice(0, firstSpace)).trim();
      const rawArgs = firstSpace === -1 ? "{}" : arg.slice(firstSpace + 1).trim();

      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch (e) {
        console.log(`${C.red}Invalid JSON arguments: ${e.message}${C.reset}`);
        continue;
      }

      console.log(`${C.dim}Executing "${toolName}" in sandbox...${C.reset}`);
      try {
        const res = await fetch(`${API_BASE}/api/v1/tools/${toolName}/test`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Infuture-Locale": LOCALE,
          },
          body: JSON.stringify({ args: parsedArgs }),
        });

        const data = await res.json();
        if (res.ok && data.ok) {
          console.log(`\n${C.green}${C.bold}[TEST SUCCESS]${C.reset} Latency: ${data.durationMs}ms`);
          console.log(`Summary: ${data.summary}`);
          if (data.data !== undefined) {
            console.log(`${C.dim}Output Data:${C.reset}`);
            console.log(JSON.stringify(data.data, null, 2));
          }
          console.log("");
        } else {
          console.log(
            `\n${C.red}${C.bold}[TEST FAILED]${C.reset} ${data.summary ?? data.error?.message ?? res.statusText}`,
          );
          if (data.error) console.log(`${C.dim}Error: ${data.error}${C.reset}`);
          console.log("");
        }
      } catch (e) {
        console.log(`${C.red}Network error: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "mcp") {
      const [subcmd, serverId] = (arg || "").trim().split(/\s+/);
      if (subcmd === "sync") {
        if (!serverId) {
          console.log(`${C.yellow}Usage: mcp sync <serverId>${C.reset}`);
          continue;
        }
        console.log(`${C.dim}Synchronizing MCP server "${serverId}"...${C.reset}`);
        try {
          const res = await fetch(`${API_BASE}/api/v1/mcp/servers/${serverId}/sync`, {
            method: "POST",
            headers: { "X-Infuture-Locale": LOCALE },
          });
          if (res.ok) {
            const data = await res.json();
            console.log(
              `${C.green}MCP server "${data.name}" synced! Discovered ${data.toolsCount} tools.${C.reset}\n`,
            );
          } else {
            const err = await res.json().catch(() => ({}));
            console.log(`${C.red}Sync failed: ${err.error?.message ?? res.statusText}${C.reset}`);
          }
        } catch (e) {
          console.log(`${C.red}Network error: ${e.message}${C.reset}`);
        }
        continue;
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/mcp/servers`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const servers = await res.json();
        console.log(
          `\n${C.bold}Configured Model Context Protocol (MCP) Servers (${servers.length}):${C.reset}`,
        );
        for (const s of servers) {
          const status = s.enabled ? `${C.green}[ENABLED]${C.reset}` : `${C.dim}[DISABLED]${C.reset}`;
          const transport = `${C.magenta}[${s.transport.toUpperCase()}]${C.reset}`;
          console.log(`  • ${status} ${transport} ${C.cyan}${s.name}${C.reset} (id: ${s.id})`);
          if (s.command) console.log(`    Command: ${s.command} ${(s.args || []).join(" ")}`);
          if (s.url) console.log(`    URL: ${s.url}`);
          const tools = s.discoveredTools?.map((t) => t.name).join(", ") || "none";
          console.log(`    Tools (${s.discoveredTools?.length ?? 0}): [${tools}]`);
          console.log(`    Sync: ${C.yellow}mcp sync ${s.id}${C.reset}`);
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error querying MCP servers: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "memory" || cmd === "memoria") {
      const parts = (arg || "").trim().split(/\s+/);
      const subcmd = parts[0]?.toLowerCase();

      if (subcmd === "add" || subcmd === "guardar") {
        const content = parts.slice(1).join(" ").trim();
        if (!content) {
          console.log(`${C.yellow}Usage: memory add <content to remember>${C.reset}`);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Infuture-Locale": LOCALE },
            body: JSON.stringify({ content, role: "all", importance: 4 }),
          });
          if (res.ok) {
            const data = await res.json();
            console.log(`${C.green}Memory stored! id=${data.id}${C.reset}\n`);
          } else {
            console.log(`${C.red}Failed: ${res.statusText}${C.reset}`);
          }
        } catch (e) {
          console.log(`${C.red}Network error: ${e.message}${C.reset}`);
        }
        continue;
      }

      const q =
        subcmd === "search" || subcmd === "q" || subcmd === "buscar"
          ? parts.slice(1).join(" ").trim()
          : arg.trim();

      try {
        const url = q ? `${API_BASE}/api/v1/memory?q=${encodeURIComponent(q)}` : `${API_BASE}/api/v1/memory`;
        const res = await fetch(url, { headers: { "X-Infuture-Locale": LOCALE } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = await res.json();
        console.log(`\n${C.bold}Agent Memory Bank (${list.length}${q ? ` for "${q}"` : ""}):${C.reset}`);
        for (const m of list) {
          const stars = "★".repeat(m.importance) + "☆".repeat(5 - m.importance);
          const roleTag = `${C.cyan}@${m.role.padEnd(11)}${C.reset}`;
          const tags = m.tags?.length ? ` ${C.dim}[${m.tags.join(", ")}]${C.reset}` : "";
          console.log(`  • ${C.yellow}${stars}${C.reset} ${roleTag} "${m.content}"${tags}`);
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error querying memory: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "knowledge" || cmd === "conocimiento" || cmd === "rag") {
      const parts = (arg || "").trim().split(/\s+/);
      const subcmd = parts[0]?.toLowerCase();

      if (subcmd === "query" || subcmd === "q" || subcmd === "buscar") {
        const query = parts.slice(1).join(" ").trim();
        if (!query) {
          console.log(`${C.yellow}Usage: knowledge query <search question>${C.reset}`);
          continue;
        }
        try {
          console.log(`${C.dim}Querying knowledge base with RAG retrieval...${C.reset}`);
          const res = await fetch(`${API_BASE}/api/v1/knowledge/query`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Infuture-Locale": LOCALE },
            body: JSON.stringify({ query, limit: 3 }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          console.log(`\n${C.bold}RAG Search Results (${data.count}) for "${query}":${C.reset}`);
          for (const r of data.results) {
            const matchScore = `${C.green}${Math.round(r.score * 100)}% match${C.reset}`;
            console.log(`  • [${matchScore}] ${C.cyan}${r.title}${C.reset} (${r.category})`);
            console.log(`    ${C.dim}${r.text.replace(/\n/g, " ").slice(0, 200)}...${C.reset}`);
          }
          console.log("");
        } catch (e) {
          console.log(`${C.red}Query failed: ${e.message}${C.reset}`);
        }
        continue;
      }

      if (subcmd === "ingest" || subcmd === "agregar") {
        const title = parts[1];
        const content = parts.slice(2).join(" ").trim();
        if (!title || !content) {
          console.log(`${C.yellow}Usage: knowledge ingest <title> <markdown/text content>${C.reset}`);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/knowledge`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Infuture-Locale": LOCALE },
            body: JSON.stringify({ title, content, category: "general" }),
          });
          if (res.ok) {
            const doc = await res.json();
            console.log(`${C.green}Document ingested! id=${doc.id} (${doc.chunksCount} chunks)${C.reset}\n`);
          } else {
            console.log(`${C.red}Failed: ${res.statusText}${C.reset}`);
          }
        } catch (e) {
          console.log(`${C.red}Ingest error: ${e.message}${C.reset}`);
        }
        continue;
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/knowledge`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const docs = await res.json();
        console.log(`\n${C.bold}Workspace Knowledge Documents (${docs.length}):${C.reset}`);
        for (const d of docs) {
          console.log(
            `  • [${C.magenta}${d.category.toUpperCase()}${C.reset}] ${C.bold}${d.title}${C.reset} (${d.chunksCount} chunks, ~${d.totalTokensEstimate} tokens)`,
          );
          console.log(`    ${C.dim}${d.preview.replace(/\n/g, " ").slice(0, 140)}...${C.reset}`);
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error querying knowledge: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "workspaces" || cmd === "espacios") {
      const parts = (arg || "").trim().split(/\s+/);
      const subcmd = parts[0]?.toLowerCase();

      if (subcmd === "create" || subcmd === "crear") {
        const name = parts.slice(1).join(" ").trim();
        if (!name) {
          console.log(`${C.yellow}Usage: workspaces create <Workspace Name>${C.reset}`);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Infuture-Locale": LOCALE },
            body: JSON.stringify({ name, defaultLocale: LOCALE }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const ws = await res.json();
          console.log(
            `${C.green}Workspace created! id=${ws.id} name="${ws.name}" (${ws.defaultLocale})${C.reset}\n`,
          );
        } catch (e) {
          console.log(`${C.red}Error creating workspace: ${e.message}${C.reset}`);
        }
        continue;
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/workspaces`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        console.log(`\n${C.bold}Multi-tenant Workspaces (${data.workspaces.length}):${C.reset}`);
        for (const w of data.workspaces) {
          console.log(`  • ${C.cyan}${w.name}${C.reset} (id: ${w.id}) [locale: ${w.defaultLocale}]`);
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error querying workspaces: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "tokens" || cmd === "token") {
      const parts = (arg || "").trim().split(/\s+/);
      const subcmd = parts[0]?.toLowerCase();

      if (subcmd === "create" || subcmd === "crear") {
        const name = parts[1];
        const role = parts[2] || "operator";
        if (!name) {
          console.log(`${C.yellow}Usage: tokens create <token_name> [admin|operator|viewer]${C.reset}`);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Infuture-Locale": LOCALE },
            body: JSON.stringify({ name, role }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const issued = await res.json();
          console.log(`\n${C.green}${C.bold}API Token Issued Successfully!${C.reset}`);
          console.log(`  • Name:   ${issued.record.name}`);
          console.log(`  • Role:   ${issued.record.role}`);
          console.log(`  • Secret: ${C.bold}${C.yellow}${issued.token}${C.reset}`);
          console.log(`  ${C.dim}(Copy this token now. It will not be shown again.)${C.reset}\n`);
        } catch (e) {
          console.log(`${C.red}Error issuing token: ${e.message}${C.reset}`);
        }
        continue;
      }

      if (subcmd === "revoke" || subcmd === "revocar" || subcmd === "del") {
        const id = parts[1];
        if (!id) {
          console.log(`${C.yellow}Usage: tokens revoke <token_id>${C.reset}`);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/tokens/${id}`, {
            method: "DELETE",
            headers: { "X-Infuture-Locale": LOCALE },
          });
          if (res.ok) {
            console.log(`${C.green}Token ${id} revoked.${C.reset}\n`);
          } else {
            console.log(`${C.red}Failed to revoke token: ${res.statusText}${C.reset}`);
          }
        } catch (e) {
          console.log(`${C.red}Error revoking token: ${e.message}${C.reset}`);
        }
        continue;
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/tokens`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        console.log(`\n${C.bold}Active Workspace API Tokens (${data.tokens.length}):${C.reset}`);
        for (const t of data.tokens) {
          console.log(
            `  • [${C.magenta}${t.role.toUpperCase()}${C.reset}] ${C.bold}${t.name}${C.reset} (${t.tokenPrefix}) - id: ${t.id}`,
          );
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error listing tokens: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "webhooks" || cmd === "webhook") {
      const parts = (arg || "").trim().split(/\s+/);
      const subcmd = parts[0]?.toLowerCase();

      if (subcmd === "add" || subcmd === "create") {
        const url = parts[1];
        const events = parts.slice(2);
        if (!url) {
          console.log(`${C.yellow}Usage: webhooks add <https://endpoint> [event1 event2 ...]${C.reset}`);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/webhooks`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Infuture-Locale": LOCALE },
            body: JSON.stringify({ url, events: events.length > 0 ? events : ["*"] }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const wh = await res.json();
          console.log(`\n${C.green}Webhook registered! id=${wh.id}${C.reset}`);
          console.log(`  • URL:    ${wh.url}`);
          console.log(`  • Secret: ${wh.secret}`);
          console.log(`  • Events: ${wh.events.join(", ")}\n`);
        } catch (e) {
          console.log(`${C.red}Error adding webhook: ${e.message}${C.reset}`);
        }
        continue;
      }

      if (subcmd === "test" || subcmd === "ping") {
        const id = parts[1];
        if (!id) {
          console.log(`${C.yellow}Usage: webhooks test <webhook_id>${C.reset}`);
          continue;
        }
        try {
          console.log(`${C.dim}Sending HMAC-signed test ping to webhook ${id}...${C.reset}`);
          const res = await fetch(`${API_BASE}/api/v1/webhooks/${id}/test`, {
            method: "POST",
            headers: { "X-Infuture-Locale": LOCALE },
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const result = await res.json();
          if (result.success) {
            console.log(
              `${C.green}Delivery Successful! HTTP ${result.statusCode} in ${result.durationMs}ms${C.reset}\n`,
            );
          } else {
            console.log(
              `${C.red}Delivery Failed: ${result.error ?? "Unknown error"} (${result.durationMs}ms)${C.reset}\n`,
            );
          }
        } catch (e) {
          console.log(`${C.red}Test error: ${e.message}${C.reset}`);
        }
        continue;
      }

      if (subcmd === "del" || subcmd === "remove" || subcmd === "delete") {
        const id = parts[1];
        if (!id) {
          console.log(`${C.yellow}Usage: webhooks del <webhook_id>${C.reset}`);
          continue;
        }
        try {
          const res = await fetch(`${API_BASE}/api/v1/webhooks/${id}`, {
            method: "DELETE",
            headers: { "X-Infuture-Locale": LOCALE },
          });
          if (res.ok) {
            console.log(`${C.green}Webhook ${id} removed.${C.reset}\n`);
          } else {
            console.log(`${C.red}Failed: ${res.statusText}${C.reset}`);
          }
        } catch (e) {
          console.log(`${C.red}Error removing webhook: ${e.message}${C.reset}`);
        }
        continue;
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/webhooks`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        console.log(`\n${C.bold}Registered Webhooks (${data.webhooks.length}):${C.reset}`);
        for (const w of data.webhooks) {
          console.log(
            `  • [${w.enabled ? C.green + "ACTIVE" + C.reset : C.red + "DISABLED" + C.reset}] ${C.cyan}${w.url}${C.reset} (events: ${w.events.join(", ")}) - id: ${w.id}`,
          );
        }
        console.log("");
      } catch (e) {
        console.log(`${C.red}Error querying webhooks: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "analytics" || cmd === "stats") {
      try {
        const res = await fetch(`${API_BASE}/api/v1/analytics`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const a = await res.json();
        console.log(`\n${C.bold}Workspace Execution Observatory:${C.reset}`);
        console.log(`  • Total Runs:        ${a.totalRuns}`);
        console.log(
          `  • Run Breakdown:     ${C.green}${a.byStatus.done} done${C.reset}, ${C.red}${a.byStatus.failed} failed${C.reset}, ${C.yellow}${a.byStatus.cancelled} cancelled${C.reset}`,
        );
        console.log(`  • Success Rate:      ${C.green}${a.successRatePercent}%${C.reset}`);
        console.log(`  • Total Tokens:      ${a.totalTokens.toLocaleString()}`);
        console.log(`  • Total Cost:        $${a.totalCostUsd.toFixed(4)} USD`);
        console.log(`  • Avg Cost / Run:    $${a.averageCostPerRun.toFixed(4)} USD\n`);
      } catch (e) {
        console.log(`${C.red}Error querying analytics: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "artifacts" || cmd === "artefactos") {
      try {
        const res = await fetch(`${API_BASE}/api/v1/artifacts`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error("API error");
        const list = await res.json();
        if (list.length === 0) {
          console.log(`${C.yellow}No workspace artifacts found.${C.reset}`);
        } else {
          console.log(`\n${C.bold}Workspace Artifacts (${list.length}):${C.reset}`);
          for (const a of list) {
            console.log(
              `  • [${C.cyan}${a.kind.toUpperCase()}${C.reset}] ${C.bold}${a.name}${C.reset} (${a.bytes} bytes) - id: ${C.dim}${a.id.slice(0, 8)}${C.reset}`,
            );
          }
          console.log();
        }
      } catch (e) {
        console.log(`${C.red}Error fetching artifacts: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "cat" || cmd === "leer") {
      if (!arg) {
        console.log(`${C.yellow}Usage: cat <filename or artifactId>${C.reset}`);
        continue;
      }
      try {
        const res = await fetch(`${API_BASE}/api/v1/artifacts`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error("API error");
        const list = await res.json();
        const found = list.find(
          (a) => a.name.toLowerCase() === arg.toLowerCase() || a.id === arg || a.id.startsWith(arg),
        );
        if (!found || !found.content) {
          console.log(`${C.red}Artifact "${arg}" not found.${C.reset}`);
        } else {
          console.log(`\n${C.bold}=== ${found.name} (${found.kind.toUpperCase()}) ===${C.reset}`);
          console.log(found.content);
          console.log();
        }
      } catch (e) {
        console.log(`${C.red}Error reading artifact: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "schedules" || cmd === "rutinas") {
      try {
        const res = await fetch(`${API_BASE}/api/v1/schedules`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (!res.ok) throw new Error("API error");
        const list = await res.json();
        if (list.length === 0) {
          console.log(`${C.yellow}No scheduled routines configured.${C.reset}`);
        } else {
          console.log(`\n${C.bold}Scheduled Routines (${list.length}):${C.reset}`);
          for (const s of list) {
            const statusTag = s.enabled ? `${C.green}ACTIVE${C.reset}` : `${C.yellow}PAUSED${C.reset}`;
            console.log(
              `  • [${statusTag}] ${C.bold}${s.name}${C.reset} (${s.interval}, role: @${s.role}) - id: ${C.dim}${s.id}${C.reset}`,
            );
          }
          console.log();
        }
      } catch (e) {
        console.log(`${C.red}Error fetching schedules: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "trigger" || cmd === "ejecutar") {
      if (!arg) {
        console.log(`${C.yellow}Usage: trigger <scheduleId>${C.reset}`);
        continue;
      }
      try {
        const res = await fetch(`${API_BASE}/api/v1/schedules/${arg}/trigger`, {
          method: "POST",
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (res.ok) {
          const data = await res.json();
          console.log(`${C.green}Schedule "${data.name}" triggered successfully!${C.reset}`);
          if (data.dispatch) {
            console.log(`  ${C.cyan}Run dispatched: id=${data.dispatch.runId}${C.reset}\n`);
          }
        } else {
          const err = await res.json().catch(() => ({}));
          console.log(`${C.red}Failed to trigger schedule: ${err.message ?? res.statusText}${C.reset}`);
        }
      } catch (e) {
        console.log(`${C.red}Error triggering schedule: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "export" || cmd === "exportar") {
      if (!arg) {
        console.log(`${C.yellow}Usage: export <runId> [md|html|json]${C.reset}`);
        continue;
      }
      const [targetRunId, fmt = "md"] = arg.split(" ");
      const format = fmt === "html" ? "html" : fmt === "json" ? "json" : "markdown";
      try {
        const res = await fetch(`${API_BASE}/api/v1/runs/${targetRunId}/export?format=${format}`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        if (res.ok) {
          const text = await res.text();
          console.log(
            `\n${C.bold}=== RUN DOSSIER: ${targetRunId.slice(0, 8)} (${format.toUpperCase()}) ===${C.reset}`,
          );
          console.log(
            text.slice(0, 2000) +
              (text.length > 2000 ? `\n${C.dim}... (truncated for terminal display)${C.reset}` : ""),
          );
          console.log();
        } else {
          console.log(`${C.red}Failed to export run ${targetRunId}: ${res.statusText}${C.reset}`);
        }
      } catch (e) {
        console.log(`${C.red}Error exporting run: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "steer" || cmd === "guiar") {
      const firstSpace = arg.indexOf(" ");
      if (!arg || firstSpace === -1) {
        console.log(`${C.yellow}Usage: steer <runId> <instruction here>${C.reset}`);
        continue;
      }
      const targetRunId = arg.slice(0, firstSpace).trim();
      const instruction = arg.slice(firstSpace + 1).trim();
      console.log(`${C.dim}Steering run ${targetRunId} with instruction: "${instruction}"...${C.reset}`);
      try {
        const res = await fetch(`${API_BASE}/api/v1/runs/${targetRunId}/feedback`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Infuture-Locale": LOCALE,
          },
          body: JSON.stringify({ prompt: instruction }),
        });
        if (res.ok) {
          const data = await res.json();
          console.log(`${C.green}Run ${targetRunId} successfully steered! Deliverable updated.${C.reset}`);
          if (data.output) {
            console.log(`\n${C.bold}Updated Deliverable Preview:${C.reset}`);
            console.log(String(data.output).slice(-600));
            console.log();
          }
        } else {
          const err = await res.json().catch(() => ({}));
          console.log(`${C.red}Failed to steer run: ${err.message ?? res.statusText}${C.reset}`);
        }
      } catch (e) {
        console.log(`${C.red}Error steering run: ${e.message}${C.reset}`);
      }
      continue;
    }

    if (cmd === "run" || cmd === "team" || cmd === "ask") {
      if (!arg) {
        console.log(`${C.yellow}Please provide a goal. Example: ${cmd} Build a REST microservice${C.reset}`);
        continue;
      }

      const isMultiagent = cmd === "team";
      const role = cmd === "ask" ? "receptionist" : "supervisor";

      console.log(
        `${C.dim}Dispatching ${cmd === "team" ? "multi-agent team" : role} for: "${arg}"...${C.reset}`,
      );

      try {
        // Find healthy connection
        const connRes = await fetch(`${API_BASE}/api/v1/connections`, {
          headers: { "X-Infuture-Locale": LOCALE },
        });
        const conns = connRes.ok ? await connRes.json() : [];
        const healthy = conns.find((c) => c.status === "healthy") ?? conns[0];

        if (!healthy) {
          console.log(
            `${C.red}No provider connections available. Connect OpenAI, Anthropic, Groq or Ollama first.${C.reset}`,
          );
          continue;
        }

        const runRes = await fetch(`${API_BASE}/api/v1/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Infuture-Locale": LOCALE,
          },
          body: JSON.stringify({
            goal: arg,
            role,
            connectionId: healthy.id,
            multiagent: isMultiagent,
          }),
        });

        if (!runRes.ok) {
          const err = await runRes.json().catch(() => ({}));
          console.log(`${C.red}Dispatch failed: ${err.message ?? runRes.statusText}${C.reset}`);
          continue;
        }

        const result = await runRes.json();
        console.log(`${C.green}Run dispatched! id=${result.id}${C.reset}\n`);
      } catch (e) {
        console.log(`${C.red}Network error: ${e.message}${C.reset}`);
      }
      continue;
    }

    console.log(`${C.red}Unknown command: "${cmd}". Type 'help' for command list.${C.reset}`);
  }
}

main().catch(console.error);
