import { defineConfig } from "drizzle-kit";

// Reads DATABASE_URL from the root .env when it exists / Lee DATABASE_URL del .env raíz si existe.
try {
  process.loadEnvFile("../../.env");
} catch {
  // No .env file: use the environment or the local default.
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://infuture:infuture@localhost:5432/infuture",
  },
  strict: true,
  verbose: true,
});
