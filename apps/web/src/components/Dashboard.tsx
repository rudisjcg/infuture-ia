import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCurrency, formatDateTime, formatNumber } from "@infuture/i18n";
import { eventLabelKey, type CCEvent, type EventType } from "@infuture/events";
import { useLocale } from "../i18n";

type RoleId =
  | "supervisor"
  | "researcher"
  | "analyst"
  | "developer"
  | "writer"
  | "reviewer"
  | "receptionist"
  | string;

const DEFAULT_ROLES_LIST: Array<{ id: string; nameKey: string; color: string }> = [
  { id: "supervisor", nameKey: "roles.supervisor.name", color: "var(--accent)" },
  { id: "researcher", nameKey: "roles.researcher.name", color: "var(--sky)" },
  { id: "analyst", nameKey: "roles.analyst.name", color: "var(--ok)" },
  { id: "developer", nameKey: "roles.developer.name", color: "var(--warn)" },
  { id: "writer", nameKey: "roles.writer.name", color: "var(--pink)" },
  { id: "reviewer", nameKey: "roles.reviewer.name", color: "var(--coral)" },
  { id: "receptionist", nameKey: "roles.receptionist.name", color: "#2dd4bf" },
];

const ROLE_COLORS: Record<string, string> = {
  supervisor: "var(--accent)",
  researcher: "var(--sky)",
  analyst: "var(--ok)",
  developer: "var(--warn)",
  writer: "var(--pink)",
  reviewer: "var(--coral)",
  receptionist: "#2dd4bf",
};

type EventCategory = "all" | "thoughts" | "tools" | "board" | "llm" | "watchdog" | "approvals";

type Recipe = {
  id: string;
  name: string;
  description: string;
  goal: string;
  defaultRole: string;
  multiagent: boolean;
  tags: string[];
};

type ConnectionOption = {
  id: string;
  providerId: string;
  alias: string;
  status: string;
  models: string[];
};

type Run = {
  id: string;
  workspaceId: string;
  goal: string;
  locale: string;
  status: "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";
  output?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs?: number;
  startedAt: string;
  endedAt: string | null;
  tasks?: Array<{ taskId: string; role: RoleId; title: string; output: string; status: string }>;
  reviews?: Array<{
    reviewId: string;
    round: number;
    verdict: "approve" | "request_changes" | "reject";
    critique?: string;
  }>;
  boardPosts?: Array<{ postId: string; topic: string; kind: string; content: string }>;
};

export function Dashboard() {
  const { t } = useTranslation();
  const locale = useLocale();

  // Launcher state
  const [goal, setGoal] = useState("");
  const [selectedRole, setSelectedRole] = useState<RoleId>("supervisor");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string>("");
  const [availableRoles, setAvailableRoles] = useState<Array<{ id: string; name: string; color?: string }>>(
    [],
  );
  const [multiagent, setMultiagent] = useState(true);
  const [connections, setConnections] = useState<ConnectionOption[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // Active run & events
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<CCEvent[]>([]);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [socketConnected, setSocketConnected] = useState(false);

  // Event stream filtering
  const [eventCategory, setEventCategory] = useState<EventCategory>("all");
  const [eventSearch, setEventSearch] = useState<string>("");

  const socketRef = useRef<WebSocket | null>(null);
  const streamEndRef = useRef<HTMLDivElement | null>(null);

  const loadEventsForRun = useCallback(
    async (runId: string) => {
      try {
        const res = await fetch(`/api/v1/runs/${runId}/events`, {
          headers: { "X-Infuture-Locale": locale },
        });
        if (res.ok) {
          const data = (await res.json()) as CCEvent[];
          setEvents(data);
        }
      } catch {
        // Ignore fetch errors
      }
    },
    [locale],
  );

  // Fetch connections, recent runs, available roles, and recipes
  const loadInitialData = useCallback(async () => {
    try {
      const headers = { "X-Infuture-Locale": locale };
      const [connRes, runsRes, rolesRes, recipesRes] = await Promise.all([
        fetch("/api/v1/connections", { headers }),
        fetch("/api/v1/runs", { headers }),
        fetch("/api/v1/roles", { headers }),
        fetch("/api/v1/recipes", { headers }),
      ]);

      if (recipesRes.ok) {
        const recipesData = (await recipesRes.json()) as Recipe[];
        setRecipes(recipesData);
      }

      if (rolesRes.ok) {
        const rolesData = (await rolesRes.json()) as Array<{
          id: string;
          name: string;
          prefers?: { color?: string };
        }>;
        setAvailableRoles(
          rolesData.map((r) => ({
            id: r.id,
            name: r.name,
            color: r.prefers?.color ?? ROLE_COLORS[r.id] ?? "var(--accent)",
          })),
        );
      }

      if (connRes.ok) {
        const connData = (await connRes.json()) as ConnectionOption[];
        setConnections(connData);
        if (connData.length > 0 && !selectedConnectionId) {
          const healthy = connData.find((c) => c.status === "healthy");
          setSelectedConnectionId(healthy?.id ?? connData[0]?.id ?? "");
        }
      }

      if (runsRes.ok) {
        const runsData = (await runsRes.json()) as Run[];
        setRecentRuns(runsData);
        if (runsData.length > 0 && !activeRun) {
          setActiveRun(runsData[0] ?? null);
          // Load events for the latest run
          void loadEventsForRun(runsData[0]!.id);
        }
      }
    } catch {
      // Ignore initial fetch errors
    }
  }, [locale, selectedConnectionId, activeRun, loadEventsForRun]);

  useEffect(() => {
    void loadInitialData();
  }, [loadInitialData]);

  // WebSocket live connection
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/api/v1/realtime`;

    let ws: WebSocket | null = null;
    let pingInterval: number | undefined;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      socketRef.current = ws;

      ws.onopen = () => {
        setSocketConnected(true);
        // Subscribe to workspace
        ws?.send(JSON.stringify({ op: "subscribe", topics: ["workspace"] }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.op === "event" && msg.event) {
            const ev = msg.event as CCEvent;
            setEvents((prev) => [...prev, ev]);

            // If active run matches, update live metrics
            if (ev.type === "usage.updated" && ev.payload) {
              const p = ev.payload as { tokensIn: number; tokensOut: number; costUsd: number };
              setActiveRun((curr) =>
                curr
                  ? {
                      ...curr,
                      tokensIn: p.tokensIn,
                      tokensOut: p.tokensOut,
                      costUsd: p.costUsd,
                    }
                  : null,
              );
            } else if (ev.type === "llm.message.completed" && ev.payload) {
              const p = ev.payload as { text: string };
              setActiveRun((curr) => (curr ? { ...curr, output: p.text } : null));
            } else if (ev.type === "run.completed" && ev.payload) {
              const p = ev.payload as { status: Run["status"]; durationMs: number };
              setActiveRun((curr) =>
                curr
                  ? { ...curr, status: p.status, durationMs: p.durationMs, endedAt: new Date().toISOString() }
                  : null,
              );
            }
          } else if (msg.op === "batch" && Array.isArray(msg.events)) {
            setEvents((prev) => [...prev, ...(msg.events as CCEvent[])]);
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

      pingInterval = window.setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: "ping" }));
        }
      }, 25_000);
    };

    connect();

    return () => {
      clearInterval(pingInterval);
      ws?.close();
    };
  }, []);

  // Auto-scroll event stream to bottom on new event
  useEffect(() => {
    streamEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events]);

  const handleLaunch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;

    setLaunching(true);
    setLaunchError(null);

    try {
      const payload: {
        goal: string;
        role: string;
        connectionId?: string;
        locale: string;
        multiagent: boolean;
      } = {
        goal: goal.trim(),
        role: selectedRole,
        locale,
        multiagent,
      };

      if (selectedConnectionId) {
        payload.connectionId = selectedConnectionId;
      }

      const res = await fetch("/api/v1/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || "Failed to launch run");
      }

      const newRun = data as Run;
      setActiveRun(newRun);
      setRecentRuns((prev) => [newRun, ...prev.filter((r) => r.id !== newRun.id)]);
      setGoal("");
    } catch (err: unknown) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  };

  const handleSelectRun = (run: Run) => {
    setActiveRun(run);
    void loadEventsForRun(run.id);
  };

  const renderEventDetails = (ev: CCEvent) => {
    const payload = ev.payload as Record<string, unknown>;

    switch (ev.type) {
      case "agent.thought":
        return <blockquote className="thought-quote">“{String(payload.text)}”</blockquote>;
      case "llm.request.started":
        return (
          <span className="small muted">
            {String(payload.providerId)} · {String(payload.model)} ({Number(payload.messages)} messages)
          </span>
        );
      case "llm.message.completed":
        return (
          <div className="event-metrics small mono">
            <span>+{Number(payload.tokensIn)} in</span>
            <span>+{Number(payload.tokensOut)} out</span>
            <span>{formatCurrency(locale, Number(payload.costUsd))}</span>
            <span>{Number(payload.latencyMs)}ms</span>
          </div>
        );
      case "worker.status_changed":
        return (
          <span className="small">
            <strong className="status-badge">{String(payload.status)}</strong>{" "}
            {payload.activity ? `— ${String(payload.activity)}` : ""}
          </span>
        );
      case "board.posted":
        return (
          <div className="board-post-event">
            <span className={`board-kind-badge kind-${String(payload.kind)}`}>
              {String(payload.kind).toUpperCase()}
            </span>
            <span className="small"> “{String(payload.content)}”</span>
          </div>
        );
      case "review.requested":
        return <span className="small muted">🔍 Audit requested (Round {Number(payload.round)})</span>;
      case "review.completed":
        return (
          <div className="review-completed-event">
            <span className={`verdict-badge verdict-${String(payload.verdict)}`}>
              {String(payload.verdict).toUpperCase()}
            </span>
            {payload.critique ? (
              <span className="small muted"> — {String(payload.critique).slice(0, 150)}…</span>
            ) : (
              ""
            )}
          </div>
        );
      case "task.created":
        return (
          <span className="small">
            📋 Task created: <strong>{String(payload.title)}</strong>
          </span>
        );
      case "task.assigned":
        return (
          <span className="small">
            👤 Assigned to <strong>{String(payload.role)}</strong>
          </span>
        );
      case "task.status_changed":
        return <span className="small muted">Status: {String(payload.status)}</span>;
      case "run.completed":
        return (
          <span className="small">
            Finished with status <strong>{String(payload.status)}</strong> in {Number(payload.durationMs)}ms
          </span>
        );
      case "connection.health_changed":
        return (
          <span className="small">
            {String(payload.providerId)} status changed to <strong>{String(payload.status)}</strong>
          </span>
        );
      default:
        return <span className="small muted">{JSON.stringify(payload)}</span>;
    }
  };

  const categoryCounts: Record<EventCategory, number> = {
    all: events.length,
    thoughts: events.filter((e) => e.type === "agent.thought").length,
    tools: events.filter((e) => e.type.startsWith("tool.call.")).length,
    board: events.filter((e) => e.type === "board.posted").length,
    llm: events.filter((e) => e.type.startsWith("llm.")).length,
    watchdog: events.filter(
      (e) => e.type.startsWith("worker.") || e.type.startsWith("task.") || e.type.startsWith("review."),
    ).length,
    approvals: events.filter((e) => e.type.startsWith("approval.")).length,
  };

  const filteredEvents = events.filter((ev) => {
    if (eventCategory === "thoughts" && ev.type !== "agent.thought") return false;
    if (eventCategory === "tools" && !ev.type.startsWith("tool.call.")) return false;
    if (eventCategory === "board" && ev.type !== "board.posted") return false;
    if (eventCategory === "llm" && !ev.type.startsWith("llm.")) return false;
    if (
      eventCategory === "watchdog" &&
      !ev.type.startsWith("worker.") &&
      !ev.type.startsWith("task.") &&
      !ev.type.startsWith("review.")
    )
      return false;
    if (eventCategory === "approvals" && !ev.type.startsWith("approval.")) return false;

    if (eventSearch.trim()) {
      const q = eventSearch.trim().toLowerCase();
      const inType = ev.type.toLowerCase().includes(q);
      const inPayload = JSON.stringify(ev.payload ?? {})
        .toLowerCase()
        .includes(q);
      if (!inType && !inPayload) return false;
    }
    return true;
  });

  return (
    <div className="dashboard-view">
      {/* Launch Agent Card */}
      <section className="card card-wide launcher-card" aria-labelledby="launcher-title">
        <div className="card-head">
          <div>
            <h2 id="launcher-title">{t("dashboard.launchTitle")}</h2>
            <p className="muted">{t("dashboard.launchSubtitle")}</p>
          </div>
          <span className={`pill ${socketConnected ? "pill-online" : "pill-offline"}`}>
            <span className="pill-dot" aria-hidden="true" />
            {socketConnected ? t("dashboard.livePill") : t("dashboard.disconnectedPill")}
          </span>
        </div>

        {launchError && <div className="form-error-banner">{launchError}</div>}

        <form onSubmit={handleLaunch} className="launcher-form">
          {recipes.length > 0 && (
            <div className="recipes-bar" style={{ marginBottom: "12px" }}>
              <div style={{ marginBottom: "6px" }}>
                <span className="small muted">
                  <strong>⚡ {t("dashboard.recipesTitle")}</strong>: {t("dashboard.recipesHint")}
                </span>
              </div>
              <div className="filter-chips">
                {recipes.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="chip"
                    onClick={() => {
                      setGoal(r.goal);
                      setSelectedRole(r.defaultRole);
                      setMultiagent(r.multiagent);
                    }}
                    title={r.description}
                  >
                    ✨ {r.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="form-group form-group-full">
            <label htmlFor="goal-input">{t("dashboard.goal")}</label>
            <textarea
              id="goal-input"
              className="input textarea"
              rows={3}
              placeholder={t("dashboard.goalPlaceholder")}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              required
            />
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label htmlFor="role-select" style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <span
                  className="role-dot"
                  style={{
                    background: ROLE_COLORS[selectedRole] ?? "var(--accent)",
                    width: "8px",
                    height: "8px",
                    margin: 0,
                  }}
                  aria-hidden="true"
                />
                {t("dashboard.role")}
              </label>
              <select
                id="role-select"
                className="input select"
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as RoleId)}
              >
                {(availableRoles.length > 0
                  ? availableRoles.map((r) => ({ id: r.id, label: r.name }))
                  : DEFAULT_ROLES_LIST.map((r) => ({ id: r.id, label: r.id }))
                ).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label htmlFor="conn-select">{t("dashboard.connection")}</label>
              <select
                id="conn-select"
                className="input select"
                value={selectedConnectionId}
                onChange={(e) => setSelectedConnectionId(e.target.value)}
              >
                {connections.length === 0 ? (
                  <option value="">{t("dashboard.defaultConnection")}</option>
                ) : (
                  connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.alias} ({c.providerId}) {c.models[0] ? `— ${c.models[0]}` : ""}
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          <div className="form-checkbox-group" style={{ margin: "4px 0" }}>
            <label className="checkbox-label">
              <input type="checkbox" checked={multiagent} onChange={(e) => setMultiagent(e.target.checked)} />
              <span>
                <strong>{t("dashboard.multiagent")}</strong>
              </span>
            </label>
            <p className="small muted" style={{ margin: "4px 0 0 24px" }}>
              {t("dashboard.multiagentHint")}
            </p>
          </div>

          <div className="launcher-actions">
            <button type="submit" className="btn" disabled={launching || !goal.trim()}>
              {launching ? t("dashboard.launching") : `⚡ ${t("dashboard.launchButton")}`}
            </button>
          </div>
        </form>
      </section>

      {/* Grid: Active Run Summary & Event Stream */}
      <div className="dashboard-grid">
        {/* Left column: Active Run & Recent Runs */}
        <div className="dashboard-sidebar">
          {activeRun && (
            <section className="card active-run-card" aria-labelledby="active-run-title">
              <div className="card-head">
                <h3 id="active-run-title">{t("dashboard.activeRun")}</h3>
                <span
                  className={`pill pill-${activeRun.status === "done" ? "healthy" : activeRun.status === "running" ? "online" : "invalid"}`}
                >
                  <span className="pill-dot" aria-hidden="true" />
                  {t(
                    `status.${activeRun.status === "running" ? "thinking" : activeRun.status === "done" ? "done" : "error"}`,
                  )}
                </span>
              </div>

              <p className="active-run-goal">{activeRun.goal}</p>

              <dl className="figures active-run-figures">
                <div>
                  <dt>{t("dashboard.tokensIn")}</dt>
                  <dd className="mono">{formatNumber(locale, activeRun.tokensIn)}</dd>
                </div>
                <div>
                  <dt>{t("dashboard.tokensOut")}</dt>
                  <dd className="mono">{formatNumber(locale, activeRun.tokensOut)}</dd>
                </div>
                <div>
                  <dt>{t("dashboard.cost")}</dt>
                  <dd className="mono">{formatCurrency(locale, activeRun.costUsd)}</dd>
                </div>
                {activeRun.durationMs !== undefined && (
                  <div>
                    <dt>{t("dashboard.duration")}</dt>
                    <dd className="mono">{(activeRun.durationMs / 1000).toFixed(2)}s</dd>
                  </div>
                )}
              </dl>

              {/* Visual Token Distribution Ratio Bar */}
              {(activeRun.tokensIn > 0 || activeRun.tokensOut > 0) && (
                <div
                  className="token-ratio-bar-container"
                  style={{
                    margin: "12px 0",
                    background: "var(--surface-2)",
                    borderRadius: "6px",
                    padding: "8px 10px",
                    border: "1px solid var(--line)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "11px",
                      color: "var(--muted)",
                      marginBottom: "4px",
                    }}
                  >
                    <span>
                      Prompt:{" "}
                      {Math.round((activeRun.tokensIn / (activeRun.tokensIn + activeRun.tokensOut)) * 100)}%
                    </span>
                    <span>
                      Completion:{" "}
                      {Math.round((activeRun.tokensOut / (activeRun.tokensIn + activeRun.tokensOut)) * 100)}%
                    </span>
                  </div>
                  <div
                    style={{
                      height: "6px",
                      width: "100%",
                      borderRadius: "3px",
                      overflow: "hidden",
                      display: "flex",
                      background: "rgba(255,255,255,0.05)",
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.round((activeRun.tokensIn / (activeRun.tokensIn + activeRun.tokensOut)) * 100)}%`,
                        background: "var(--sky)",
                        transition: "width 0.3s ease",
                      }}
                      title={`Tokens In: ${activeRun.tokensIn}`}
                    />
                    <div
                      style={{
                        width: `${Math.round((activeRun.tokensOut / (activeRun.tokensIn + activeRun.tokensOut)) * 100)}%`,
                        background: "var(--accent)",
                        transition: "width 0.3s ease",
                      }}
                      title={`Tokens Out: ${activeRun.tokensOut}`}
                    />
                  </div>
                </div>
              )}

              {activeRun.tasks && activeRun.tasks.length > 0 && (
                <div className="active-run-subtasks">
                  <h4>{t("dashboard.subtasks", { count: activeRun.tasks.length })}</h4>
                  <ul className="subtasks-list">
                    {activeRun.tasks.map((task) => (
                      <li key={task.taskId} className="subtask-item">
                        <span
                          className="role-dot"
                          style={{ background: ROLE_COLORS[task.role] || "var(--accent)" }}
                          aria-hidden="true"
                        />
                        <div className="subtask-text">
                          <span className="subtask-role mono small">{task.role}</span>
                          <span className="subtask-title">{task.title}</span>
                        </div>
                        <span
                          className={`pill pill-sm pill-${task.status === "done" ? "healthy" : "invalid"}`}
                        >
                          {task.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {activeRun.reviews && activeRun.reviews.length > 0 && (
                <div className="active-run-review">
                  <h4>{t("dashboard.reviewAudit")}</h4>
                  {activeRun.reviews.map((rev) => (
                    <div key={rev.reviewId} className="review-card">
                      <div className="review-header">
                        <span className={`verdict-badge verdict-${rev.verdict}`}>
                          {rev.verdict.toUpperCase()}
                        </span>
                        <span className="small muted">Round {rev.round}</span>
                      </div>
                      {rev.critique && <p className="review-critique small">{rev.critique}</p>}
                    </div>
                  ))}
                </div>
              )}

              {activeRun.boardPosts && activeRun.boardPosts.length > 0 && (
                <div className="active-run-board">
                  <h4>{t("dashboard.teamBoard")}</h4>
                  <div className="board-posts-grid">
                    {activeRun.boardPosts.map((post) => (
                      <div key={post.postId} className="board-post-card">
                        <span className={`board-kind-badge kind-${post.kind}`}>
                          {post.kind.toUpperCase()}
                        </span>
                        <p className="board-post-content small">“{post.content}”</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeRun.output && (
                <div className="active-run-output">
                  <h4>{t("dashboard.output")}</h4>
                  <div className="output-content">{activeRun.output}</div>
                </div>
              )}
            </section>
          )}

          {/* Recent Runs list */}
          <section className="card recent-runs-card" aria-labelledby="recent-runs-title">
            <div className="card-head">
              <h3 id="recent-runs-title">{t("dashboard.recentRuns")}</h3>
            </div>
            {recentRuns.length === 0 ? (
              <p className="small muted">{t("dashboard.noRuns")}</p>
            ) : (
              <ul className="recent-runs-list">
                {recentRuns.map((r) => {
                  const isSelected = activeRun?.id === r.id;
                  return (
                    <li
                      key={r.id}
                      className={`recent-run-item ${isSelected ? "selected" : ""}`}
                      onClick={() => handleSelectRun(r)}
                    >
                      <div className="recent-run-info">
                        <span className="recent-run-goal truncate" title={r.goal}>
                          {r.goal}
                        </span>
                        <span className="small muted">
                          {formatDateTime(locale, r.startedAt)} · {formatCurrency(locale, r.costUsd)}
                        </span>
                      </div>
                      <span className={`pill pill-sm pill-${r.status === "done" ? "healthy" : "invalid"}`}>
                        {r.status}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        {/* Right column: Live Event Stream */}
        <section className="card card-wide live-stream-card" aria-labelledby="stream-title">
          <div className="card-head">
            <div className="stream-title-group">
              <h3 id="stream-title">{t("dashboard.liveStreamTitle")}</h3>
              <span className="badge mono small">{events.length}</span>
            </div>
            <button
              type="button"
              className="btn-ghost small"
              onClick={() => setEvents([])}
              title={t("dashboard.clearEvents")}
            >
              {t("dashboard.clearEvents")}
            </button>
          </div>

          {/* Stream Filter Toolbar */}
          <div
            className="stream-filter-toolbar"
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              flexWrap: "wrap",
              gap: "8px",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div className="filter-chips">
              {(
                [
                  { id: "all", labelKey: "dashboard.filterAll" },
                  { id: "thoughts", labelKey: "dashboard.filterThoughts" },
                  { id: "tools", labelKey: "dashboard.filterTools" },
                  { id: "board", labelKey: "dashboard.filterBoard" },
                  { id: "llm", labelKey: "dashboard.filterLlm" },
                  { id: "watchdog", labelKey: "dashboard.filterWatchdog" },
                  { id: "approvals", labelKey: "dashboard.filterApprovals" },
                ] as const
              ).map((cat) => (
                <button
                  key={cat.id}
                  type="button"
                  className={`chip ${eventCategory === cat.id ? "is-active" : ""}`}
                  onClick={() => setEventCategory(cat.id)}
                >
                  {t(cat.labelKey)}{" "}
                  <span className="mono small" style={{ opacity: 0.8 }}>
                    ({categoryCounts[cat.id]})
                  </span>
                </button>
              ))}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <input
                type="text"
                className="input small"
                style={{ width: "160px", padding: "4px 8px", fontSize: "11px" }}
                placeholder={t("dashboard.filterSearch")}
                value={eventSearch}
                onChange={(e) => setEventSearch(e.target.value)}
              />
              {(eventCategory !== "all" || eventSearch.trim()) && (
                <span className="small muted">
                  {t("dashboard.filteredEvents", {
                    showing: filteredEvents.length,
                    total: events.length,
                  })}
                </span>
              )}
            </div>
          </div>

          <div className="event-stream-container">
            {events.length === 0 ? (
              <div className="stream-empty">
                <span className="stream-empty-icon" aria-hidden="true">
                  📡
                </span>
                <p className="muted small">{t("dashboard.noEventsYet")}</p>
              </div>
            ) : filteredEvents.length === 0 ? (
              <div className="stream-empty">
                <span className="stream-empty-icon" aria-hidden="true">
                  🔍
                </span>
                <p className="muted small">{t("dashboard.noEventsYet")}</p>
                <button
                  type="button"
                  className="btn-tiny"
                  onClick={() => {
                    setEventCategory("all");
                    setEventSearch("");
                  }}
                  style={{ marginTop: "8px" }}
                >
                  {t("dashboard.filterAll")}
                </button>
              </div>
            ) : (
              <div className="stream-items">
                {filteredEvents.map((ev, index) => {
                  const time = new Date(ev.ts).toLocaleTimeString();
                  return (
                    <div key={`${ev.id}-${index}`} className="stream-item">
                      <div className="stream-item-header">
                        <span className="stream-time mono">{time}</span>
                        <span className={`event-type-badge event-type-${ev.type.replace(/\./g, "-")}`}>
                          {t(eventLabelKey(ev.type as EventType))}
                        </span>
                        <span className="stream-seq mono small">#{ev.seq}</span>
                      </div>
                      <div className="stream-item-body">{renderEventDetails(ev)}</div>
                    </div>
                  );
                })}
                <div ref={streamEndRef} />
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
