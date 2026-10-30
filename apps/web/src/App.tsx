import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCurrency, formatDateTime, formatNumber } from "@infuture/i18n";
import { ApiStatus } from "./components/ApiStatus";
import { Connections } from "./components/Connections";
import { Dashboard } from "./components/Dashboard";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { RunsView } from "./components/RunsView";
import { KnowledgeView } from "./components/KnowledgeView";
import { WorkspacesView } from "./components/WorkspacesView";
import { SettingsView } from "./components/SettingsView";
import { Terminal } from "./components/Terminal";
import { useLocale } from "./i18n";
import { UserMenu } from "./auth";

// Three.js is heavy: load the 3D office only when that view is opened.
const Office3D = lazy(() => import("./components/Office3D").then((m) => ({ default: m.Office3D })));

type View =
  | "dashboard"
  | "terminal"
  | "office"
  | "connections"
  | "runs"
  | "knowledge"
  | "workspaces"
  | "settings";

const ROLES = [
  "supervisor",
  "researcher",
  "analyst",
  "developer",
  "writer",
  "reviewer",
  "receptionist",
] as const;
const PHASES = [
  "foundations",
  "providers",
  "worker",
  "realtime",
  "multiagent",
  "terminal",
  "tools",
  "settings",
] as const;
const NAV = [
  "dashboard",
  "terminal",
  "office",
  "connections",
  "runs",
  "knowledge",
  "workspaces",
  "settings",
] as const;
const ROLE_COLORS: Record<(typeof ROLES)[number], string> = {
  supervisor: "var(--accent)",
  researcher: "var(--sky)",
  analyst: "var(--ok)",
  developer: "var(--warn)",
  writer: "var(--pink)",
  reviewer: "var(--coral)",
  receptionist: "#2dd4bf",
};

// Example figures for the formatting card, clearly an example rather than real usage.
const SAMPLE = { tokens: 1_284_000, cost: 4.18, smallCost: 0.0042, date: Date.UTC(2026, 9, 21, 14, 30) };

export function App() {
  const { t } = useTranslation();
  const locale = useLocale();

  const [view, setView] = useState<View>(() => {
    const h = window.location.hash;
    if (h === "#terminal") return "terminal";
    if (h === "#office") return "office";
    if (h === "#connections") return "connections";
    if (h === "#runs") return "runs";
    if (h === "#knowledge") return "knowledge";
    if (h === "#workspaces") return "workspaces";
    if (h === "#settings") return "settings";
    return "dashboard";
  });

  useEffect(() => {
    const handleHash = () => {
      const h = window.location.hash;
      if (h === "#terminal") setView("terminal");
      else if (h === "#office") setView("office");
      else if (h === "#connections") setView("connections");
      else if (h === "#runs") setView("runs");
      else if (h === "#knowledge") setView("knowledge");
      else if (h === "#workspaces") setView("workspaces");
      else if (h === "#settings") setView("settings");
      else setView("dashboard");
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  const navigateTo = (newView: View) => {
    window.location.hash = newView === "dashboard" ? "#dashboard" : `#${newView}`;
    setView(newView);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="#dashboard" onClick={() => navigateTo("dashboard")}>
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            <rect
              x="1"
              y="1"
              width="24"
              height="24"
              rx="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle cx="13" cy="9" r="3" fill="var(--accent)" />
            <circle cx="7.5" cy="18" r="2.5" fill="currentColor" />
            <circle cx="18.5" cy="18" r="2.5" fill="currentColor" />
          </svg>
          {t("app.name")}
        </a>
        <nav aria-label={t("nav.main")} className="nav">
          {NAV.map((item) => {
            const active = view === item;
            return (
              <a
                key={item}
                href={`#${item}`}
                aria-current={active ? "page" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigateTo(item);
                }}
              >
                {t(`nav.${item}`)}
              </a>
            );
          })}
        </nav>
        <LanguageSwitcher />
        <UserMenu />
      </header>

      <main className={view === "office" ? "main main-office" : "main"}>
        {view === "office" && (
          <Suspense fallback={<p className="office-loading">{t("office.loading")}</p>}>
            <Office3D />
          </Suspense>
        )}
        {view === "connections" && <Connections />}
        {view === "runs" && <RunsView />}
        {view === "knowledge" && <KnowledgeView />}
        {view === "workspaces" && <WorkspacesView />}
        {view === "settings" && <SettingsView />}

        {view === "terminal" && (
          <>
            <section className="hero">
              <p className="eyebrow mono">{t("home.eyebrow")}</p>
              <h1>{t("terminal.title")}</h1>
              <p className="lead">{t("terminal.subtitle")}</p>
            </section>
            <Terminal />
          </>
        )}

        {view === "dashboard" && (
          <>
            <section className="hero">
              <p className="eyebrow mono">{t("home.eyebrow")}</p>
              <h1>{t("home.title")}</h1>
              <p className="lead">{t("home.subtitle")}</p>
            </section>

            <Dashboard />

            <div className="grid" style={{ marginTop: "32px" }}>
              <ApiStatus />

              <section className="card" aria-labelledby="fmt-title">
                <div className="card-head">
                  <h2 id="fmt-title">{t("home.formatTitle")}</h2>
                </div>
                <p className="muted">{t("home.formatHint")}</p>
                <dl className="figures">
                  <div>
                    <dt>{t("home.tokens")}</dt>
                    <dd className="mono">{formatNumber(locale, SAMPLE.tokens)}</dd>
                  </div>
                  <div>
                    <dt>{t("home.cost")}</dt>
                    <dd className="mono">
                      {formatCurrency(locale, SAMPLE.cost)} · {formatCurrency(locale, SAMPLE.smallCost)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("home.date")}</dt>
                    <dd className="mono">{formatDateTime(locale, SAMPLE.date)}</dd>
                  </div>
                </dl>
              </section>

              <section className="card card-wide" aria-labelledby="roles-title">
                <div className="card-head">
                  <h2 id="roles-title">{t("home.rolesTitle")}</h2>
                </div>
                <p className="muted">{t("home.rolesHint")}</p>
                <ul className="roles">
                  {ROLES.map((role) => (
                    <li key={role} className="role">
                      <span
                        className="role-dot"
                        style={{ background: ROLE_COLORS[role] }}
                        aria-hidden="true"
                      />
                      <div>
                        <h3>{t(`roles.${role}.name`)}</h3>
                        <p>{t(`roles.${role}.description`)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card card-wide" aria-labelledby="roadmap-title">
                <div className="card-head">
                  <h2 id="roadmap-title">{t("home.roadmapTitle")}</h2>
                </div>
                <ol className="roadmap">
                  {PHASES.map((phase, index) => (
                    <li key={phase} className={index === 6 ? "is-current" : undefined}>
                      <span className="mono step">{index}</span>
                      <span>{t(`home.phases.${phase}`)}</span>
                      {index === 6 && <span className="tag">{t("home.current")}</span>}
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </>
        )}
      </main>

      <footer className="footer mono">
        {t("app.name")} · {t("app.tagline")}
      </footer>
    </div>
  );
}
