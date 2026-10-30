import { z } from "zod";
import { SUPPORTED_LOCALES } from "@infuture/i18n";

const booleanFlag = z.enum(["true", "false", "1", "0", ""]).transform((v) => v === "true" || v === "1");

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
  /** Admin/service bearer token accepted on every /api/v1 route; required for custom code tools when API_HOST is not loopback. */
  API_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16).optional()),
  /** Allow new accounts after the first one (which becomes the workspace owner). Closed by default. */
  AUTH_SIGNUP_OPEN: booleanFlag.default("false"),
  /** Login session lifetime in hours. */
  AUTH_SESSION_TTL_HOURS: z.coerce
    .number()
    .positive()
    .max(24 * 365)
    .default(168),
  /** Mark the session cookie Secure (HTTPS only). Defaults to true in production. */
  AUTH_COOKIE_SECURE: booleanFlag.optional(),
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
