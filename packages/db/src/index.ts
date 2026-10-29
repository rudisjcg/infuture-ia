import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };

/** Opens a connection pool. Call `close()` on shutdown. */
export function createDb(databaseUrl: string, options: { max?: number } = {}) {
  const client = postgres(databaseUrl, { max: options.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end() };
}

export type Database = ReturnType<typeof createDb>["db"];
