/*
 * Shared office model (zones, character templates, office config). Kept apart from
 * Office3D/OfficeHub so neither imports the other for these values (avoids an import cycle).
 */
export type ZoneKey = "dev" | "meeting" | "coffee" | "servers" | "reception";
export type ZoneOrHall = ZoneKey | "hallway";

export type ZoneDef = {
  x: number;
  z: number;
  radius: number;
  color: string;
  /** Floor rug (center, size, color). Reception uses a round rug. */
  rug: { x: number; z: number; w: number; d: number; color: number; round?: boolean };
};

/** Fixed slot of each zone on the 20x20 floor plan; an office picks which zones it includes. */
export const ZONE_LAYOUT: Record<ZoneKey, ZoneDef> = {
  dev: {
    x: -4.5,
    z: -4.2,
    radius: 4.2,
    color: "#6366f1",
    rug: { x: -5.0, z: -5.0, w: 7.5, d: 6.5, color: 0x312e81 },
  },
  meeting: {
    x: 5.0,
    z: -5.0,
    radius: 3.8,
    color: "#10b981",
    rug: { x: 5.0, z: -5.0, w: 7.0, d: 6.5, color: 0x064e3b },
  },
  coffee: {
    x: -5.2,
    z: 5.2,
    radius: 3.8,
    color: "#f59e0b",
    rug: { x: -5.0, z: 5.2, w: 7.2, d: 6.2, color: 0x78350f },
  },
  servers: {
    x: 5.8,
    z: 5.2,
    radius: 3.5,
    color: "#0ea5e9",
    rug: { x: 5.5, z: 5.2, w: 6.5, d: 6.2, color: 0x0c4a6e },
  },
  reception: {
    x: 0.0,
    z: 0.0,
    radius: 3.0,
    color: "#a855f7",
    rug: { x: 0, z: 0, w: 2.6, d: 2.6, color: 0x3b0764, round: true },
  },
};
export const ALL_ZONE_KEYS = Object.keys(ZONE_LAYOUT) as ZoneKey[];

export type Accessory = "glasses" | "headphones" | "cap" | "badge";
export type Template = {
  name: string;
  roleKey: string;
  color: string;
  shirt: string;
  hair: string;
  skin: string;
  accessory: Accessory;
};

export const CHARACTER_TEMPLATES: Template[] = [
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
  {
    name: "Diego",
    roleKey: "qa",
    color: "#06b6d4",
    shirt: "#0891b2",
    hair: "#0f172a",
    skin: "#fcd34d",
    accessory: "glasses",
  },
  {
    name: "Valeria",
    roleKey: "data",
    color: "#a855f7",
    shirt: "#9333ea",
    hair: "#3b0764",
    skin: "#fde68a",
    accessory: "headphones",
  },
  {
    name: "Lucas",
    roleKey: "ai",
    color: "#f43f5e",
    shirt: "#e11d48",
    hair: "#31102f",
    skin: "#fbd38d",
    accessory: "cap",
  },
];

/** What an office needs to build its scene. */
export type OfficeConfig = {
  id: string;
  name: string;
  theme: string;
  zones: ZoneKey[];
  characters: Template[];
  /** Per-zone seat overrides; zones not listed use DEFAULT_ZONE_CAPACITY. */
  zoneCapacity?: Partial<Record<ZoneKey, number>>;
  isDefault: boolean;
};

export type CharSummary = { id: number; name: string; roleKey: string; color: string };
/** Live view of a character for dashboards. */
export type CharLive = CharSummary & { zone: ZoneOrHall; moving: boolean };
