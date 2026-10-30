import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { useLocale } from "./i18n";

export type AuthUser = { id: string; email: string; displayName: string | null; role: string };
type Me = { kind: "user"; user: AuthUser } | { kind: "token"; user: null };

const UNAUTHORIZED_EVENT = "infuture:unauthorized";

/**
 * The API authenticates with an HttpOnly session cookie, which same-origin fetches send by default.
 * Wrapping fetch once lets every component's request report a 401 so the app can show the login screen.
 */
export function installFetchAuth() {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await original(input, { credentials: "same-origin", ...init });
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, window.location.href).pathname;
    if (res.status === 401 && path.startsWith("/api/") && !path.startsWith("/api/v1/auth/")) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    return res;
  };
}

type AuthContextValue = { me: Me; logout: () => Promise<void> };
const AuthContext = createContext<AuthContextValue | null>(null);

export const useAuth = () => useContext(AuthContext);

type State = { phase: "loading" } | { phase: "anonymous" } | { phase: "authenticated"; me: Me };

/** Renders the app only for an authenticated user (or service token); otherwise the login screen. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ phase: "loading" });

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/auth/me");
      setState(res.ok ? { phase: "authenticated", me: (await res.json()) as Me } : { phase: "anonymous" });
    } catch {
      setState({ phase: "anonymous" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setState({ phase: "anonymous" });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } finally {
      setState({ phase: "anonymous" });
    }
  }, []);

  if (state.phase === "loading") return <LoadingScreen />;
  if (state.phase === "anonymous") return <LoginScreen onSuccess={refresh} />;
  return <AuthContext.Provider value={{ me: state.me, logout }}>{children}</AuthContext.Provider>;
}

function LoadingScreen() {
  const { t } = useTranslation();
  return <p className="auth-loading muted">{t("auth.checking")}</p>;
}

function LoginScreen({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [status, setStatus] = useState<{ needsSetup: boolean; signupOpen: boolean } | null>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/v1/auth/status", { headers: { "X-Infuture-Locale": locale } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { needsSetup: boolean; signupOpen: boolean } | null) => {
        setStatus(s);
        if (s?.needsSetup) setMode("signup");
      })
      .catch(() => setStatus(null));
  }, [locale]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === "signup" ? { email, password, displayName: displayName || undefined } : { email, password };
      const res = await fetch(`/api/v1/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(data?.error?.message ?? t("auth.failed"));
        return;
      }
      setPassword("");
      await onSuccess();
    } catch {
      setError(t("auth.failed"));
    } finally {
      setBusy(false);
    }
  };

  const title = status?.needsSetup
    ? t("auth.setupTitle")
    : mode === "signup"
      ? t("auth.signupTitle")
      : t("auth.loginTitle");

  return (
    <div className="auth-screen">
      <div className="auth-lang">
        <LanguageSwitcher />
      </div>
      <section className="card auth-card" aria-labelledby="auth-title">
        <p className="eyebrow mono">{t("app.name")}</p>
        <h1 id="auth-title">{title}</h1>
        {status?.needsSetup && <p className="muted">{t("auth.setupHint")}</p>}
        <form className="auth-form" onSubmit={(e) => void submit(e)}>
          {error && (
            <div className="form-error-banner" role="alert">
              {error}
            </div>
          )}
          {mode === "signup" && (
            <div className="form-group">
              <label htmlFor="auth-name">{t("auth.displayName")}</label>
              <input
                id="auth-name"
                className="input"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          )}
          <div className="form-group">
            <label htmlFor="auth-email">{t("auth.email")}</label>
            <input
              id="auth-email"
              className="input"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="auth-password">{t("auth.password")}</label>
            <input
              id="auth-password"
              className="input"
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "signup" && <small className="muted">{t("auth.passwordHint")}</small>}
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {mode === "signup" ? t("auth.submitSignup") : t("auth.submitLogin")}
          </button>
        </form>
        {!status?.needsSetup && (status?.signupOpen || mode === "signup") && (
          <button
            type="button"
            className="btn btn-ghost auth-switch"
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? t("auth.toSignup") : t("auth.toLogin")}
          </button>
        )}
      </section>
    </div>
  );
}

/** Header widget: who is signed in, plus the sign-out button. */
export function UserMenu() {
  const { t } = useTranslation();
  const auth = useAuth();
  if (!auth) return null;
  const name =
    auth.me.kind === "user" ? auth.me.user.displayName || auth.me.user.email : t("auth.serviceToken");
  return (
    <div className="user-menu">
      <span className="user-name muted" title={auth.me.kind === "user" ? auth.me.user.email : undefined}>
        {t("auth.signedInAs", { name })}
      </span>
      {auth.me.kind === "user" && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void auth.logout()}>
          {t("auth.logout")}
        </button>
      )}
    </div>
  );
}
