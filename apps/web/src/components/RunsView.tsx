import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCurrency, formatDateTime, formatNumber } from "@infuture/i18n";
import { eventLabelKey, type CCEvent, type EventType } from "@infuture/events";
import { useLocale } from "../i18n";

type RunStatus = "all" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";

type RunRecord = {
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
  tasks?: Array<{ id: string; role?: string; title: string; output: unknown; status: string }>;
};

type ApprovalRecord = {
  id: string;
  runId: string;
  taskId?: string;
  action: string;
  detail: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string | null;
  note?: string;
  createdAt: string;
};

type AnalyticsData = {
  totalRuns: number;
  totalTokens: number;
  totalCostUsd: number;
  successRatePercent: number;
  byStatus: Record<string, number>;
};

const FILTER_KEYS = {
  all: "runsView.filterAll",
  running: "runsView.filterRunning",
  waiting_approval: "runsView.filterPending",
  done: "runsView.filterDone",
  failed: "runsView.filterFailed",
  cancelled: "runsView.filterCancelled",
} as const;

export function RunsView() {
  const { t } = useTranslation();
  const locale = useLocale();

  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunEvents, setSelectedRunEvents] = useState<CCEvent[]>([]);
  const [filter, setFilter] = useState<RunStatus>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [copiedOutput, setCopiedOutput] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<{
    id: string;
    name: string;
    kind: string;
    content?: string;
  } | null>(null);

  // Steer & Human Follow-up states
  const [steerPrompt, setSteerPrompt] = useState("");
  const [steerRole, setSteerRole] = useState("supervisor");
  const [isSteering, setIsSteering] = useState(false);
  const [steerSuccessMsg, setSteerSuccessMsg] = useState(false);

  const fetchRunsAndApprovals = useCallback(async () => {
    try {
      const headers = { "X-Infuture-Locale": locale };
      const [runsRes, appRes, analyticsRes] = await Promise.all([
        fetch("/api/v1/runs", { headers }),
        fetch("/api/v1/approvals", { headers }),
        fetch("/api/v1/analytics", { headers }),
      ]);

      if (runsRes.ok) {
        const data = (await runsRes.json()) as RunRecord[];
        setRuns(data);
        if (data.length > 0 && !selectedRunId) {
          setSelectedRunId(data[0]?.id ?? null);
        }
      }
      if (appRes.ok) {
        const appData = (await appRes.json()) as ApprovalRecord[];
        setApprovals(appData);
      }
      if (analyticsRes.ok) {
        const aData = (await analyticsRes.json()) as AnalyticsData;
        setAnalytics(aData);
      }
    } finally {
      setLoading(false);
    }
  }, [locale, selectedRunId]);

  useEffect(() => {
    void fetchRunsAndApprovals();
  }, [fetchRunsAndApprovals]);

  // Load events for selected run
  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunEvents([]);
      return;
    }
    const loadEvents = async () => {
      try {
        const res = await fetch(`/api/v1/runs/${selectedRunId}/events`, {
          headers: { "X-Infuture-Locale": locale },
        });
        if (res.ok) {
          const evData = (await res.json()) as CCEvent[];
          setSelectedRunEvents(evData);
        }
      } catch {
        // Ignore fetch errors
      }
    };
    void loadEvents();
  }, [selectedRunId, locale]);

  // Listen to WebSocket events live
  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const ws = new WebSocket(`${protocol}//${host}/api/v1/realtime`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: "subscribe", topics: ["workspace"] }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.op === "event" && msg.event) {
          const ev = msg.event as CCEvent;
          if (ev.runId === selectedRunId) {
            setSelectedRunEvents((prev) => [...prev, ev]);
          }
          if (ev.type === "approval.requested" || ev.type === "approval.resolved") {
            void fetchRunsAndApprovals();
          }
          if (ev.type === "run.created" || ev.type === "run.completed") {
            void fetchRunsAndApprovals();
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    return () => {
      ws.close();
    };
  }, [selectedRunId, fetchRunsAndApprovals]);

  // Resolve approval
  const handleResolveApproval = async (approvalId: string, decision: "approved" | "rejected") => {
    setResolvingId(approvalId);
    try {
      const res = await fetch(`/api/v1/approvals/${approvalId}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify({ decision, note: `Decided via command center web UI` }),
      });
      if (res.ok) {
        await fetchRunsAndApprovals();
      }
    } finally {
      setResolvingId(null);
    }
  };

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? runs[0];

  const filteredRuns = runs.filter((r) => {
    if (filter !== "all" && r.status !== filter) return false;
    if (search && !r.goal.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const pendingApprovals = approvals.filter((a) => a.status === "pending");

  // Extract watchdog alerts and tool calls from events
  const watchdogAlerts = selectedRunEvents.filter((e) => e.type === "watchdog.alert");
  const toolStartedEvents = selectedRunEvents.filter((e) => e.type === "tool.call.started");
  const toolCompletedEvents = selectedRunEvents.filter((e) => e.type === "tool.call.completed");
  const artifactEvents = selectedRunEvents.filter((e) => e.type === "artifact.created");

  const downloadArtifact = (name: string, content?: string, kind = "text") => {
    if (!content) return;
    const mime = kind === "json" ? "application/json" : kind === "markdown" ? "text/markdown" : "text/plain";
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadExport = (format: "markdown" | "html" | "json") => {
    if (!selectedRunId) return;
    const url = `/api/v1/runs/${selectedRunId}/export?format=${format}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `infuture-run-${selectedRunId.slice(0, 8)}.${format === "markdown" ? "md" : format}`;
    a.click();
  };

  const handleSteerRun = async () => {
    if (!selectedRunId || !steerPrompt.trim() || isSteering) return;
    setIsSteering(true);
    try {
      const res = await fetch(`/api/v1/runs/${selectedRunId}/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify({
          prompt: steerPrompt.trim(),
          role: steerRole,
        }),
      });
      if (res.ok) {
        const updated = (await res.json()) as RunRecord;
        setRuns((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
        setSteerPrompt("");
        setSteerSuccessMsg(true);
        setTimeout(() => setSteerSuccessMsg(false), 3000);

        const evRes = await fetch(`/api/v1/runs/${selectedRunId}/events`, {
          headers: { "X-Infuture-Locale": locale },
        });
        if (evRes.ok) {
          const evData = (await evRes.json()) as CCEvent[];
          setSelectedRunEvents(evData);
        }
      }
    } catch {
      // ignore
    } finally {
      setIsSteering(false);
    }
  };

  const handleCancelRun = async (runId: string) => {
    try {
      setCancellingId(runId);
      const res = await fetch(`/api/v1/runs/${runId}/cancel`, {
        method: "POST",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        await fetchRunsAndApprovals();
      }
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="runs-view">
      {/* Header */}
      <section className="section-header">
        <div>
          <h2>{t("runsView.title")}</h2>
          <p className="muted">{t("runsView.subtitle")}</p>
        </div>
      </section>

      {/* Observatory KPI Summary */}
      {analytics && (
        <section className="observatory-kpi-grid">
          <div className="kpi-card card">
            <span className="kpi-label muted small">{t("runsView.observatory")}</span>
            <span className="kpi-value mono" style={{ fontSize: "20px", fontWeight: "bold" }}>
              {analytics.totalRuns}
            </span>
          </div>
          <div className="kpi-card card">
            <span className="kpi-label muted small">{t("runsView.successRate")}</span>
            <span
              className="kpi-value mono"
              style={{ fontSize: "20px", fontWeight: "bold", color: "var(--ok)" }}
            >
              {analytics.successRatePercent}%
            </span>
          </div>
          <div className="kpi-card card">
            <span className="kpi-label muted small">{t("runsView.totalTokens")}</span>
            <span className="kpi-value mono" style={{ fontSize: "20px", fontWeight: "bold" }}>
              {formatNumber(locale, analytics.totalTokens)}
            </span>
          </div>
          <div className="kpi-card card">
            <span className="kpi-label muted small">{t("runsView.totalCost")}</span>
            <span
              className="kpi-value mono"
              style={{ fontSize: "20px", fontWeight: "bold", color: "var(--warn)" }}
            >
              {formatCurrency(locale, analytics.totalCostUsd)}
            </span>
          </div>
        </section>
      )}

      {/* Pending Human Approvals Banner */}
      {pendingApprovals.length > 0 && (
        <section className="pending-approvals-card card">
          <div className="card-head">
            <h3 style={{ color: "var(--warn)" }}>
              ⚠️ {t("runsView.pendingApprovals", { count: pendingApprovals.length })}
            </h3>
          </div>
          <div className="approvals-grid">
            {pendingApprovals.map((app) => (
              <div key={app.id} className="approval-item card">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong className="mono" style={{ color: "var(--accent)" }}>
                    {t("runsView.approvalAction", { action: app.action })}
                  </strong>
                  <span className="pill small pill-warn mono">{app.status.toUpperCase()}</span>
                </div>
                <div className="small muted mono" style={{ margin: "4px 0" }}>
                  {JSON.stringify(app.detail)}
                </div>
                <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                  <button
                    type="button"
                    className="btn-tiny pill-ok"
                    disabled={resolvingId === app.id}
                    onClick={() => void handleResolveApproval(app.id, "approved")}
                  >
                    ✓ {t("runsView.approve")}
                  </button>
                  <button
                    type="button"
                    className="btn-tiny pill-bad"
                    disabled={resolvingId === app.id}
                    onClick={() => void handleResolveApproval(app.id, "rejected")}
                  >
                    ✕ {t("runsView.reject")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Main Runs Explorer Grid */}
      <div className="runs-grid">
        {/* Left Column: Filter & Runs List */}
        <section className="card runs-list-card">
          <div className="runs-filters">
            <div className="filter-chips">
              {(["all", "running", "waiting_approval", "done", "failed"] as RunStatus[]).map((st) => (
                <button
                  key={st}
                  type="button"
                  className={`chip ${filter === st ? "is-active" : ""}`}
                  onClick={() => setFilter(st)}
                >
                  {t(FILTER_KEYS[st])}
                </button>
              ))}
            </div>

            <input
              type="text"
              className="runs-search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("runsView.searchPlaceholder")}
            />
          </div>

          <div className="runs-scroll-list">
            {loading ? (
              <p className="muted small" style={{ padding: "16px" }}>
                {t("common.loading")}
              </p>
            ) : filteredRuns.length === 0 ? (
              <p className="muted small" style={{ padding: "16px" }}>
                {t("runsView.empty")}
              </p>
            ) : (
              filteredRuns.map((r) => {
                const isSelected = r.id === selectedRunId;
                let pillClass = "pill-sky";
                if (r.status === "done") pillClass = "pill-ok";
                if (r.status === "failed" || r.status === "cancelled") pillClass = "pill-bad";
                if (r.status === "waiting_approval") pillClass = "pill-warn";

                return (
                  <div
                    key={r.id}
                    className={`run-list-item ${isSelected ? "is-selected" : ""}`}
                    onClick={() => setSelectedRunId(r.id)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className={`pill small mono ${pillClass}`}>{r.status.toUpperCase()}</span>
                      <span className="small muted mono">
                        {formatDateTime(locale, new Date(r.startedAt).getTime())}
                      </span>
                    </div>
                    <p className="run-list-goal">{r.goal}</p>
                    <div className="run-list-meta small muted mono">
                      <span>
                        {t("runsView.tokens", { tokens: formatNumber(locale, r.tokensIn + r.tokensOut) })}
                      </span>
                      <span>·</span>
                      <span>{t("runsView.cost", { cost: formatCurrency(locale, r.costUsd) })}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Column: Run Detail Inspector */}
        <section className="card runs-detail-card">
          {!selectedRun ? (
            <p className="muted">{t("runsView.selectToInspect")}</p>
          ) : (
            <div className="run-detail-content">
              {/* Header metrics */}
              <div className="run-detail-header">
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="pill small pill-accent mono">RUN: {selectedRun.id.slice(0, 8)}</span>
                    <span className="pill small mono pill-ok">{selectedRun.status.toUpperCase()}</span>
                    <span className="small muted mono">{selectedRun.locale.toUpperCase()}</span>
                  </div>
                  <h3 style={{ marginTop: "6px" }}>{selectedRun.goal}</h3>
                </div>

                <div className="run-export-buttons">
                  {(selectedRun.status === "running" || selectedRun.status === "waiting_approval") && (
                    <button
                      type="button"
                      className="btn-tiny"
                      style={{
                        background: "color-mix(in srgb, var(--coral) 20%, transparent)",
                        color: "var(--coral)",
                        borderColor: "var(--coral)",
                      }}
                      onClick={() => handleCancelRun(selectedRun.id)}
                      disabled={cancellingId === selectedRun.id}
                    >
                      {cancellingId === selectedRun.id ? t("common.loading") : t("runsView.cancelRun")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-tiny"
                    onClick={() => handleDownloadExport("markdown")}
                    title={t("runsView.exportMarkdown")}
                  >
                    📄 {t("runsView.exportMarkdown")}
                  </button>
                  <button
                    type="button"
                    className="btn-tiny"
                    onClick={() => handleDownloadExport("html")}
                    title={t("runsView.exportHtml")}
                  >
                    🌐 {t("runsView.exportHtml")}
                  </button>
                  <button
                    type="button"
                    className="btn-tiny"
                    onClick={() => handleDownloadExport("json")}
                    title={t("runsView.exportJson")}
                  >
                    {"{ }"} {t("runsView.exportJson")}
                  </button>
                </div>
              </div>

              {/* Watchdog Alerts Section */}
              {watchdogAlerts.length > 0 && (
                <div className="watchdog-section">
                  <h4 style={{ color: "var(--bad)" }}>🚨 {t("runsView.watchdogAlerts")}</h4>
                  <div className="watchdog-alerts-list">
                    {watchdogAlerts.map((w, idx) => {
                      const p = w.payload as { rule: string; severity: string; message: string };
                      return (
                        <div key={idx} className="watchdog-alert-card">
                          <span className="pill small pill-bad mono">{p.severity.toUpperCase()}</span>
                          <span className="small">
                            <strong>{p.rule}</strong>: {p.message}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Tool calls execution section */}
              {toolStartedEvents.length > 0 && (
                <div className="tools-section">
                  <h4>
                    🛠️ {t("runsView.toolCalls")} ({toolStartedEvents.length})
                  </h4>
                  <div className="tool-calls-grid">
                    {toolStartedEvents.map((te, idx) => {
                      const sp = te.payload as { tool: string; args: Record<string, unknown> };
                      const completed = toolCompletedEvents.find(
                        (c) =>
                          (c.payload as { callId: string }).callId ===
                          (te.payload as { callId: string }).callId,
                      );
                      const cp = completed?.payload as { summary: string } | undefined;

                      return (
                        <div key={idx} className="tool-call-card">
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <strong className="mono" style={{ color: "var(--sky)" }}>
                              {sp.tool}
                            </strong>
                            <span className="small muted mono">callId: {te.id.slice(0, 6)}</span>
                          </div>
                          <pre className="tool-args-pre mono small">{JSON.stringify(sp.args, null, 2)}</pre>
                          {cp && (
                            <p className="small" style={{ margin: "4px 0 0", color: "var(--ok)" }}>
                              ✓ {cp.summary}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Output Section */}
              {selectedRun.output && (
                <div className="run-output-section" style={{ marginTop: "16px" }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "8px",
                    }}
                  >
                    <h4>📄 {t("runsView.outputTitle")}</h4>
                    <button
                      type="button"
                      className="btn-tiny"
                      onClick={() => {
                        void navigator.clipboard.writeText(selectedRun.output ?? "");
                        setCopiedOutput(true);
                        setTimeout(() => setCopiedOutput(false), 2000);
                      }}
                    >
                      {copiedOutput ? `✓ ${t("runsView.outputCopied")}` : `📋 ${t("runsView.copyOutput")}`}
                    </button>
                  </div>
                  <div
                    className="run-output-content"
                    style={{
                      padding: "12px",
                      background: "var(--surface)",
                      border: "1px solid var(--line)",
                      borderRadius: "8px",
                      whiteSpace: "pre-wrap",
                      fontSize: "12.5px",
                      lineHeight: "1.5",
                      maxHeight: "280px",
                      overflowY: "auto",
                      color: "var(--fg)",
                    }}
                  >
                    {selectedRun.output}
                  </div>
                </div>
              )}

              {/* Artifacts Section */}
              <div className="run-artifacts-section" style={{ marginTop: "16px" }}>
                <h4>
                  📦 {t("runsView.artifacts")} ({artifactEvents.length})
                </h4>
                {artifactEvents.length === 0 ? (
                  <p className="small muted" style={{ margin: "4px 0 0", fontStyle: "italic" }}>
                    {t("runsView.noArtifacts")}
                  </p>
                ) : (
                  <div
                    className="artifacts-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                      gap: "10px",
                      marginTop: "8px",
                    }}
                  >
                    {artifactEvents.map((ae) => {
                      const ap = ae.payload as {
                        artifactId: string;
                        name: string;
                        kind: string;
                        bytes?: number;
                        content?: string;
                      };
                      const isPreviewing = previewArtifact?.id === ap.artifactId;
                      return (
                        <div
                          key={ap.artifactId}
                          className="artifact-card"
                          style={{
                            padding: "10px 12px",
                            background: "var(--surface)",
                            border: "1px solid var(--line)",
                            borderRadius: "8px",
                            display: "flex",
                            flexDirection: "column",
                            gap: "6px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <span className="mono small" style={{ fontWeight: 600, color: "var(--sky)" }}>
                              📄 {ap.name}
                            </span>
                            <span className="pill small pill-sky mono">{ap.kind.toUpperCase()}</span>
                          </div>
                          <span className="small muted mono">{ap.bytes ? `${ap.bytes} bytes` : ""}</span>
                          <div style={{ display: "flex", gap: "6px", marginTop: "4px" }}>
                            {ap.content && (
                              <button
                                type="button"
                                className="btn-tiny"
                                onClick={() =>
                                  setPreviewArtifact(
                                    isPreviewing
                                      ? null
                                      : {
                                          id: ap.artifactId,
                                          name: ap.name,
                                          kind: ap.kind,
                                          content: ap.content,
                                        },
                                  )
                                }
                              >
                                {isPreviewing ? t("runsView.closePreview") : t("runsView.preview")}
                              </button>
                            )}
                            {ap.content && (
                              <button
                                type="button"
                                className="btn-tiny"
                                onClick={() => downloadArtifact(ap.name, ap.content, ap.kind)}
                              >
                                ↓ {t("runsView.download")}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Inline Artifact Preview */}
                {previewArtifact?.content && (
                  <div
                    className="artifact-preview-box"
                    style={{
                      marginTop: "10px",
                      padding: "12px",
                      background: "var(--surface-2)",
                      border: "1px solid var(--line)",
                      borderRadius: "8px",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        marginBottom: "6px",
                      }}
                    >
                      <strong className="small mono">{previewArtifact.name}</strong>
                      <button type="button" className="btn-tiny" onClick={() => setPreviewArtifact(null)}>
                        ✕
                      </button>
                    </div>
                    <pre
                      className="mono small"
                      style={{
                        margin: 0,
                        padding: "8px",
                        background: "rgba(0,0,0,0.3)",
                        borderRadius: "6px",
                        maxHeight: "220px",
                        overflowY: "auto",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {previewArtifact.content}
                    </pre>
                  </div>
                )}
              </div>

              {/* Interactive Human Steer & Follow-up Section */}
              <div
                className="run-steer-section"
                style={{
                  marginTop: "16px",
                  padding: "14px",
                  background: "var(--surface)",
                  border: "1px solid var(--line)",
                  borderRadius: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "8px",
                  }}
                >
                  <h4 style={{ margin: 0 }}>🧭 {t("runsView.steerTitle")}</h4>
                  {steerSuccessMsg && (
                    <span className="pill small pill-ok mono">✓ {t("runsView.steerSuccess")}</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input
                    type="text"
                    className="input small"
                    style={{ flex: 1 }}
                    placeholder={t("runsView.steerPlaceholder")}
                    value={steerPrompt}
                    onChange={(e) => setSteerPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSteerRun();
                    }}
                    disabled={isSteering}
                  />
                  <select
                    className="input select small"
                    style={{ width: "120px" }}
                    value={steerRole}
                    onChange={(e) => setSteerRole(e.target.value)}
                    disabled={isSteering}
                  >
                    <option value="supervisor">Supervisor</option>
                    <option value="developer">Developer</option>
                    <option value="reviewer">Reviewer</option>
                    <option value="writer">Writer</option>
                    <option value="analyst">Analyst</option>
                    <option value="researcher">Researcher</option>
                  </select>
                  <button
                    type="button"
                    className="btn-tiny btn-primary"
                    onClick={() => void handleSteerRun()}
                    disabled={isSteering || !steerPrompt.trim()}
                  >
                    {isSteering ? t("common.loading") : `✈ ${t("runsView.steerButton")}`}
                  </button>
                </div>
              </div>

              {/* Chronological Event Timeline */}
              <div className="timeline-section">
                <h4>
                  📜 {t("runsView.timeline")} ({selectedRunEvents.length})
                </h4>
                <div className="timeline-scroll">
                  {selectedRunEvents.map((ev) => {
                    const labelKey = eventLabelKey(ev.type as EventType);
                    const p = ev.payload as Record<string, unknown>;

                    return (
                      <div key={ev.id} className="timeline-event-row mono small">
                        <span className="timeline-seq">#{ev.seq}</span>
                        <span className="timeline-time">{new Date(ev.ts).toTimeString().split(" ")[0]}</span>
                        <span className="timeline-badge pill small pill-accent">{t(labelKey)}</span>
                        <span className="timeline-payload">
                          {p.text
                            ? String(p.text).slice(0, 90)
                            : p.activity
                              ? String(p.activity)
                              : p.summary
                                ? String(p.summary)
                                : p.goal
                                  ? String(p.goal)
                                  : JSON.stringify(p).slice(0, 80)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
