/**
 * URL for the realtime WebSocket. Locally it is same-origin (Vite proxies it); in production the
 * socket can point straight at the API (VITE_REALTIME_URL), because static hosts such as Render
 * cannot proxy WebSockets. The session cookie does not travel to that host, so a short-lived,
 * single-use ticket is fetched over HTTP (same origin, cookie auth) and passed as `?ticket=`.
 */
export async function realtimeUrl(): Promise<string> {
  const configured = import.meta.env.VITE_REALTIME_URL as string | undefined;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = configured || `${protocol}//${window.location.host}/api/v1/realtime`;
  try {
    const res = await fetch("/api/v1/realtime/ticket", { method: "POST" });
    if (res.ok) {
      const { ticket } = (await res.json()) as { ticket: string };
      return `${url}?ticket=${encodeURIComponent(ticket)}`;
    }
  } catch {
    // Fall back to cookie auth (works when the socket is same-origin).
  }
  return url;
}
