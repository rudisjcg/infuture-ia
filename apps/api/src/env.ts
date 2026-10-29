import { z } from "zod";
import { SUPPORTED_LOCALES } from "@infuture/i18n";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  DEFAULT_LOCALE: z.enum(SUPPORTED_LOCALES).default("en"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  INFUTURE_MASTER_KEY: z.string().optional(),
  /** Bearer token for sensitive endpoints (custom code tools). Required when API_HOST is not loopback. */
  API_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
});

export type Env = z.infer<typeof envSchema>;

/** Validates environment variables once at startup, with clear messages instead of runtime surprises. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment variables / Variables de entorno no válidas:\n${details}`);
  }
  return result.data;
}
