import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime } from "@infuture/i18n";
import { useLocale } from "../i18n";

export type WorkspaceItem = {
  id: string;
  name: string;
  defaultLocale: string;
  createdAt: string;
};

export type TokenItem = {
  id: string;
  workspaceId: string;
  name: string;
  tokenPrefix: string;
  role: "admin" | "operator" | "viewer";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export type WebhookItem = {
  id: string;
  workspaceId: string;
  url: string;
  secretPrefix: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
};

export type DeliveryItem = {
  id: string;
  webhookId: string;
  eventType: string;
  statusCode: number | null;
  success: boolean;
  durationMs: number;
  error: string | null;
  createdAt: string;
};

export function WorkspacesView() {
  const { t } = useTranslation();
  const locale = useLocale();

  const [activeSubTab, setActiveSubTab] = useState<"workspaces" | "tokens" | "webhooks">("workspaces");

  // Multi-tenant Workspaces state
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => {
    return localStorage.getItem("infuture_workspace_id") || "00000000-0000-4000-8000-000000000001";
  });
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [showCreateWsModal, setShowCreateWsModal] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsLocale, setNewWsLocale] = useState<"en" | "es">("en");
  const [wsError, setWsError] = useState<string | null>(null);

  // API Tokens state
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(false);
  const [showCreateTokenModal, setShowCreateTokenModal] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenRole, setNewTokenRole] = useState<"admin" | "operator" | "viewer">("operator");
  const [issuedSecret, setIssuedSecret] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  // Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [showCreateHookModal, setShowCreateHookModal] = useState(false);
  const [newHookUrl, setNewHookUrl] = useState("");
  const [newHookEvents, setNewHookEvents] = useState("*");
  const [newHookSecret, setNewHookSecret] = useState("");
  const [hookError, setHookError] = useState<string | null>(null);

  // Webhook Testing & Deliveries
  const [testingHookId, setTestingHookId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    hookId: string;
    success: boolean;
    statusCode: number | null;
    durationMs: number;
    error: string | null;
  } | null>(null);
  const [selectedHookForDeliveries, setSelectedHookForDeliveries] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryItem[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);

  const fetchWorkspaces = useCallback(async () => {
    setLoadingWorkspaces(true);
    try {
      const res = await fetch("/api/v1/workspaces", {
        headers: { "X-Infuture-Locale": locale },
      });
      if (!res.ok) throw new Error("Failed to load workspaces");
      const data = await res.json();
      setWorkspaces(data.workspaces ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingWorkspaces(false);
    }
  }, [locale]);

  const fetchTokens = useCallback(async () => {
    setLoadingTokens(true);
    try {
      const res = await fetch("/api/v1/tokens", {
        headers: {
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
      });
      if (!res.ok) throw new Error("Failed to load tokens");
      const data = await res.json();
      setTokens(data.tokens ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingTokens(false);
    }
  }, [locale, activeWorkspaceId]);

  const fetchWebhooks = useCallback(async () => {
    setLoadingWebhooks(true);
    try {
      const res = await fetch("/api/v1/webhooks", {
        headers: {
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
      });
      if (!res.ok) throw new Error("Failed to load webhooks");
      const data = await res.json();
      setWebhooks(data.webhooks ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingWebhooks(false);
    }
  }, [locale, activeWorkspaceId]);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  useEffect(() => {
    if (activeSubTab === "tokens") {
      fetchTokens();
    } else if (activeSubTab === "webhooks") {
      fetchWebhooks();
    }
  }, [activeSubTab, activeWorkspaceId, fetchTokens, fetchWebhooks]);

  const handleSelectWorkspace = (id: string) => {
    setActiveWorkspaceId(id);
    localStorage.setItem("infuture_workspace_id", id);
    if (activeSubTab === "tokens") fetchTokens();
    if (activeSubTab === "webhooks") fetchWebhooks();
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWsName.trim()) return;
    setWsError(null);

    try {
      const res = await fetch("/api/v1/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
        body: JSON.stringify({ name: newWsName.trim(), defaultLocale: newWsLocale }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create workspace");
      }
      const created = await res.json();
      setNewWsName("");
      setShowCreateWsModal(false);
      handleSelectWorkspace(created.id);
      await fetchWorkspaces();
    } catch (err: unknown) {
      setWsError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    setTokenError(null);

    try {
      const res = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
        body: JSON.stringify({ name: newTokenName.trim(), role: newTokenRole }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to issue token");
      }
      const issued = await res.json();
      setIssuedSecret(issued.token);
      setNewTokenName("");
      setCopiedToken(false);
      await fetchTokens();
    } catch (err: unknown) {
      setTokenError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeToken = async (id: string) => {
    if (!confirm(t("workspacesView.tokens.confirmRevoke"))) return;
    try {
      const res = await fetch(`/api/v1/tokens/${id}`, {
        method: "DELETE",
        headers: {
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
      });
      if (res.ok) {
        await fetchTokens();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHookUrl.trim()) return;
    setHookError(null);

    const eventsList = newHookEvents
      .split(",")
      .map((ev) => ev.trim())
      .filter(Boolean);

    try {
      const res = await fetch("/api/v1/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
        body: JSON.stringify({
          url: newHookUrl.trim(),
          secret: newHookSecret.trim() || undefined,
          events: eventsList.length > 0 ? eventsList : ["*"],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to register webhook");
      }
      setNewHookUrl("");
      setNewHookSecret("");
      setNewHookEvents("*");
      setShowCreateHookModal(false);
      await fetchWebhooks();
    } catch (err: unknown) {
      setHookError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    if (!confirm(t("workspacesView.webhooks.confirmDelete"))) return;
    try {
      const res = await fetch(`/api/v1/webhooks/${id}`, {
        method: "DELETE",
        headers: {
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
      });
      if (res.ok) {
        if (selectedHookForDeliveries === id) setSelectedHookForDeliveries(null);
        await fetchWebhooks();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleTestWebhook = async (id: string) => {
    setTestingHookId(id);
    setTestResult(null);
    try {
      const res = await fetch(`/api/v1/webhooks/${id}/test`, {
        method: "POST",
        headers: {
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
      });
      const data = await res.json();
      setTestResult({
        hookId: id,
        success: data.success,
        statusCode: data.statusCode,
        durationMs: data.durationMs,
        error: data.error,
      });
    } catch (err: unknown) {
      setTestResult({
        hookId: id,
        success: false,
        statusCode: null,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestingHookId(null);
    }
  };

  const handleViewDeliveries = async (id: string) => {
    setSelectedHookForDeliveries(id);
    setLoadingDeliveries(true);
    try {
      const res = await fetch(`/api/v1/webhooks/${id}/deliveries`, {
        headers: {
          "X-Infuture-Locale": locale,
          "X-Workspace-Id": activeWorkspaceId,
        },
      });
      if (res.ok) {
        const data = await res.json();
        setDeliveries(data.deliveries ?? []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoadingDeliveries(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 2500);
  };

  const currentWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? {
    id: activeWorkspaceId,
    name: "Local",
    defaultLocale: "en",
    createdAt: new Date().toISOString(),
  };

  return (
    <div className="card-column" style={{ gap: "1.5rem" }}>
      {/* Top Banner & Workspace Selector */}
      <div
        className="card"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div>
          <h2 style={{ margin: 0, display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "1.4rem" }}>🏢</span> {t("workspacesView.title")}
          </h2>
          <p style={{ margin: "0.25rem 0 0 0", color: "var(--muted)", fontSize: "0.9rem" }}>
            {t("workspacesView.subtitle")}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              padding: "0.35rem 0.75rem",
              borderRadius: "6px",
            }}
          >
            <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
              {t("workspacesView.activeLabel")}:
            </span>
            <select
              value={activeWorkspaceId}
              onChange={(e) => handleSelectWorkspace(e.target.value)}
              style={{
                background: "transparent",
                color: "var(--fg)",
                border: "none",
                fontWeight: 600,
                fontSize: "0.95rem",
                cursor: "pointer",
                outline: "none",
              }}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id} style={{ background: "var(--surface)", color: "var(--fg)" }}>
                  {w.name} ({w.defaultLocale.toUpperCase()})
                </option>
              ))}
            </select>
          </div>

          <button
            className="btn btn-outline"
            onClick={() => setShowCreateWsModal(true)}
            style={{ fontSize: "0.85rem", padding: "0.35rem 0.75rem" }}
          >
            + {t("workspacesView.createWorkspaceBtn")}
          </button>
        </div>
      </div>

      {/* Sub-tab Navigation */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          borderBottom: "1px solid var(--border)",
          paddingBottom: "0.5rem",
        }}
      >
        <button
          className={`btn ${activeSubTab === "workspaces" ? "btn-primary" : "btn-outline"}`}
          onClick={() => setActiveSubTab("workspaces")}
          style={{ fontSize: "0.9rem" }}
        >
          📁 {t("workspacesView.tabs.workspaces")} ({workspaces.length})
        </button>
        <button
          className={`btn ${activeSubTab === "tokens" ? "btn-primary" : "btn-outline"}`}
          onClick={() => setActiveSubTab("tokens")}
          style={{ fontSize: "0.9rem" }}
        >
          🔑 {t("workspacesView.tabs.tokens")} ({tokens.length})
        </button>
        <button
          className={`btn ${activeSubTab === "webhooks" ? "btn-primary" : "btn-outline"}`}
          onClick={() => setActiveSubTab("webhooks")}
          style={{ fontSize: "0.9rem" }}
        >
          🔔 {t("workspacesView.tabs.webhooks")} ({webhooks.length})
        </button>
      </div>

      {/* SUBTAB 1: WORKSPACES */}
      {activeSubTab === "workspaces" && (
        <div className="card-column" style={{ gap: "1rem" }}>
          {showCreateWsModal && (
            <div className="card" style={{ border: "1px solid var(--accent)" }}>
              <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.1rem" }}>
                {t("workspacesView.createWorkspaceTitle")}
              </h3>
              {wsError && <div style={{ color: "var(--warn)", marginBottom: "0.5rem" }}>{wsError}</div>}
              <form
                onSubmit={handleCreateWorkspace}
                style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      marginBottom: "0.25rem",
                      color: "var(--muted)",
                    }}
                  >
                    {t("workspacesView.workspaceNameLabel")}
                  </label>
                  <input
                    type="text"
                    value={newWsName}
                    onChange={(e) => setNewWsName(e.target.value)}
                    placeholder="e.g. Enterprise Production, R&D Labs"
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--fg)",
                      borderRadius: "4px",
                    }}
                    required
                  />
                </div>
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      marginBottom: "0.25rem",
                      color: "var(--muted)",
                    }}
                  >
                    {t("workspacesView.workspaceLocaleLabel")}
                  </label>
                  <select
                    value={newWsLocale}
                    onChange={(e) => setNewWsLocale(e.target.value as "en" | "es")}
                    style={{
                      padding: "0.5rem",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--fg)",
                      borderRadius: "4px",
                    }}
                  >
                    <option value="en">English (en)</option>
                    <option value="es">Español (es)</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button type="submit" className="btn btn-primary">
                    {t("workspacesView.saveWorkspaceBtn")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => {
                      setShowCreateWsModal(false);
                      setWsError(null);
                    }}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: "1rem",
            }}
          >
            {loadingWorkspaces ? (
              <div style={{ color: "var(--muted)" }}>{t("common.loading")}...</div>
            ) : workspaces.length === 0 ? (
              <div style={{ color: "var(--muted)" }}>{t("workspacesView.noWorkspaces")}</div>
            ) : (
              workspaces.map((ws) => {
                const isActive = ws.id === activeWorkspaceId;
                return (
                  <div
                    key={ws.id}
                    className="card"
                    style={{
                      border: isActive ? "2px solid var(--accent)" : "1px solid var(--border)",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                    }}
                    onClick={() => handleSelectWorkspace(ws.id)}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "0.5rem",
                        }}
                      >
                        <h4 style={{ margin: 0, fontSize: "1.1rem" }}>{ws.name}</h4>
                        {isActive && (
                          <span
                            style={{
                              background: "var(--accent)",
                              color: "#fff",
                              fontSize: "0.75rem",
                              padding: "0.15rem 0.5rem",
                              borderRadius: "12px",
                              fontWeight: 600,
                            }}
                          >
                            {t("workspacesView.activeBadge")}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "0.8rem", color: "var(--muted)", fontFamily: "monospace" }}>
                        ID: {ws.id}
                      </div>
                    </div>
                    <div
                      style={{
                        marginTop: "1rem",
                        fontSize: "0.8rem",
                        color: "var(--muted)",
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>
                        Locale: <strong>{ws.defaultLocale.toUpperCase()}</strong>
                      </span>
                      <span>{formatDateTime(locale, ws.createdAt)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* SUBTAB 2: API TOKENS */}
      {activeSubTab === "tokens" && (
        <div className="card-column" style={{ gap: "1rem" }}>
          {issuedSecret && (
            <div
              className="card"
              style={{
                background: "rgba(59, 130, 246, 0.1)",
                border: "2px solid var(--accent)",
                padding: "1.25rem",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem 0", color: "var(--accent)", fontSize: "1.1rem" }}>
                🎉 {t("workspacesView.tokens.issuedTitle")}
              </h3>
              <p style={{ margin: "0 0 0.75rem 0", fontSize: "0.85rem", color: "var(--muted)" }}>
                {t("workspacesView.tokens.issuedWarning")}
              </p>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  background: "var(--surface)",
                  padding: "0.5rem 0.75rem",
                  borderRadius: "6px",
                  border: "1px solid var(--border)",
                  fontFamily: "monospace",
                  fontSize: "0.95rem",
                  wordBreak: "break-all",
                }}
              >
                <span style={{ flex: 1, userSelect: "all" }}>{issuedSecret}</span>
                <button
                  className="btn btn-primary"
                  onClick={() => copyToClipboard(issuedSecret)}
                  style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}
                >
                  {copiedToken ? t("workspacesView.tokens.copied") : t("workspacesView.tokens.copy")}
                </button>
              </div>
              <button
                className="btn btn-outline"
                onClick={() => setIssuedSecret(null)}
                style={{ marginTop: "0.75rem", fontSize: "0.8rem" }}
              >
                {t("workspacesView.tokens.doneSecret")}
              </button>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.9rem", color: "var(--muted)" }}>
              {t("workspacesView.tokens.description", { workspace: currentWorkspace.name })}
            </span>
            <button
              className="btn btn-primary"
              onClick={() => {
                setShowCreateTokenModal(true);
                setTokenError(null);
              }}
              style={{ fontSize: "0.85rem" }}
            >
              + {t("workspacesView.tokens.issueBtn")}
            </button>
          </div>

          {showCreateTokenModal && (
            <div className="card" style={{ border: "1px solid var(--border)" }}>
              <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.05rem" }}>
                {t("workspacesView.tokens.createModalTitle")}
              </h3>
              {tokenError && <div style={{ color: "var(--warn)", marginBottom: "0.5rem" }}>{tokenError}</div>}
              <form
                onSubmit={handleCreateToken}
                style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      marginBottom: "0.25rem",
                      color: "var(--muted)",
                    }}
                  >
                    {t("workspacesView.tokens.nameLabel")}
                  </label>
                  <input
                    type="text"
                    value={newTokenName}
                    onChange={(e) => setNewTokenName(e.target.value)}
                    placeholder="e.g. CI/CD Integration, Zapier Webhook, Production Agent"
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--fg)",
                      borderRadius: "4px",
                    }}
                    required
                  />
                </div>
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      marginBottom: "0.25rem",
                      color: "var(--muted)",
                    }}
                  >
                    {t("workspacesView.tokens.roleLabel")}
                  </label>
                  <select
                    value={newTokenRole}
                    onChange={(e) => setNewTokenRole(e.target.value as "admin" | "operator" | "viewer")}
                    style={{
                      padding: "0.5rem",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--fg)",
                      borderRadius: "4px",
                    }}
                  >
                    <option value="operator">{t("workspacesView.roles.operator")}</option>
                    <option value="admin">{t("workspacesView.roles.admin")}</option>
                    <option value="viewer">{t("workspacesView.roles.viewer")}</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button type="submit" className="btn btn-primary">
                    {t("workspacesView.tokens.confirmIssueBtn")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setShowCreateTokenModal(false)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="card-column" style={{ gap: "0.75rem" }}>
            {loadingTokens ? (
              <div style={{ color: "var(--muted)" }}>{t("common.loading")}...</div>
            ) : tokens.length === 0 ? (
              <div className="card" style={{ color: "var(--muted)", textAlign: "center", padding: "2rem" }}>
                {t("workspacesView.tokens.noTokens")}
              </div>
            ) : (
              tokens.map((token) => (
                <div
                  key={token.id}
                  className="card"
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "1rem",
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.5rem",
                        marginBottom: "0.25rem",
                      }}
                    >
                      <strong style={{ fontSize: "1rem" }}>{token.name}</strong>
                      <span
                        style={{
                          background:
                            token.role === "admin"
                              ? "var(--warn)"
                              : token.role === "operator"
                                ? "var(--accent)"
                                : "var(--muted)",
                          color: "#fff",
                          fontSize: "0.75rem",
                          padding: "0.1rem 0.4rem",
                          borderRadius: "4px",
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        {token.role}
                      </span>
                    </div>
                    <div style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "var(--muted)" }}>
                      {token.tokenPrefix}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <div style={{ textAlign: "right", fontSize: "0.8rem", color: "var(--muted)" }}>
                      <div>
                        {t("workspacesView.tokens.created")}: {formatDateTime(locale, token.createdAt)}
                      </div>
                      {token.lastUsedAt && (
                        <div>
                          {t("workspacesView.tokens.lastUsed")}: {formatDateTime(locale, token.lastUsedAt)}
                        </div>
                      )}
                    </div>
                    <button
                      className="btn btn-outline"
                      onClick={() => handleRevokeToken(token.id)}
                      style={{ color: "var(--warn)", borderColor: "var(--warn)", fontSize: "0.8rem" }}
                    >
                      {t("workspacesView.tokens.revoke")}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* SUBTAB 3: WEBHOOKS & INTEGRATIONS */}
      {activeSubTab === "webhooks" && (
        <div className="card-column" style={{ gap: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.9rem", color: "var(--muted)" }}>
              {t("workspacesView.webhooks.description")}
            </span>
            <button
              className="btn btn-primary"
              onClick={() => {
                setShowCreateHookModal(true);
                setHookError(null);
              }}
              style={{ fontSize: "0.85rem" }}
            >
              + {t("workspacesView.webhooks.addBtn")}
            </button>
          </div>

          {showCreateHookModal && (
            <div className="card" style={{ border: "1px solid var(--border)" }}>
              <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.05rem" }}>
                {t("workspacesView.webhooks.createModalTitle")}
              </h3>
              {hookError && <div style={{ color: "var(--warn)", marginBottom: "0.5rem" }}>{hookError}</div>}
              <form
                onSubmit={handleCreateWebhook}
                style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      marginBottom: "0.25rem",
                      color: "var(--muted)",
                    }}
                  >
                    {t("workspacesView.webhooks.urlLabel")}
                  </label>
                  <input
                    type="url"
                    value={newHookUrl}
                    onChange={(e) => setNewHookUrl(e.target.value)}
                    placeholder="https://api.internal/agent-events"
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--fg)",
                      borderRadius: "4px",
                    }}
                    required
                  />
                </div>
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      marginBottom: "0.25rem",
                      color: "var(--muted)",
                    }}
                  >
                    {t("workspacesView.webhooks.eventsLabel")}
                  </label>
                  <input
                    type="text"
                    value={newHookEvents}
                    onChange={(e) => setNewHookEvents(e.target.value)}
                    placeholder="* or run.completed, run.failed, watchdog.alert"
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--fg)",
                      borderRadius: "4px",
                    }}
                  />
                  <small style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
                    {t("workspacesView.webhooks.eventsHelp")}
                  </small>
                </div>
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "0.85rem",
                      marginBottom: "0.25rem",
                      color: "var(--muted)",
                    }}
                  >
                    {t("workspacesView.webhooks.secretLabel")}
                  </label>
                  <input
                    type="text"
                    value={newHookSecret}
                    onChange={(e) => setNewHookSecret(e.target.value)}
                    placeholder={t("workspacesView.webhooks.secretPlaceholder")}
                    style={{
                      width: "100%",
                      padding: "0.5rem",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      color: "var(--fg)",
                      borderRadius: "4px",
                    }}
                  />
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button type="submit" className="btn btn-primary">
                    {t("workspacesView.webhooks.confirmAddBtn")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={() => setShowCreateHookModal(false)}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Webhooks List */}
          <div className="card-column" style={{ gap: "0.75rem" }}>
            {loadingWebhooks ? (
              <div style={{ color: "var(--muted)" }}>{t("common.loading")}...</div>
            ) : webhooks.length === 0 ? (
              <div className="card" style={{ color: "var(--muted)", textAlign: "center", padding: "2rem" }}>
                {t("workspacesView.webhooks.noWebhooks")}
              </div>
            ) : (
              webhooks.map((hook) => (
                <div key={hook.id} className="card">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                      gap: "0.75rem",
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          marginBottom: "0.25rem",
                        }}
                      >
                        <span
                          style={{
                            background: hook.enabled ? "var(--ok)" : "var(--muted)",
                            color: "#fff",
                            fontSize: "0.7rem",
                            padding: "0.1rem 0.4rem",
                            borderRadius: "4px",
                            fontWeight: 600,
                          }}
                        >
                          {hook.enabled ? "ACTIVE" : "PAUSED"}
                        </span>
                        <strong style={{ fontSize: "1rem", wordBreak: "break-all" }}>{hook.url}</strong>
                      </div>
                      <div
                        style={{
                          fontSize: "0.8rem",
                          color: "var(--muted)",
                          display: "flex",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                        }}
                      >
                        <span>
                          Secret: <code style={{ color: "var(--fg)" }}>{hook.secretPrefix}</code>
                        </span>
                        <span>•</span>
                        <span>
                          Events:{" "}
                          {hook.events.map((ev) => (
                            <span
                              key={ev}
                              style={{
                                background: "var(--surface)",
                                border: "1px solid var(--border)",
                                borderRadius: "3px",
                                padding: "0.1rem 0.3rem",
                                marginRight: "0.25rem",
                                fontSize: "0.75rem",
                              }}
                            >
                              {ev}
                            </span>
                          ))}
                        </span>
                      </div>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <button
                        className="btn btn-outline"
                        onClick={() => handleTestWebhook(hook.id)}
                        disabled={testingHookId === hook.id}
                        style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}
                      >
                        {testingHookId === hook.id
                          ? t("common.loading")
                          : `🚀 ${t("workspacesView.webhooks.testPing")}`}
                      </button>
                      <button
                        className="btn btn-outline"
                        onClick={() => handleViewDeliveries(hook.id)}
                        style={{ fontSize: "0.8rem", padding: "0.3rem 0.6rem" }}
                      >
                        📜 {t("workspacesView.webhooks.deliveries")}
                      </button>
                      <button
                        className="btn btn-outline"
                        onClick={() => handleDeleteWebhook(hook.id)}
                        style={{
                          color: "var(--warn)",
                          borderColor: "var(--warn)",
                          fontSize: "0.8rem",
                          padding: "0.3rem 0.6rem",
                        }}
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </div>

                  {/* Live Ping Test Result Banner */}
                  {testResult && testResult.hookId === hook.id && (
                    <div
                      style={{
                        marginTop: "0.75rem",
                        padding: "0.5rem 0.75rem",
                        borderRadius: "4px",
                        background: testResult.success ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
                        border: `1px solid ${testResult.success ? "var(--ok)" : "var(--warn)"}`,
                        fontSize: "0.85rem",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <span>
                        {testResult.success ? "✅ " : "❌ "}
                        <strong>
                          {testResult.success
                            ? t("workspacesView.webhooks.pingSuccess")
                            : t("workspacesView.webhooks.pingFailed")}
                        </strong>
                        {testResult.statusCode && ` (HTTP ${testResult.statusCode})`}
                        {testResult.error && ` - ${testResult.error}`}
                      </span>
                      <span style={{ color: "var(--muted)", fontSize: "0.8rem" }}>
                        {testResult.durationMs}ms
                      </span>
                    </div>
                  )}

                  {/* Delivery History section */}
                  {selectedHookForDeliveries === hook.id && (
                    <div
                      style={{
                        marginTop: "1rem",
                        borderTop: "1px solid var(--border)",
                        paddingTop: "0.75rem",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "0.5rem",
                        }}
                      >
                        <h5 style={{ margin: 0, fontSize: "0.9rem" }}>
                          {t("workspacesView.webhooks.recentDeliveries")}
                        </h5>
                        <button
                          className="btn btn-outline"
                          onClick={() => setSelectedHookForDeliveries(null)}
                          style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}
                        >
                          ✕
                        </button>
                      </div>

                      {loadingDeliveries ? (
                        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                          {t("common.loading")}...
                        </div>
                      ) : deliveries.length === 0 ? (
                        <div style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                          {t("workspacesView.webhooks.noDeliveries")}
                        </div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                          {deliveries.slice(0, 5).map((d) => (
                            <div
                              key={d.id}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                fontSize: "0.75rem",
                                padding: "0.3rem 0.5rem",
                                background: "var(--surface)",
                                borderRadius: "4px",
                                border: "1px solid var(--border)",
                              }}
                            >
                              <div>
                                <span
                                  style={{ color: d.success ? "var(--ok)" : "var(--warn)", fontWeight: 600 }}
                                >
                                  {d.success ? "200 OK" : `ERR (${d.statusCode ?? "timeout"})`}
                                </span>
                                <span style={{ marginLeft: "0.5rem", color: "var(--muted)" }}>
                                  [{d.eventType}]
                                </span>
                                {d.error && (
                                  <span style={{ marginLeft: "0.5rem", color: "var(--warn)" }}>
                                    {d.error}
                                  </span>
                                )}
                              </div>
                              <div style={{ color: "var(--muted)" }}>
                                <span>{d.durationMs}ms</span> •{" "}
                                <span>{formatDateTime(locale, d.createdAt)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
