import type { FastifyInstance } from "fastify";
import type { MetricsCollector } from "../system/metrics";

/** Real process/host/DB/worker metrics plus the sampled history (ring buffer) for sparklines. */
export async function metricsRoutes(app: FastifyInstance, opts: { collector: MetricsCollector }) {
  app.get("/api/v1/system/metrics", async () => opts.collector.snapshot());
  app.get("/api/v1/system/metrics/history", async () => ({ points: opts.collector.getHistory() }));
}
