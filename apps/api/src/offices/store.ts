import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database, schema } from "@infuture/db";
import { LOCAL_WORKSPACE_ID } from "../connections/store";

/** Zones an office can include. Each one has a fixed slot on the 20x20 floor plan. */
export const OFFICE_ZONE_KEYS = ["dev", "meeting", "coffee", "servers", "reception"] as const;
export type OfficeZoneKey = (typeof OFFICE_ZONE_KEYS)[number];

export const OFFICE_ACCESSORIES = ["glasses", "headphones", "cap", "badge"] as const;
export type OfficeAccessory = (typeof OFFICE_ACCESSORIES)[number];

export type OfficeCharacter = {
  name: string;
  roleKey: string;
  color: string;
  shirt: string;
  hair: string;
  skin: string;
  accessory: OfficeAccessory;
};

export type OfficeRecord = {
  id: string;
  workspaceId: string;
  name: string;
  /** Accent color (hex) used for the theme. */
  theme: string;
  zones: OfficeZoneKey[];
  characters: OfficeCharacter[];
  /** Per-zone capacity overrides (people per zone); zones not listed use the UI default. */
  zoneCapacity: ZoneCapacity;
  isDefault: boolean;
  createdAt: Date;
};

export type ZoneCapacity = Partial<Record<OfficeZoneKey, number>>;

export type OfficeInput = Omit<
  OfficeRecord,
  "id" | "workspaceId" | "createdAt" | "isDefault" | "zoneCapacity"
> & {
  zoneCapacity?: ZoneCapacity;
};

/** Keeps only known zones with positive integer capacities. */
export function cleanZoneCapacity(raw: unknown): ZoneCapacity {
  const out: ZoneCapacity = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of OFFICE_ZONE_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

export interface OfficeStore {
  listOffices(workspaceId: string): Promise<OfficeRecord[]>;
  getOffice(workspaceId: string, id: string): Promise<OfficeRecord | undefined>;
  createOffice(workspaceId: string, input: OfficeInput): Promise<OfficeRecord>;
  updateOffice(
    workspaceId: string,
    id: string,
    updates: Partial<OfficeInput>,
  ): Promise<OfficeRecord | undefined>;
  /** The default office cannot be deleted. */
  deleteOffice(workspaceId: string, id: string): Promise<boolean>;
}

export const DEFAULT_OFFICE_ID = "office-hq";

export const DEFAULT_OFFICE_CHARACTERS: OfficeCharacter[] = [
  {
    name: "Carlos",
    roleKey: "fullstack",
    color: "#6366f1",
    shirt: "#4f46e5",
    hair: "#1e1b4b",
    skin: "#fcd34d",
    accessory: "glasses",
  },
  {
    name: "Sofía",
    roleKey: "ux",
    color: "#ec4899",
    shirt: "#db2777",
    hair: "#701a75",
    skin: "#fde68a",
    accessory: "headphones",
  },
  {
    name: "Mateo",
    roleKey: "sre",
    color: "#10b981",
    shirt: "#059669",
    hair: "#064e3b",
    skin: "#f59e0b",
    accessory: "cap",
  },
  {
    name: "Elena",
    roleKey: "product",
    color: "#f59e0b",
    shirt: "#d97706",
    hair: "#78350f",
    skin: "#fed7aa",
    accessory: "badge",
  },
];

export class MemoryOfficeStore implements OfficeStore {
  private offices = new Map<string, OfficeRecord>();

  constructor() {
    this.offices.set(DEFAULT_OFFICE_ID, {
      id: DEFAULT_OFFICE_ID,
      workspaceId: LOCAL_WORKSPACE_ID,
      name: "HQ",
      theme: "#6366f1",
      zones: [...OFFICE_ZONE_KEYS],
      characters: DEFAULT_OFFICE_CHARACTERS.map((c) => ({ ...c })),
      zoneCapacity: {},
      isDefault: true,
      createdAt: new Date(0),
    });
  }

  async listOffices(workspaceId: string) {
    return [...this.offices.values()]
      .filter((o) => o.workspaceId === workspaceId)
      .sort(
        (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.getTime() - b.createdAt.getTime(),
      );
  }

  async getOffice(workspaceId: string, id: string) {
    const o = this.offices.get(id);
    return o && o.workspaceId === workspaceId ? o : undefined;
  }

  async createOffice(workspaceId: string, input: OfficeInput) {
    const record: OfficeRecord = {
      ...input,
      zoneCapacity: cleanZoneCapacity(input.zoneCapacity),
      id: `office-${randomUUID()}`,
      workspaceId,
      isDefault: false,
      createdAt: new Date(),
    };
    this.offices.set(record.id, record);
    return record;
  }

  async updateOffice(workspaceId: string, id: string, updates: Partial<OfficeInput>) {
    const current = await this.getOffice(workspaceId, id);
    if (!current) return undefined;
    const defined = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
    const updated: OfficeRecord = { ...current, ...defined } as OfficeRecord;
    if (updates.zoneCapacity !== undefined) updated.zoneCapacity = cleanZoneCapacity(updates.zoneCapacity);
    this.offices.set(id, updated);
    return updated;
  }

  async deleteOffice(workspaceId: string, id: string) {
    const current = await this.getOffice(workspaceId, id);
    if (!current || current.isDefault) return false;
    return this.offices.delete(id);
  }
}

/* --------------------------------- PostgreSQL Store --------------------------------- */

type OfficeRow = typeof schema.offices.$inferSelect;

const toRecord = (r: OfficeRow): OfficeRecord => ({
  id: r.id,
  workspaceId: r.workspaceId,
  name: r.name,
  theme: r.theme,
  zones: r.zones.filter((z): z is OfficeZoneKey => (OFFICE_ZONE_KEYS as readonly string[]).includes(z)),
  characters: Array.isArray(r.characters) ? (r.characters as OfficeCharacter[]) : [],
  zoneCapacity: cleanZoneCapacity(r.zoneCapacity),
  isDefault: r.isDefault,
  createdAt: r.createdAt,
});

export class PgOfficeStore implements OfficeStore {
  private seeded = new Set<string>();

  constructor(
    private db: Database,
    private s: typeof schema,
  ) {}

  /** Seeds the default "office-hq" (and the local workspace row) once per process. */
  private async ensureDefault(workspaceId: string) {
    if (this.seeded.has(workspaceId) || workspaceId !== LOCAL_WORKSPACE_ID) return;
    const { workspaces, offices } = this.s;
    await this.db.insert(workspaces).values({ id: LOCAL_WORKSPACE_ID, name: "Local" }).onConflictDoNothing();
    await this.db
      .insert(offices)
      .values({
        id: DEFAULT_OFFICE_ID,
        workspaceId,
        name: "HQ",
        theme: "#6366f1",
        zones: [...OFFICE_ZONE_KEYS],
        characters: DEFAULT_OFFICE_CHARACTERS.map((c) => ({ ...c })),
        isDefault: true,
        createdAt: new Date(0),
      })
      .onConflictDoNothing();
    this.seeded.add(workspaceId);
  }

  async listOffices(workspaceId: string) {
    await this.ensureDefault(workspaceId);
    const { offices } = this.s;
    const rows = await this.db
      .select()
      .from(offices)
      .where(eq(offices.workspaceId, workspaceId))
      .orderBy(desc(offices.isDefault), asc(offices.createdAt));
    return rows.map(toRecord);
  }

  async getOffice(workspaceId: string, id: string) {
    await this.ensureDefault(workspaceId);
    const { offices } = this.s;
    const [row] = await this.db
      .select()
      .from(offices)
      .where(and(eq(offices.workspaceId, workspaceId), eq(offices.id, id)));
    return row ? toRecord(row) : undefined;
  }

  async createOffice(workspaceId: string, input: OfficeInput) {
    await this.ensureDefault(workspaceId);
    const [row] = await this.db
      .insert(this.s.offices)
      .values({
        id: `office-${randomUUID()}`,
        workspaceId,
        name: input.name,
        theme: input.theme,
        zones: input.zones,
        characters: input.characters,
        zoneCapacity: cleanZoneCapacity(input.zoneCapacity),
        isDefault: false,
      })
      .returning();
    if (!row) throw new Error("Failed to insert office");
    return toRecord(row);
  }

  async updateOffice(workspaceId: string, id: string, updates: Partial<OfficeInput>) {
    const current = await this.getOffice(workspaceId, id);
    if (!current) return undefined;
    const set: Partial<OfficeRow> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.theme !== undefined) set.theme = updates.theme;
    if (updates.zones !== undefined) set.zones = updates.zones;
    if (updates.characters !== undefined) set.characters = updates.characters;
    if (updates.zoneCapacity !== undefined) set.zoneCapacity = cleanZoneCapacity(updates.zoneCapacity);
    if (Object.keys(set).length === 0) return current;
    const { offices } = this.s;
    const [row] = await this.db
      .update(offices)
      .set(set)
      .where(and(eq(offices.workspaceId, workspaceId), eq(offices.id, id)))
      .returning();
    return row ? toRecord(row) : undefined;
  }

  async deleteOffice(workspaceId: string, id: string) {
    const { offices } = this.s;
    const rows = await this.db
      .delete(offices)
      .where(and(eq(offices.workspaceId, workspaceId), eq(offices.id, id), eq(offices.isDefault, false)))
      .returning({ id: offices.id });
    return rows.length > 0;
  }
}
