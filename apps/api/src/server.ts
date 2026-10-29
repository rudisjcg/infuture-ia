import { buildApp } from "./app";
import { PgConnectionStore, type ConnectionStore } from "./connections/store";
import { PgRunStore, type RunStore } from "./runs/store";
import { PgRoleStore, type RoleStore } from "./roles/store";
import { PgScheduleStore, type ScheduleStore } from "./schedules/store";
import { PgMcpServerStore, type McpServerStore } from "./tools/store";
import { PgKnowledgeStore, type KnowledgeStore } from "./memory/store";
import { PgWorkspaceStore, type WorkspaceStore } from "./workspaces/store";
import { PgOfficeStore, type OfficeStore } from "./offices/store";
import { loadEnv } from "./env";

// Load the root .env when present (Node 22+) / Carga el .env raíz si existe.
for (const file of ["../../.env", ".env"]) {
  try {
    process.loadEnvFile(file);
    break;
  } catch {
    // File not found: rely on the real environment.
  }
}

const env = loadEnv();

let store: ConnectionStore | undefined;
let runStore: RunStore | undefined;
let roleStore: RoleStore | undefined;
let scheduleStore: ScheduleStore | undefined;
let mcpStore: McpServerStore | undefined;
let knowledgeStore: KnowledgeStore | undefined;
let workspaceStore: WorkspaceStore | undefined;
let officeStore: OfficeStore | undefined;
let closeDb: (() => Promise<void>) | undefined;
let dbPing: (() => Promise<unknown>) | undefined;
if (env.DATABASE_URL) {
  const { createDb, schema } = await import("@infuture/db");
  const { db, close } = createDb(env.DATABASE_URL);
  store = new PgConnectionStore(db, schema);
  runStore = new PgRunStore(db, schema);
  roleStore = new PgRoleStore(db, schema);
  scheduleStore = new PgScheduleStore(db, schema);
  mcpStore = new PgMcpServerStore(db, schema);
  knowledgeStore = new PgKnowledgeStore(db, schema);
  workspaceStore = new PgWorkspaceStore(db, schema);
  officeStore = new PgOfficeStore(db, schema);
  closeDb = close;
  const { sql } = await import("drizzle-orm");
  dbPing = () => db.execute(sql`select 1`);
} else {
  console.warn(
    "DATABASE_URL is not set: connections, runs, and schedules are kept in memory and lost on restart.",
  );
}

const app = await buildApp(
  env,
  {},
  { store, runStore, roleStore, scheduleStore, mcpStore, knowledgeStore, workspaceStore, officeStore, dbPing },
);
app.addHook("onClose", async () => {
  await closeDb?.();
});

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    process.exit(0);
  });
}
