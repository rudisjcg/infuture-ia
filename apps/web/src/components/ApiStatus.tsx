import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocale } from "../i18n";

type Info = { name: string; version: string; locale: string; message: string };
type State = { kind: "loading" } | { kind: "online"; info: Info } | { kind: "offline" };

/** Calls the API in the current language, which shows the server-side translations working end to end. */
export function ApiStatus() {
  const { t } = useTranslation();
  const locale = useLocale();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/info", { headers: { "X-Infuture-Locale": locale }, signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<Info>) : Promise.reject(new Error(String(res.status)))))
      .then((info) => setState({ kind: "online", info }))
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setState({ kind: "offline" });
      });
    return () => controller.abort();
  }, [locale, attempt]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <section className="card" aria-labelledby="api-title" aria-live="polite">
      <div className="card-head">
        <h2 id="api-title">{t("home.apiTitle")}</h2>
        <span className={`pill pill-${state.kind}`}>
          <span className="pill-dot" aria-hidden="true" />
          {state.kind === "loading"
            ? t("common.loading")
            : state.kind === "online"
              ? t("common.online")
              : t("common.offline")}
        </span>
      </div>

      {state.kind === "online" && (
        <>
          <p className="muted">{t("home.apiSays")}</p>
          <blockquote className="api-quote" lang={state.info.locale}>
            {state.info.message}
          </blockquote>
          <p className="mono small muted">
            {state.info.name} · v{state.info.version} · Content-Language: {state.info.locale}
          </p>
        </>
      )}

      {state.kind === "offline" && (
        <>
          <p>{t("home.apiOffline")}</p>
          <p className="muted">{t("home.apiOfflineHint", { command: "pnpm dev" })}</p>
          <button type="button" className="btn" onClick={retry}>
            {t("common.retry")}
          </button>
        </>
      )}
    </section>
  );
}
