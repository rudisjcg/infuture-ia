import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { count, eq } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import { LOCAL_WORKSPACE_ID } from "../connections/store";

export type UserRole = "owner" | "admin" | "operator" | "viewer";

export type UserRecord = {
  id: string;
  email: string;
  displayName: string | null;
  locale: string;
  role: UserRole;
  createdAt: Date;
};

export type NewUser = {
  email: string;
  displayName: string | null;
  locale: string;
  passwordHash: string;
  role: UserRole;
};

export interface AuthStore {
  countUsers(): Promise<number>;
  createUser(input: NewUser): Promise<UserRecord>;
  findByEmail(email: string): Promise<{ user: UserRecord; passwordHash: string | null } | undefined>;
  getUser(id: string): Promise<UserRecord | undefined>;
  createSession(id: string, userId: string, expiresAt: Date): Promise<void>;
  getSession(id: string): Promise<{ userId: string; expiresAt: Date } | undefined>;
  deleteSession(id: string): Promise<void>;
}

/* ------------------------------- Password hashing ------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 64 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split("$");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const key = await scryptAsync(
    password,
    Buffer.from(saltB64, "base64"),
    Number(n),
    Number(r),
    Number(p),
    expected.length,
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/* ----------------------------------- Sessions ----------------------------------- */

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Sessions are stored by hash so a leaked database does not leak usable cookies. */
export function sessionId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/* ------------------------------------ Stores ------------------------------------ */

export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, { user: UserRecord; passwordHash: string | null }>();
  private sessions = new Map<string, { userId: string; expiresAt: Date }>();

  async countUsers() {
    return this.users.size;
  }

  async createUser(input: NewUser) {
    const email = normalizeEmail(input.email);
    if ([...this.users.values()].some((u) => u.user.email === email)) throw new EmailTakenError();
    const user: UserRecord = {
      id: randomUUID(),
      email,
      displayName: input.displayName,
      locale: input.locale,
      role: input.role,
      createdAt: new Date(),
    };
    this.users.set(user.id, { user, passwordHash: input.passwordHash });
    return user;
  }

  async findByEmail(email: string) {
    const target = normalizeEmail(email);
    return [...this.users.values()].find((u) => u.user.email === target);
  }

  async getUser(id: string) {
    return this.users.get(id)?.user;
  }

  async createSession(id: string, userId: string, expiresAt: Date) {
    this.sessions.set(id, { userId, expiresAt });
  }

  async getSession(id: string) {
    return this.sessions.get(id);
  }

  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
}

export class EmailTakenError extends Error {
  constructor() {
    super("email_taken");
  }
}

export class PgAuthStore implements AuthStore {
  constructor(
    private db: Database,
    private s: typeof schema,
  ) {}

  async countUsers() {
    const [row] = await this.db.select({ n: count() }).from(this.s.users);
    return Number(row?.n ?? 0);
  }

  async createUser(input: NewUser) {
    const { users, memberships, workspaces } = this.s;
    const email = normalizeEmail(input.email);
    return this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (existing.length > 0) throw new EmailTakenError();
      await tx.insert(workspaces).values({ id: LOCAL_WORKSPACE_ID, name: "Local" }).onConflictDoNothing();
      const id = randomUUID();
      const locale = input.locale === "es" ? "es" : "en";
      const [row] = await tx
        .insert(users)
        .values({ id, email, displayName: input.displayName, locale, passwordHash: input.passwordHash })
        .returning();
      await tx.insert(memberships).values({ workspaceId: LOCAL_WORKSPACE_ID, userId: id, role: input.role });
      return {
        id,
        email,
        displayName: row?.displayName ?? null,
        locale,
        role: input.role,
        createdAt: row?.createdAt ?? new Date(),
      };
    });
  }

  private async withRole(row: typeof this.s.users.$inferSelect): Promise<UserRecord> {
    const { memberships } = this.s;
    const [m] = await this.db
      .select({ role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, row.id));
    return {
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      locale: row.locale,
      role: m?.role ?? "viewer",
      createdAt: row.createdAt,
    };
  }

  async findByEmail(email: string) {
    const { users } = this.s;
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)));
    if (!row) return undefined;
    return { user: await this.withRole(row), passwordHash: row.passwordHash };
  }

  async getUser(id: string) {
    const { users } = this.s;
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row ? this.withRole(row) : undefined;
  }

  async createSession(id: string, userId: string, expiresAt: Date) {
    await this.db.insert(this.s.sessions).values({ id, userId, expiresAt });
  }

  async getSession(id: string) {
    const { sessions } = this.s;
    const [row] = await this.db.select().from(sessions).where(eq(sessions.id, id));
    return row ? { userId: row.userId, expiresAt: row.expiresAt } : undefined;
  }

  async deleteSession(id: string) {
    const { sessions } = this.s;
    await this.db.delete(sessions).where(eq(sessions.id, id));
  }
}
