import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCurrency, formatDateTime } from "@infuture/i18n";
import { useLocale } from "../i18n";

export type Provider = {
  id: string;
  displayName: string;
  authTypes: ("api_key" | "oauth" | "local")[];
  defaultBaseUrl: string;
  docsUrl: string;
  keyPrefix?: string;
  requiresSecret: boolean;
};

export type Connection = {
  id: string;
  providerId: string;
  alias: string;
  authType: "api_key" | "oauth" | "local";
  baseUrl: string | null;
  status: "unverified" | "healthy" | "degraded" | "invalid" | "rate_limited";
  lastCheckedAt: string | null;
  budgetUsdMonth: number | null;
  createdAt: string;
  hint: string | null;
  models: string[];
};

export function Connections() {
  const { t } = useTranslation();
  const locale = useLocale();

  const [providers, setProviders] = useState<Provider[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New connection form state
  const [isAdding, setIsAdding] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("openai");
  const [alias, setAlias] = useState("");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [budget, setBudget] = useState("");
  const [verifyOnSave, setVerifyOnSave] = useState(true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Action status per connection: id -> 'verifying' | 'deleting'
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const headers = { "X-Infuture-Locale": locale };
      const [provRes, connRes] = await Promise.all([
        fetch("/api/v1/providers", { headers }),
        fetch("/api/v1/connections", { headers }),
      ]);

      if (!provRes.ok || !connRes.ok) {
        throw new Error("Failed to load providers or connections");
      }

      const provData = (await provRes.json()) as Provider[];
      const connData = (await connRes.json()) as Connection[];

      setProviders(provData);
      setConnections(connData);
      if (provData.length > 0 && !selectedProviderId) {
        setSelectedProviderId(provData[0]?.id ?? "openai");
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [locale, selectedProviderId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProvider) return;

    setSaving(true);
    setFormError(null);

    const payload: {
      providerId: string;
      alias: string;
      secret?: string;
      baseUrl?: string;
      budgetUsdMonth?: number;
      verify: boolean;
    } = {
      providerId: selectedProvider.id,
      alias: alias.trim() || `${selectedProvider.displayName} Connection`,
      verify: verifyOnSave,
    };

    if (selectedProvider.requiresSecret) {
      payload.secret = secret.trim();
    }
    if (baseUrl.trim()) {
      payload.baseUrl = baseUrl.trim();
    }
    if (budget.trim()) {
      const parsedBudget = Number.parseFloat(budget);
      if (!Number.isNaN(parsedBudget)) {
        payload.budgetUsdMonth = parsedBudget;
      }
    }

    try {
      const res = await fetch("/api/v1/connections", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message || "Failed to create connection");
      }

      setConnections((prev) => [...prev, data as Connection]);
      setIsAdding(false);
      setAlias("");
      setSecret("");
      setBaseUrl("");
      setBudget("");
    } catch (err: unknown) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async (conn: Connection) => {
    setActionStatus((prev) => ({ ...prev, [conn.id]: "verifying" }));
    try {
      const res = await fetch(`/api/v1/connections/${conn.id}/verify`, {
        method: "POST",
        headers: { "X-Infuture-Locale": locale },
      });
      const data = await res.json();
      if (res.ok) {
        setConnections((prev) => prev.map((c) => (c.id === conn.id ? (data as Connection) : c)));
      } else {
        alert(data.error?.message || "Verification failed");
      }
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setActionStatus((prev) => {
        const next = { ...prev };
        delete next[conn.id];
        return next;
      });
    }
  };

  const handleDelete = async (conn: Connection) => {
    const confirmed = window.confirm(t("connections.confirmDelete", { alias: conn.alias }));
    if (!confirmed) return;

    setActionStatus((prev) => ({ ...prev, [conn.id]: "deleting" }));
    try {
      const res = await fetch(`/api/v1/connections/${conn.id}`, {
        method: "DELETE",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok || res.status === 204) {
        setConnections((prev) => prev.filter((c) => c.id !== conn.id));
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error?.message || "Delete failed");
      }
    } catch (err: unknown) {
      alert((err as Error).message);
    } finally {
      setActionStatus((prev) => {
        const next = { ...prev };
        delete next[conn.id];
        return next;
      });
    }
  };

  return (
    <div className="connections-view">
      <div className="section-header">
        <div>
          <h2>{t("connections.title")}</h2>
          <p className="muted">{t("connections.subtitle")}</p>
        </div>
        {!isAdding && (
          <button type="button" className="btn" onClick={() => setIsAdding(true)}>
            + {t("connections.newButton")}
          </button>
        )}
      </div>

      {isAdding && (
        <section className="card card-wide form-card" aria-labelledby="add-conn-title">
          <div className="card-head">
            <h3 id="add-conn-title">{t("connections.addTitle")}</h3>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setIsAdding(false);
                setFormError(null);
              }}
            >
              ✕ {t("connections.cancel")}
            </button>
          </div>

          {formError && <div className="form-error-banner">{formError}</div>}

          <form onSubmit={handleCreate} className="connection-form">
            <div className="form-grid">
              <div className="form-group">
                <label htmlFor="conn-provider">{t("connections.provider")}</label>
                <select
                  id="conn-provider"
                  className="input select"
                  value={selectedProviderId}
                  onChange={(e) => setSelectedProviderId(e.target.value)}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} {p.requiresSecret ? "" : `(${t("connections.localAuth")})`}
                    </option>
                  ))}
                </select>
                {selectedProvider?.docsUrl && (
                  <span className="small muted">
                    <a
                      href={selectedProvider.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="link-subtle"
                    >
                      {t("connections.docsLink")} ↗
                    </a>
                  </span>
                )}
              </div>

              <div className="form-group">
                <label htmlFor="conn-alias">{t("connections.alias")}</label>
                <input
                  id="conn-alias"
                  type="text"
                  className="input"
                  placeholder={t("connections.aliasPlaceholder")}
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  required
                />
              </div>

              {selectedProvider?.requiresSecret && (
                <div className="form-group form-group-full">
                  <label htmlFor="conn-secret">{t("connections.secret")}</label>
                  <input
                    id="conn-secret"
                    type="password"
                    autoComplete="new-password"
                    className="input mono"
                    placeholder={selectedProvider.keyPrefix ? `${selectedProvider.keyPrefix}...` : "..."}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    required
                  />
                  <span className="small muted">{t("connections.secretHint")}</span>
                </div>
              )}

              <div className="form-group">
                <label htmlFor="conn-base-url">{t("connections.baseUrl")}</label>
                <input
                  id="conn-base-url"
                  type="url"
                  className="input mono"
                  placeholder={selectedProvider?.defaultBaseUrl ?? "https://..."}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <span className="small muted">{t("connections.baseUrlOptional")}</span>
              </div>

              <div className="form-group">
                <label htmlFor="conn-budget">{t("connections.budget")}</label>
                <input
                  id="conn-budget"
                  type="number"
                  min="0"
                  step="0.01"
                  className="input"
                  placeholder="50.00"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                />
                <span className="small muted">{t("connections.budgetOptional")}</span>
              </div>
            </div>

            <div className="form-checkbox-group">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={verifyOnSave}
                  onChange={(e) => setVerifyOnSave(e.target.checked)}
                />
                <span>{t("connections.verifyOnSave")}</span>
              </label>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn" disabled={saving}>
                {saving ? t("connections.saving") : t("connections.save")}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setIsAdding(false);
                  setFormError(null);
                }}
                disabled={saving}
              >
                {t("connections.cancel")}
              </button>
            </div>
          </form>
        </section>
      )}

      {loading && connections.length === 0 ? (
        <div className="empty-state card">
          <p className="muted">{t("common.loading")}</p>
        </div>
      ) : error ? (
        <div className="empty-state card">
          <p className="error-text">{error}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void loadData()}>
            {t("common.retry")}
          </button>
        </div>
      ) : connections.length === 0 ? (
        <section className="card empty-state" aria-labelledby="empty-title">
          <div className="empty-icon" aria-hidden="true">
            ⚡
          </div>
          <h3 id="empty-title">{t("connections.emptyTitle")}</h3>
          <p className="muted">{t("connections.emptyHint")}</p>
          {!isAdding && (
            <button type="button" className="btn" onClick={() => setIsAdding(true)}>
              + {t("connections.newButton")}
            </button>
          )}
        </section>
      ) : (
        <div className="connections-grid">
          {connections.map((conn) => {
            const providerInfo = providers.find((p) => p.id === conn.providerId);
            const isVerifying = actionStatus[conn.id] === "verifying";
            const isDeleting = actionStatus[conn.id] === "deleting";

            return (
              <article key={conn.id} className="card connection-card">
                <div className="conn-header">
                  <div className="conn-title-group">
                    <span className="conn-provider-badge mono">
                      {providerInfo?.displayName ?? conn.providerId}
                    </span>
                    <h3 className="conn-alias">{conn.alias}</h3>
                  </div>
                  <span className={`pill pill-${conn.status}`}>
                    <span className="pill-dot" aria-hidden="true" />
                    {t(`connections.status.${conn.status}`)}
                  </span>
                </div>

                <div className="conn-details">
                  <div className="conn-detail-item">
                    <span className="detail-label">{t("connections.secret")}</span>
                    <span className="mono detail-value">
                      {conn.hint ? t("connections.keyHint", { hint: conn.hint }) : t("connections.localAuth")}
                    </span>
                  </div>

                  {conn.baseUrl && (
                    <div className="conn-detail-item">
                      <span className="detail-label">{t("connections.baseUrl")}</span>
                      <span className="mono small detail-value truncate" title={conn.baseUrl}>
                        {conn.baseUrl}
                      </span>
                    </div>
                  )}

                  {conn.budgetUsdMonth !== null && (
                    <div className="conn-detail-item">
                      <span className="detail-label">{t("connections.budget")}</span>
                      <span className="mono detail-value">{formatCurrency(locale, conn.budgetUsdMonth)}</span>
                    </div>
                  )}

                  <div className="conn-detail-item">
                    <span className="detail-label">{t("home.date")}</span>
                    <span className="small muted">
                      {conn.lastCheckedAt
                        ? t("connections.lastChecked", {
                            time: formatDateTime(locale, conn.lastCheckedAt),
                          })
                        : t("connections.neverChecked")}
                    </span>
                  </div>
                </div>

                <div className="conn-models">
                  <div className="models-header">
                    <span className="small muted">
                      {t("connections.modelsCount", { count: conn.models.length })}
                    </span>
                  </div>
                  {conn.models.length > 0 ? (
                    <div className="model-chips">
                      {conn.models.slice(0, 10).map((m) => (
                        <span key={m} className="model-chip mono small">
                          {m}
                        </span>
                      ))}
                      {conn.models.length > 10 && (
                        <span className="model-chip-more mono small">+{conn.models.length - 10}</span>
                      )}
                    </div>
                  ) : (
                    <p className="small muted">{t("connections.noModels")}</p>
                  )}
                </div>

                <div className="conn-footer">
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => void handleVerify(conn)}
                    disabled={isVerifying || isDeleting}
                  >
                    {isVerifying ? t("connections.verifying") : t("connections.verify")}
                  </button>

                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => void handleDelete(conn)}
                    disabled={isVerifying || isDeleting}
                  >
                    {isDeleting ? "…" : t("connections.revoke")}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
