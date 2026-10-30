import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Buildings, ChartBar, HardDrives, Trash, UsersThree, X } from "@phosphor-icons/react";
import {
  ALL_ZONE_KEYS,
  CHARACTER_TEMPLATES,
  ZONE_LAYOUT,
  type CharLive,
  type OfficeConfig,
  type Template,
  type ZoneKey,
} from "./officeModel";
import {
  ACTIVE_RUN,
  DEFAULT_ZONE_CAPACITY,
  assignTasks,
  completedFor,
  completedFromRuns,
  currentStep,
  doneToday,
  occupancy,
  racksFromServices,
  zoneCapacity,
  type ApiService,
  type CharTask,
  type HistoryPoint,
  type Rack,
  type Run,
} from "./officeLive";

/*
 * Multi-office support for the virtual office: persistence (API with a localStorage
 * fallback), live data (API /health + /api/v1/runs, simulated where nothing real exists),
 * the "create office" dialog and the office / zone dashboards.
 */

// ============================================================================
// Persistence
// ============================================================================
export type OfficeSource = "api" | "local";
const LOCAL_KEY = "infuture.office.offices";
export const DEFAULT_OFFICE_ID = "office-hq";

export const defaultOffice = (): OfficeConfig => ({
  id: DEFAULT_OFFICE_ID,
  name: "HQ",
  theme: "#6366f1",
  zones: [...ALL_ZONE_KEYS],
  characters: CHARACTER_TEMPLATES.slice(0, 4),
  isDefault: true,
});

type ApiOffice = Omit<OfficeConfig, "zones"> & { zones: string[] };

const toConfig = (o: ApiOffice): OfficeConfig => ({
  id: o.id,
  name: o.name,
  theme: o.theme,
  isDefault: o.isDefault,
  zones: o.zones.filter((z): z is ZoneKey => (ALL_ZONE_KEYS as string[]).includes(z)),
  characters: o.characters,
  zoneCapacity: o.zoneCapacity ?? {},
});

function readLocal(): OfficeConfig[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const list = raw ? (JSON.parse(raw) as ApiOffice[]).map(toConfig) : [];
    return list.some((o) => o.isDefault) ? list : [defaultOffice(), ...list];
  } catch {
    return [defaultOffice()];
  }
}
function writeLocal(list: OfficeConfig[]) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable (private mode): offices live for this session only.
  }
}

export async function loadOffices(): Promise<{ offices: OfficeConfig[]; source: OfficeSource }> {
  try {
    const res = await fetch("/api/v1/offices");
    if (!res.ok) throw new Error(String(res.status));
    const list = ((await res.json()) as ApiOffice[]).map(toConfig);
    if (list.length === 0) throw new Error("empty");
    return { offices: list, source: "api" };
  } catch {
    return { offices: readLocal(), source: "local" };
  }
}

export type NewOffice = Omit<OfficeConfig, "id" | "isDefault">;

export async function createOffice(
  input: NewOffice,
  source: OfficeSource,
  current: OfficeConfig[],
): Promise<{ office: OfficeConfig; source: OfficeSource }> {
  if (source === "api") {
    try {
      const res = await fetch("/api/v1/offices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.ok) return { office: toConfig((await res.json()) as ApiOffice), source: "api" };
    } catch {
      // Fall through to local storage.
    }
  }
  const office: OfficeConfig = { ...input, id: `office-local-${Date.now().toString(36)}`, isDefault: false };
  writeLocal([...current.filter((o) => o.id !== office.id), office]);
  return { office, source: "local" };
}

export type OfficeUpdate = Partial<Omit<OfficeConfig, "id" | "isDefault">>;

/** PUT /api/v1/offices/:id; falls back to localStorage when the API is unavailable. */
export async function updateOffice(
  id: string,
  updates: OfficeUpdate,
  source: OfficeSource,
  current: OfficeConfig[],
): Promise<{ office: OfficeConfig | undefined; source: OfficeSource }> {
  if (source === "api") {
    try {
      const res = await fetch(`/api/v1/offices/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (res.ok) return { office: toConfig((await res.json()) as ApiOffice), source: "api" };
    } catch {
      // Fall through to local storage.
    }
  }
  const base = current.find((o) => o.id === id);
  if (!base) return { office: undefined, source: "local" };
  const office: OfficeConfig = { ...base, ...updates };
  writeLocal(current.map((o) => (o.id === id ? office : o)));
  return { office, source: "local" };
}

export async function deleteOffice(id: string, source: OfficeSource, current: OfficeConfig[]) {
  if (source === "api") {
    try {
      await fetch(`/api/v1/offices/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      // Ignore: the list is reloaded by the caller.
    }
  } else {
    writeLocal(current.filter((o) => o.id !== id));
  }
}

// ============================================================================
// Live data (real from the API; simulated only while the API is unreachable)
// ============================================================================
export type { Rack } from "./officeLive";
export type LiveData = {
  apiOk: boolean;
  uptimeSec: number;
  runs: Run[];
  racks: Rack[];
  /** Current step title per active run id. */
  steps: Record<string, string>;
  /** API-side sampled history (ring buffer), so sparklines have data on open. */
  history: HistoryPoint[];
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const walk = (v: number, amp: number, lo: number, hi: number) =>
  clamp(v + (Math.random() - 0.5) * amp, lo, hi);

/** Offline-only simulation, clearly flagged with `real: false`. */
const simulatedRacks = (prev: Rack[]): Rack[] => {
  const base: Rack[] =
    prev.length > 0 && prev.every((r) => !r.real)
      ? prev
      : [
          {
            name: "api",
            kind: "api",
            status: "down",
            cpu: 30,
            mem: 45,
            latency: null,
            uptimeSec: null,
            real: false,
          },
        ];
  return base.map((r) => ({ ...r, cpu: walk(r.cpu ?? 30, 14, 5, 98), mem: walk(r.mem ?? 45, 6, 15, 95) }));
};

export function useLiveData(): LiveData {
  const [data, setData] = useState<LiveData>(() => ({
    apiOk: false,
    uptimeSec: 0,
    runs: [],
    racks: [],
    steps: {},
    history: [],
  }));

  useEffect(() => {
    let alive = true;
    let historyLoaded = false;
    const tick = async () => {
      let apiOk = false;
      let uptimeSec = 0;
      let latency: number | null = null;
      let runs: Run[] = [];
      let services: ApiService[] | null = null;
      let history: HistoryPoint[] | null = null;
      const steps: Record<string, string> = {};
      try {
        const t0 = performance.now();
        const res = await fetch("/health");
        latency = Math.round(performance.now() - t0);
        if (res.ok) {
          const body = (await res.json()) as { uptimeSec?: number };
          apiOk = true;
          uptimeSec = body.uptimeSec ?? 0;
        }
        const [rr, mr] = await Promise.all([fetch("/api/v1/runs"), fetch("/api/v1/system/metrics")]);
        if (rr.ok) runs = (await rr.json()) as Run[];
        if (mr.ok) services = ((await mr.json()) as { services: ApiService[] }).services;
        if (!historyLoaded || Math.random() < 0.2) {
          const hr = await fetch("/api/v1/system/metrics/history");
          if (hr.ok) {
            history = ((await hr.json()) as { points: HistoryPoint[] }).points;
            historyLoaded = true;
          }
        }
        const active = runs.filter((r) => ACTIVE_RUN.has(r.status)).slice(0, 8);
        await Promise.all(
          active.map(async (r) => {
            const dr = await fetch(`/api/v1/runs/${encodeURIComponent(r.id)}`);
            if (!dr.ok) return;
            const step = currentStep(
              ((await dr.json()) as { tasks?: { title: string; status: string }[] }).tasks ?? [],
            );
            if (step) steps[r.id] = step;
          }),
        );
      } catch {
        // Keep whatever was gathered; apiOk stays false if /health failed.
      }
      if (!alive) return;
      setData((prev) => {
        const hist = history ?? prev.history;
        return {
          apiOk,
          uptimeSec,
          runs,
          steps,
          history: hist,
          racks: apiOk && services ? racksFromServices(services, hist, latency) : simulatedRacks(prev.racks),
        };
      });
    };
    void tick();
    const id = window.setInterval(() => void tick(), 3000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return data;
}

/** Text for a character's current task: real run + step, "available", or a labeled demo task (offline). */
export function taskText(t: TFunction, task: CharTask): string | null {
  if (task.kind === "run") {
    const goal = task.goal.slice(0, 80);
    return task.step
      ? t("office.dash.runStep", { goal, step: task.step.slice(0, 60) })
      : t("office.dash.runTask", { goal });
  }
  if (task.kind === "demo") {
    const demo = t(`office.demoTasks.${task.roleKey}` as "office.demoTasks.qa", { defaultValue: "" });
    return demo ? t("office.dash.demoTask", { task: demo }) : null;
  }
  return null;
}

const capacityOf = (office: OfficeConfig, zone: ZoneKey) => zoneCapacity(zone, office.zoneCapacity);

/** Assigns a new run to a character explicitly (office, zone and character are stored on the run). */
export async function assignRun(goal: string, officeId: string, c: CharLive): Promise<boolean> {
  try {
    const res = await fetch("/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal,
        officeId,
        characterId: String(c.id),
        ...(c.zone !== "hallway" ? { zone: c.zone } : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Seat inputs per zone; empty means "use the default". */
function CapacityInputs({
  zones,
  value,
  onChange,
}: {
  zones: ZoneKey[];
  value: Partial<Record<ZoneKey, number>>;
  onChange: (v: Partial<Record<ZoneKey, number>>) => void;
}) {
  const { t } = useTranslation();
  if (zones.length === 0) return null;
  return (
    <div className="ov-field">
      <span className="ov-caption">{t("office.create.capacity")}</span>
      <div className="ov-zone-checks">
        {zones.map((z) => (
          <label key={z} className="ov-check is-on">
            <span className="ov-label-dot" style={{ background: ZONE_LAYOUT[z].color }} />
            <span>{t(`office.zones.${z}`)}</span>
            <input
              type="number"
              className="ov-text ov-cap-input"
              min={1}
              max={50}
              aria-label={t("office.create.capacityFor", { zone: t(`office.zones.${z}`) })}
              placeholder={String(DEFAULT_ZONE_CAPACITY[z] ?? 4)}
              value={value[z] ?? ""}
              onChange={(e) => {
                const next = { ...value };
                const v = Math.round(Number(e.target.value));
                if (e.target.value === "" || !Number.isFinite(v) || v < 1) delete next[z];
                else next[z] = Math.min(50, v);
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

/** Keeps only capacities of zones the office includes. */
const capacityForZones = (cap: Partial<Record<ZoneKey, number>>, zones: ZoneKey[]) =>
  Object.fromEntries(Object.entries(cap).filter(([k]) => zones.includes(k as ZoneKey))) as Partial<
    Record<ZoneKey, number>
  >;

/** Occupancy samples kept per office/zone for the whole session, so reopening shows history. */
const occHistory = new Map<string, number[]>();

const fmtUptime = (sec: number) => {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${sec % 60}s`;
};

// ============================================================================
// Create office dialog
// ============================================================================
const THEMES = ["#6366f1", "#10b981", "#f59e0b", "#0ea5e9", "#ec4899", "#a855f7"];
const PRESETS: Record<string, { zones: ZoneKey[]; people: number }> = {
  full: { zones: [...ALL_ZONE_KEYS], people: 4 },
  dev: { zones: ["dev", "meeting", "coffee"], people: 4 },
  ops: { zones: ["servers", "dev", "reception"], people: 3 },
  minimal: { zones: ["reception", "coffee"], people: 2 },
};

export function CreateOfficeDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (o: NewOffice) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [theme, setTheme] = useState(THEMES[0]!);
  const [preset, setPreset] = useState("full");
  const [zones, setZones] = useState<ZoneKey[]>(PRESETS.full!.zones);
  const [people, setPeople] = useState(4);
  const [capacity, setCapacity] = useState<Partial<Record<ZoneKey, number>>>({});

  const applyPreset = (key: string) => {
    setPreset(key);
    const p = PRESETS[key];
    if (p) {
      setZones(p.zones);
      setPeople(p.people);
    }
  };
  const toggleZone = (z: ZoneKey) =>
    setZones((prev) => (prev.includes(z) ? prev.filter((x) => x !== z) : [...prev, z]));

  const valid = name.trim().length > 0 && zones.length > 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const characters: Template[] = Array.from(
      { length: people },
      (_, i) => CHARACTER_TEMPLATES[i % CHARACTER_TEMPLATES.length]!,
    );
    const ordered = ALL_ZONE_KEYS.filter((z) => zones.includes(z));
    onCreate({
      name: name.trim(),
      theme,
      zones: ordered,
      characters,
      zoneCapacity: capacityForZones(capacity, ordered),
    });
  };

  return (
    <div className="ov-modal-backdrop" onMouseDown={onCancel}>
      <form className="ov-glass ov-modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="ov-modal-head">
          <span className="ov-inline">
            <Buildings weight="duotone" className="ov-indigo" />
            <h2 className="ov-h2">{t("office.create.title")}</h2>
          </span>
          <button type="button" className="ov-icon-btn" onClick={onCancel} title={t("office.create.cancel")}>
            <X weight="bold" />
          </button>
        </div>

        <label className="ov-field">
          <span className="ov-caption">{t("office.create.name")}</span>
          <input
            className="ov-text"
            autoFocus
            maxLength={80}
            value={name}
            placeholder={t("office.create.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="ov-field">
          <span className="ov-caption">{t("office.create.theme")}</span>
          <div className="ov-swatches">
            {THEMES.map((c) => (
              <button
                type="button"
                key={c}
                className={`ov-swatch${c === theme ? " is-on" : ""}`}
                style={{ background: c }}
                onClick={() => setTheme(c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>

        <label className="ov-field">
          <span className="ov-caption">{t("office.create.template")}</span>
          <select className="ov-text" value={preset} onChange={(e) => applyPreset(e.target.value)}>
            {Object.keys(PRESETS).map((k) => (
              <option key={k} value={k}>
                {t(`office.create.templates.${k}` as "office.create.templates.full")}
              </option>
            ))}
          </select>
        </label>

        <div className="ov-field">
          <span className="ov-caption">{t("office.create.zones")}</span>
          <div className="ov-zone-checks">
            {ALL_ZONE_KEYS.map((z) => (
              <label key={z} className={`ov-check${zones.includes(z) ? " is-on" : ""}`}>
                <input type="checkbox" checked={zones.includes(z)} onChange={() => toggleZone(z)} />
                <span className="ov-label-dot" style={{ background: ZONE_LAYOUT[z].color }} />
                <span>{t(`office.zones.${z}`)}</span>
              </label>
            ))}
          </div>
          {zones.length === 0 && <span className="ov-error">{t("office.create.needZone")}</span>}
        </div>

        <CapacityInputs
          zones={ALL_ZONE_KEYS.filter((z) => zones.includes(z))}
          value={capacity}
          onChange={setCapacity}
        />

        <label className="ov-field">
          <span className="ov-between">
            <span className="ov-caption">{t("office.create.people")}</span>
            <span className="mono ov-indigo">{people}</span>
          </span>
          <input
            type="range"
            min={1}
            max={CHARACTER_TEMPLATES.length}
            value={people}
            onChange={(e) => setPeople(Number(e.target.value))}
          />
        </label>

        <div className="ov-modal-actions">
          <button type="button" className="ov-tbtn ov-render" onClick={onCancel}>
            {t("office.create.cancel")}
          </button>
          <button type="submit" className="ov-new" disabled={!valid}>
            {t("office.create.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================================
// Edit office dialog
// ============================================================================
export function EditOfficeDialog({
  office,
  onCancel,
  onSave,
}: {
  office: OfficeConfig;
  onCancel: () => void;
  onSave: (u: OfficeUpdate) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(office.name);
  const [theme, setTheme] = useState(office.theme);
  const [zones, setZones] = useState<ZoneKey[]>(office.zones);
  const [capacity, setCapacity] = useState<Partial<Record<ZoneKey, number>>>(office.zoneCapacity ?? {});
  const toggleZone = (z: ZoneKey) =>
    setZones((prev) => (prev.includes(z) ? prev.filter((x) => x !== z) : [...prev, z]));
  const valid = name.trim().length > 0 && zones.length > 0;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const ordered = ALL_ZONE_KEYS.filter((z) => zones.includes(z));
    onSave({ name: name.trim(), theme, zones: ordered, zoneCapacity: capacityForZones(capacity, ordered) });
  };
  const swatches = THEMES.includes(theme) ? THEMES : [theme, ...THEMES];

  return (
    <div className="ov-modal-backdrop" onMouseDown={onCancel}>
      <form className="ov-glass ov-modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="ov-modal-head">
          <span className="ov-inline">
            <Buildings weight="duotone" className="ov-indigo" />
            <h2 className="ov-h2">{t("office.edit.title")}</h2>
          </span>
          <button type="button" className="ov-icon-btn" onClick={onCancel} title={t("office.edit.cancel")}>
            <X weight="bold" />
          </button>
        </div>

        <label className="ov-field">
          <span className="ov-caption">{t("office.edit.name")}</span>
          <input
            className="ov-text"
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="ov-field">
          <span className="ov-caption">{t("office.edit.theme")}</span>
          <div className="ov-swatches">
            {swatches.map((c) => (
              <button
                type="button"
                key={c}
                className={`ov-swatch${c === theme ? " is-on" : ""}`}
                style={{ background: c }}
                onClick={() => setTheme(c)}
                aria-label={c}
              />
            ))}
          </div>
        </div>

        <div className="ov-field">
          <span className="ov-caption">{t("office.edit.zones")}</span>
          <div className="ov-zone-checks">
            {ALL_ZONE_KEYS.map((z) => (
              <label key={z} className={`ov-check${zones.includes(z) ? " is-on" : ""}`}>
                <input type="checkbox" checked={zones.includes(z)} onChange={() => toggleZone(z)} />
                <span className="ov-label-dot" style={{ background: ZONE_LAYOUT[z].color }} />
                <span>{t(`office.zones.${z}`)}</span>
              </label>
            ))}
          </div>
          {zones.length === 0 && <span className="ov-error">{t("office.edit.needZone")}</span>}
        </div>

        <CapacityInputs
          zones={ALL_ZONE_KEYS.filter((z) => zones.includes(z))}
          value={capacity}
          onChange={setCapacity}
        />

        <div className="ov-modal-actions">
          <button type="button" className="ov-tbtn ov-render" onClick={onCancel}>
            {t("office.edit.cancel")}
          </button>
          <button type="submit" className="ov-new" disabled={!valid}>
            {t("office.edit.submit")}
          </button>
        </div>
      </form>
    </div>
  );
}

// ============================================================================
// Dashboards
// ============================================================================
export type DashScope = { kind: "office" } | { kind: "zone"; zone: ZoneKey };

function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 120;
  const h = 28;
  const max = Math.max(1, ...values);
  const pts = values
    .map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - (v / max) * (h - 4) - 2}`)
    .join(" ");
  return (
    <svg className="ov-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function Kpi({
  label,
  value,
  bar,
  color,
  spark,
}: {
  label: string;
  value: string;
  bar?: number;
  color: string;
  spark?: number[];
}) {
  return (
    <div className="ov-kpi">
      <span className="ov-tiny-muted">{label}</span>
      <span className="ov-kpi-value mono">{value}</span>
      {bar !== undefined && (
        <span className="ov-bar">
          <span style={{ width: `${clamp(bar, 0, 100)}%`, background: color }} />
        </span>
      )}
      {spark && <Sparkline values={spark} color={color} />}
    </div>
  );
}

export function OfficeDashboard({
  scope,
  office,
  snapshot,
  live,
  onClose,
  onDelete,
  onSelectChar,
  officeName,
}: {
  scope: DashScope;
  office: OfficeConfig;
  officeName: string;
  snapshot: () => CharLive[];
  live: LiveData;
  onClose: () => void;
  onDelete?: () => void;
  onSelectChar: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  const [assigning, setAssigning] = useState<number | null>(null);
  const [assignGoal, setAssignGoal] = useState("");
  const [assignMsg, setAssignMsg] = useState<{ id: number; ok: boolean } | null>(null);
  const simCompleted = useRef(5 + Math.floor(Math.random() * 10));
  const simAvg = useRef(4 + Math.random() * 5);
  const occKey = `${office.id}:${scope.kind === "office" ? "*" : scope.zone}`;

  const all = snapshot();
  const tasks = assignTasks(live.apiOk, live.runs, live.steps, office.id, all);
  const indexed = all.map((c, i) => ({ c, task: taskText(t, tasks[i] ?? { kind: "idle" }) }));
  const here = scope.kind === "office" ? indexed : indexed.filter((x) => x.c.zone === scope.zone);
  const activeTasks = here.filter((x) => x.task).length;
  const capacity =
    scope.kind === "office"
      ? office.zones.reduce((s, z) => s + capacityOf(office, z), 0)
      : capacityOf(office, scope.zone);
  const occupancyPct = occupancy(here.length, capacity);

  // Completed today / average duration from real runs when the API answers.
  const done = doneToday(live.runs);
  const completedInfo = live.apiOk
    ? completedFromRuns(done, office.id, scope.kind === "office" ? null : scope.zone, here.length, all.length)
    : {
        value: completedFor(simCompleted.current, here.length, all.length, scope.kind === "office").value,
        estimate: true,
      };
  const completed = completedInfo.value;
  const avgMin =
    live.apiOk && done.length > 0
      ? done.reduce((s, r) => s + (new Date(r.endedAt!).getTime() - new Date(r.startedAt).getTime()), 0) /
        done.length /
        60000
      : live.apiOk
        ? 0
        : simAvg.current;

  useEffect(() => {
    const id = window.setInterval(() => {
      occHistory.set(occKey, [...(occHistory.get(occKey) ?? []), here.length].slice(-60));
      if (!live.apiOk && Math.random() < 0.15) simCompleted.current += 1;
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(id);
  });

  const showServers = scope.kind === "office" ? office.zones.includes("servers") : scope.zone === "servers";
  const accent = scope.kind === "zone" ? ZONE_LAYOUT[scope.zone].color : office.theme;
  const title = scope.kind === "office" ? officeName : t(`office.zones.${scope.zone}`);
  const occSeries = occHistory.get(occKey) ?? [];
  const occSpark = occSeries.length > 1 ? occSeries : [here.length, here.length];
  // Active-runs history comes from the API ring buffer, so it is populated as soon as the panel opens.
  const runSeries = live.history.map((h) => h.activeRuns ?? 0);
  const taskSpark =
    live.apiOk && scope.kind === "office" && runSeries.length > 1 ? runSeries : [activeTasks, activeTasks];
  const statusLabel = useMemo(
    () => ({
      ok: t("office.dash.statusOk"),
      warn: t("office.dash.statusWarn"),
      down: t("office.dash.statusDown"),
      unknown: t("office.dash.statusUnknown"),
    }),
    [t],
  );

  return (
    <div className="ov-modal-backdrop" onMouseDown={onClose}>
      <section
        className="ov-glass ov-modal ov-dash"
        onMouseDown={(e) => e.stopPropagation()}
        style={{ borderColor: accent + "88" }}
      >
        <div className="ov-modal-head">
          <span className="ov-inline">
            <ChartBar weight="duotone" style={{ color: accent }} />
            <span>
              <span className="ov-tiny-muted">
                {t(scope.kind === "office" ? "office.dash.officeTitle" : "office.dash.zoneTitle")}
              </span>
              <h2 className="ov-h2">{title}</h2>
            </span>
          </span>
          <span className="ov-inline">
            {onDelete && (
              <button
                type="button"
                className="ov-icon-btn ov-danger"
                onClick={onDelete}
                title={t("office.dash.delete")}
              >
                <Trash weight="bold" />
              </button>
            )}
            <button type="button" className="ov-icon-btn" onClick={onClose} title={t("office.dash.close")}>
              <X weight="bold" />
            </button>
          </span>
        </div>
        <p className={`ov-source${live.apiOk ? " is-real" : ""}`}>
          {t(live.apiOk ? "office.dash.realData" : "office.dash.demoData")}
        </p>

        <span className="ov-caption">{t("office.dash.kpis")}</span>
        <div className="ov-kpis">
          <Kpi
            label={t("office.dash.occupancy")}
            value={`${here.length}/${capacity} · ${occupancyPct}%`}
            bar={occupancyPct}
            color={accent}
            spark={occSpark}
          />
          <Kpi
            label={t("office.dash.activeTasks")}
            value={String(activeTasks)}
            color="#10b981"
            spark={taskSpark}
          />
          <Kpi
            label={
              completedInfo.estimate
                ? `${t("office.dash.completedToday")} (${t("office.dash.estimate")})`
                : t("office.dash.completedToday")
            }
            value={String(completed)}
            color="#f59e0b"
            bar={Math.min(100, completed * 5)}
          />
          <Kpi
            label={t("office.dash.avgTime")}
            value={`${avgMin.toFixed(1)} min`}
            color="#0ea5e9"
            bar={Math.min(100, avgMin * 6)}
          />
          <Kpi label={t("office.dash.uptime")} value={fmtUptime(live.uptimeSec)} color="#a855f7" />
        </div>

        <span className="ov-caption ov-inline">
          <UsersThree weight="duotone" /> {t("office.dash.people", { count: here.length })}
        </span>
        <div className="ov-list">
          {here.length === 0 && <p className="ov-tiny-muted">{t("office.dash.empty")}</p>}
          {here.map(({ c, task }) => (
            <div key={c.id} className="ov-item" onClick={() => onSelectChar(c.id)}>
              <div className="ov-gap-25">
                <div className="ov-item-avatar" style={{ background: c.color }}>
                  {c.name.substring(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="ov-gap-15">
                    <span className="ov-item-name">{c.name}</span>
                    <span className="ov-item-role">
                      {t(`office.charRoles.${c.roleKey}` as "office.charRoles.fullstack")}
                    </span>
                  </div>
                  <span className="ov-item-state">
                    {c.moving
                      ? t("office.stateWalking", { zone: t(`office.zones.${c.zone}`) })
                      : t("office.stateIn", { zone: t(`office.zones.${c.zone}`) })}
                  </span>
                  <span className="ov-task">
                    {t("office.dash.task")}:{" "}
                    {task ?? t(live.apiOk ? "office.dash.available" : "office.dash.idle")}
                  </span>
                  {live.apiOk && assigning !== c.id && (
                    <button
                      type="button"
                      className="ov-tbtn ov-assign"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAssigning(c.id);
                        setAssignGoal("");
                        setAssignMsg(null);
                      }}
                    >
                      {t("office.dash.assign")}
                    </button>
                  )}
                  {assigning === c.id && (
                    <form
                      className="ov-assign-form"
                      onClick={(e) => e.stopPropagation()}
                      onSubmit={(e) => {
                        e.preventDefault();
                        const goal = assignGoal.trim();
                        if (!goal) return;
                        setAssigning(null);
                        setAssignMsg({ id: c.id, ok: true });
                        void assignRun(goal, office.id, c).then((ok) => setAssignMsg({ id: c.id, ok }));
                      }}
                    >
                      <input
                        className="ov-text"
                        autoFocus
                        maxLength={5000}
                        value={assignGoal}
                        placeholder={t("office.dash.assignPlaceholder")}
                        onChange={(e) => setAssignGoal(e.target.value)}
                      />
                      <button type="submit" className="ov-new" disabled={!assignGoal.trim()}>
                        {t("office.dash.assignSubmit")}
                      </button>
                    </form>
                  )}
                  {assignMsg?.id === c.id && (
                    <span className={assignMsg.ok ? "ov-tiny-muted" : "ov-error"}>
                      {t(assignMsg.ok ? "office.dash.assignSent" : "office.dash.assignError")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {showServers && (
          <>
            <span className="ov-caption ov-inline">
              <HardDrives weight="duotone" className="ov-sky" /> {t("office.dash.servers")}
            </span>
            <div className="ov-racks">
              {live.racks.map((r) => (
                <div key={r.name} className={`ov-rack is-${r.status}`}>
                  <div className="ov-between">
                    <span className="mono ov-item-name">
                      {r.name}
                      {!r.real && ` (${t("office.dash.simulated")})`}
                    </span>
                    <span className="ov-rack-status">{statusLabel[r.status]}</span>
                  </div>
                  {r.detail && <span className="ov-tiny-muted mono">{r.detail}</span>}
                  {r.cpu !== null && (
                    <div className="ov-rack-row">
                      <span>{t("office.dash.cpu")}</span>
                      <span className="ov-bar">
                        <span style={{ width: `${r.cpu}%`, background: "#6366f1" }} />
                      </span>
                      <span className="mono">{Math.round(r.cpu)}%</span>
                    </div>
                  )}
                  {r.mem !== null && (
                    <div className="ov-rack-row">
                      <span>{t("office.dash.mem")}</span>
                      <span className="ov-bar">
                        <span style={{ width: `${r.mem}%`, background: "#10b981" }} />
                      </span>
                      <span className="mono">{Math.round(r.mem)}%</span>
                    </div>
                  )}
                  {r.cpuHistory && <Sparkline values={r.cpuHistory} color="#6366f1" />}
                  <div className="ov-between mono ov-tiny-muted ov-rack-meta">
                    <span>
                      {t("office.dash.latency")}: {r.latency !== null ? `${r.latency} ms` : "—"}
                    </span>
                    <span>
                      {t("office.dash.uptime")}: {r.uptimeSec !== null ? fmtUptime(r.uptimeSec) : "—"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
