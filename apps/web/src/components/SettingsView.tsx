import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocale } from "../i18n";
import type { Connection } from "./Connections";

export type RoleItem = {
  id: string;
  version: number;
  name: string;
  names: Record<string, string>;
  description: string;
  descriptions: Record<string, string>;
  systemPrompt: Record<string, string>;
  requires: string[];
  prefers?: {
    color?: string;
    sprite?: string;
    description?: Record<string, string>;
  };
  tools: string[];
  limits?: {
    maxTokens?: number;
    maxCostUsd?: number;
    maxIterations?: number;
  };
  approval?: { sensitiveTools: string[] };
  sprite?: string;
  isCustom: boolean;
  worker?: {
    id: string;
    name: string;
    connectionId: string | null;
    modelKey: string | null;
    pinned: boolean;
    status: string;
  } | null;
};

export type ToolItem = {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  requiresApproval: boolean;
  isMcp?: boolean;
  isCustom?: boolean;
};

export type McpServerItem = {
  id: string;
  workspaceId: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  discoveredTools: Array<{
    name: string;
    description: string;
    parameters: Record<string, { type: string; description: string; required?: boolean }>;
    requiresApproval?: boolean;
  }>;
  lastSyncedAt: string | null;
  createdAt: string;
};

export type WorkspaceSettings = {
  workspaceId: string;
  name: string;
  defaultLocale: string;
  maxBudgetUsd: number;
  watchdogMode: string;
};

export type ScheduleItem = {
  id: string;
  name: string;
  goal: string;
  role: string;
  multiagent: boolean;
  interval: "hourly" | "daily" | "weekly" | "custom";
  cronExpr?: string;
  enabled: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
};

type Tab = "roles" | "tools" | "schedules" | "workspace";

const INTERVAL_TRANSLATION_KEYS = {
  hourly: "settingsView.intervalHourly",
  daily: "settingsView.intervalDaily",
  weekly: "settingsView.intervalWeekly",
  custom: "settingsView.intervalCustom",
} as const;

export function SettingsView() {
  const { t } = useTranslation();
  const locale = useLocale();

  const [currentTab, setCurrentTab] = useState<Tab>("roles");
  const [roles, setRoles] = useState<RoleItem[]>([]);
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [_workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | null>(null);

  // Schedules state
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [triggeringScheduleId, setTriggeringScheduleId] = useState<string | null>(null);
  const [isCreatingSchedule, setIsCreatingSchedule] = useState(false);
  const [newSchedName, setNewSchedName] = useState("");
  const [newSchedGoal, setNewSchedGoal] = useState("");
  const [newSchedRole, setNewSchedRole] = useState("supervisor");
  const [newSchedMultiagent, setNewSchedMultiagent] = useState(false);
  const [newSchedInterval, setNewSchedInterval] = useState<"hourly" | "daily" | "weekly" | "custom">("daily");

  const [selectedRoleId, setSelectedRoleId] = useState<string>(() => {
    try {
      const stored = sessionStorage.getItem("settings_selected_role");
      if (stored) {
        sessionStorage.removeItem("settings_selected_role");
        return stored;
      }
    } catch {
      // Ignore storage errors
    }
    return "supervisor";
  });
  const [promptLocale, setPromptLocale] = useState<"en" | "es">(locale === "es" ? "es" : "en");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Form edit states for selected role
  const [editNameEn, setEditNameEn] = useState("");
  const [editNameEs, setEditNameEs] = useState("");
  const [editDescEn, setEditDescEn] = useState("");
  const [editDescEs, setEditDescEs] = useState("");
  const [editPromptEn, setEditPromptEn] = useState("");
  const [editPromptEs, setEditPromptEs] = useState("");
  const [editTools, setEditTools] = useState<string[]>([]);
  const [editPinnedModel, setEditPinnedModel] = useState<string>("");
  const [editMaxTokens, setEditMaxTokens] = useState<number>(4000);
  const [editMaxCost, setEditMaxCost] = useState<number>(0.5);
  const [editMaxIterations, setEditMaxIterations] = useState<number>(10);
  const [editColor, setEditColor] = useState<string>("#6366f1");

  // Create role modal state
  const [isCreatingRole, setIsCreatingRole] = useState(false);
  const [newRoleId, setNewRoleId] = useState("");
  const [newNameEn, setNewNameEn] = useState("");
  const [newNameEs, setNewNameEs] = useState("");
  const [newDescEn, setNewDescEn] = useState("");
  const [newDescEs, setNewDescEs] = useState("");
  const [newPromptEn, setNewPromptEn] = useState("");
  const [newPromptEs, setNewPromptEs] = useState("");
  const [newTools, setNewTools] = useState<string[]>(["calc"]);
  const [newColor, setNewColor] = useState("#a855f7");

  // Workspace settings form
  const [wsName, setWsName] = useState("");
  const [wsLocale, setWsLocale] = useState("en");
  const [wsMaxBudget, setWsMaxBudget] = useState(10);
  const [wsWatchdogMode, setWsWatchdogMode] = useState("strict");

  // MCP, Custom Tools & Sandbox Testbed state
  const [mcpServers, setMcpServers] = useState<McpServerItem[]>([]);
  const [syncingServerId, setSyncingServerId] = useState<string | null>(null);
  const [isConnectingMcp, setIsConnectingMcp] = useState(false);
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpTransport, setNewMcpTransport] = useState<"stdio" | "sse">("stdio");
  const [newMcpCommand, setNewMcpCommand] = useState("npx");
  const [newMcpArgs, setNewMcpArgs] = useState("-y, @modelcontextprotocol/server-sqlite, --db, workspace.db");
  const [newMcpUrl, setNewMcpUrl] = useState("");

  const [isCreatingCustomTool, setIsCreatingCustomTool] = useState(false);
  const [newToolName, setNewToolName] = useState("");
  const [newToolDesc, setNewToolDesc] = useState("");
  const [newToolCode, setNewToolCode] = useState(
    "const f = (Number(args.celsius) * 9) / 5 + 32;\nreturn { fahrenheit: f };",
  );
  const [newToolParamsJson, setNewToolParamsJson] = useState(
    '{\n  "celsius": { "type": "number", "description": "Temperature in Celsius", "required": true }\n}',
  );
  const [newToolApproval, setNewToolApproval] = useState(false);

  const [selectedTestTool, setSelectedTestTool] = useState("calc");
  const [testArgsJson, setTestArgsJson] = useState('{\n  "expression": "24 * 7"\n}');
  const [testingTool, setTestingTool] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    summary: string;
    data?: unknown;
    durationMs?: number;
    error?: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const headers = { "X-Infuture-Locale": locale };
      const [rolesRes, toolsRes, connRes, setRes, schedRes, mcpRes] = await Promise.all([
        fetch("/api/v1/roles", { headers }),
        fetch("/api/v1/tools", { headers }),
        fetch("/api/v1/connections", { headers }),
        fetch("/api/v1/settings", { headers }),
        fetch("/api/v1/schedules", { headers }),
        fetch("/api/v1/mcp/servers", { headers }),
      ]);

      if (schedRes.ok) {
        const schedData = (await schedRes.json()) as ScheduleItem[];
        setSchedules(schedData);
      }

      if (mcpRes.ok) {
        const mcpData = (await mcpRes.json()) as McpServerItem[];
        setMcpServers(mcpData);
      }

      if (rolesRes.ok) {
        const rolesData = (await rolesRes.json()) as RoleItem[];
        setRoles(rolesData);
        if (rolesData.length > 0 && !rolesData.some((r) => r.id === selectedRoleId)) {
          setSelectedRoleId(rolesData[0]?.id ?? "supervisor");
        }
      }

      if (toolsRes.ok) {
        const toolsData = (await toolsRes.json()) as ToolItem[];
        setTools(toolsData);
      }

      if (connRes.ok) {
        const connData = (await connRes.json()) as Connection[];
        setConnections(connData);
      }

      if (setRes.ok) {
        const wsData = (await setRes.json()) as WorkspaceSettings;
        setWorkspaceSettings(wsData);
        setWsName(wsData.name);
        setWsLocale(wsData.defaultLocale);
        setWsMaxBudget(wsData.maxBudgetUsd);
        setWsWatchdogMode(wsData.watchdogMode);
      }
    } catch (err) {
      setErrorMessage(String(err));
    } finally {
      setLoading(false);
    }
  }, [locale, selectedRoleId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const activeRole = roles.find((r) => r.id === selectedRoleId);

  useEffect(() => {
    if (activeRole) {
      setEditNameEn(activeRole.names?.en ?? activeRole.name ?? "");
      setEditNameEs(activeRole.names?.es ?? activeRole.name ?? "");
      setEditDescEn(activeRole.descriptions?.en ?? activeRole.description ?? "");
      setEditDescEs(activeRole.descriptions?.es ?? activeRole.description ?? "");
      setEditPromptEn(activeRole.systemPrompt?.en ?? "");
      setEditPromptEs(activeRole.systemPrompt?.es ?? "");
      setEditTools([...(activeRole.tools ?? [])]);
      setEditPinnedModel(activeRole.worker?.modelKey ?? "");
      setEditMaxTokens(activeRole.limits?.maxTokens ?? 4000);
      setEditMaxCost(activeRole.limits?.maxCostUsd ?? 0.5);
      setEditMaxIterations(activeRole.limits?.maxIterations ?? 10);
      setEditColor(activeRole.prefers?.color ?? "#6366f1");
    }
  }, [activeRole]);

  const handleSaveRole = async () => {
    if (!activeRole) return;
    try {
      setSaving(true);
      setStatusMessage(null);
      setErrorMessage(null);

      const headers = {
        "Content-Type": "application/json",
        "X-Infuture-Locale": locale,
      };

      const payload = {
        name: { en: editNameEn, es: editNameEs },
        description: { en: editDescEn, es: editDescEs },
        systemPrompt: { en: editPromptEn, es: editPromptEs },
        tools: editTools,
        limits: {
          maxTokens: editMaxTokens,
          maxCostUsd: editMaxCost,
          maxIterations: editMaxIterations,
        },
        color: editColor,
      };

      const res = await fetch(`/api/v1/roles/${activeRole.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message ?? "Failed to save role");
      }

      // If a model is chosen, also update worker binding
      if (editPinnedModel) {
        await fetch("/api/v1/workers", {
          method: "POST",
          headers,
          body: JSON.stringify({
            roleId: activeRole.id,
            name: `${editNameEn} Worker`,
            modelKey: editPinnedModel,
            pinned: true,
          }),
        });
      }

      setStatusMessage(t("settingsView.savedSuccess"));
      setTimeout(() => setStatusMessage(null), 3500);
      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleResetRole = async () => {
    if (!activeRole) return;
    if (!window.confirm(t("settingsView.confirmReset", { role: activeRole.name }))) {
      return;
    }
    try {
      setSaving(true);
      setStatusMessage(null);
      setErrorMessage(null);

      const res = await fetch(`/api/v1/roles/${activeRole.id}/reset`, {
        method: "POST",
        headers: { "X-Infuture-Locale": locale },
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message ?? "Failed to reset role");
      }

      setStatusMessage(t("settingsView.savedSuccess"));
      setTimeout(() => setStatusMessage(null), 3500);
      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRole = async () => {
    if (!activeRole) return;
    if (!window.confirm(t("settingsView.confirmDelete", { role: activeRole.name }))) {
      return;
    }
    try {
      setSaving(true);
      setStatusMessage(null);
      setErrorMessage(null);

      const res = await fetch(`/api/v1/roles/${activeRole.id}`, {
        method: "DELETE",
        headers: { "X-Infuture-Locale": locale },
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message ?? "Failed to delete role");
      }

      setStatusMessage(t("settingsView.deletedSuccess"));
      setTimeout(() => setStatusMessage(null), 3500);
      setSelectedRoleId("supervisor");
      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRoleId.trim() || !newNameEn.trim()) return;

    try {
      setSaving(true);
      setStatusMessage(null);
      setErrorMessage(null);

      const headers = {
        "Content-Type": "application/json",
        "X-Infuture-Locale": locale,
      };

      const payload = {
        id: newRoleId.trim().toLowerCase(),
        name: { en: newNameEn, es: newNameEs || newNameEn },
        description: { en: newDescEn, es: newDescEs || newDescEn },
        systemPrompt: {
          en: newPromptEn || `You are the ${newNameEn} AI agent in the infuture IA command center.`,
          es:
            newPromptEs ||
            `Eres el agente de IA ${newNameEs || newNameEn} en el centro de mando de infuture IA.`,
        },
        tools: newTools,
        color: newColor,
      };

      const res = await fetch("/api/v1/roles", {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message ?? "Failed to create role");
      }

      setIsCreatingRole(false);
      setSelectedRoleId(newRoleId.trim().toLowerCase());
      setStatusMessage(t("settingsView.createdSuccess"));
      setTimeout(() => setStatusMessage(null), 3500);

      // Reset modal fields
      setNewRoleId("");
      setNewNameEn("");
      setNewNameEs("");
      setNewDescEn("");
      setNewDescEs("");
      setNewPromptEn("");
      setNewPromptEs("");
      setNewTools(["calc"]);

      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWorkspace = async () => {
    try {
      setSaving(true);
      setStatusMessage(null);
      setErrorMessage(null);

      const headers = {
        "Content-Type": "application/json",
        "X-Infuture-Locale": locale,
      };

      const res = await fetch("/api/v1/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          name: wsName,
          defaultLocale: wsLocale,
          maxBudgetUsd: Number(wsMaxBudget),
          watchdogMode: wsWatchdogMode,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message ?? "Failed to save workspace settings");
      }

      setStatusMessage(t("settingsView.workspaceSaved"));
      setTimeout(() => setStatusMessage(null), 3500);
      await loadData();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleTool = (toolName: string) => {
    setEditTools((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
  };

  const toggleNewTool = (toolName: string) => {
    setNewTools((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
  };

  const handleToggleSchedule = async (s: ScheduleItem) => {
    try {
      const res = await fetch(`/api/v1/schedules/${s.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (res.ok) {
        setSchedules((prev) =>
          prev.map((item) => (item.id === s.id ? { ...item, enabled: !item.enabled } : item)),
        );
      }
    } catch {
      // ignore
    }
  };

  const handleTriggerSchedule = async (s: ScheduleItem) => {
    setTriggeringScheduleId(s.id);
    try {
      const res = await fetch(`/api/v1/schedules/${s.id}/trigger`, {
        method: "POST",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        setStatusMessage(t("settingsView.triggeredSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch {
      // ignore
    } finally {
      setTriggeringScheduleId(null);
    }
  };

  const handleDeleteSchedule = async (s: ScheduleItem) => {
    if (!confirm(`Delete schedule "${s.name}"?`)) return;
    try {
      const res = await fetch(`/api/v1/schedules/${s.id}`, {
        method: "DELETE",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        setSchedules((prev) => prev.filter((item) => item.id !== s.id));
      }
    } catch {
      // ignore
    }
  };

  const handleCreateSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSchedName.trim() || !newSchedGoal.trim()) return;

    try {
      const res = await fetch("/api/v1/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Infuture-Locale": locale },
        body: JSON.stringify({
          name: newSchedName.trim(),
          goal: newSchedGoal.trim(),
          role: newSchedRole,
          multiagent: newSchedMultiagent,
          interval: newSchedInterval,
          enabled: true,
        }),
      });
      if (res.ok) {
        const created = (await res.json()) as ScheduleItem;
        setSchedules((prev) => [...prev, created]);
        setIsCreatingSchedule(false);
        setNewSchedName("");
        setNewSchedGoal("");
        setStatusMessage(t("settingsView.triggeredSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch {
      // ignore
    }
  };

  const handleSelectToolForTest = (name: string) => {
    setSelectedTestTool(name);
    const targetTool = tools.find((t) => t.name === name);
    if (targetTool) {
      const initialArgs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(targetTool.parameters)) {
        if (v.type === "number") initialArgs[k] = 10;
        else if (v.type === "boolean") initialArgs[k] = true;
        else if (v.type === "object") initialArgs[k] = {};
        else if (v.type === "array") initialArgs[k] = [];
        else if (k === "expression") initialArgs[k] = "24 * 7";
        else if (k === "sql") initialArgs[k] = "SELECT 1";
        else if (k === "query") initialArgs[k] = "Zero trust";
        else if (k === "code") initialArgs[k] = "Math.sqrt(144)";
        else initialArgs[k] = `sample_${k}`;
      }
      setTestArgsJson(JSON.stringify(initialArgs, null, 2));
    }
  };

  const handleExecuteTestTool = async () => {
    if (!selectedTestTool) return;
    setTestingTool(true);
    setTestResult(null);
    try {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(testArgsJson);
      } catch (parseErr) {
        setTestResult({
          ok: false,
          summary: `Invalid JSON in test arguments: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          durationMs: 0,
        });
        setTestingTool(false);
        return;
      }

      const res = await fetch(`/api/v1/tools/${selectedTestTool}/test`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify({ args: parsedArgs }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({
        ok: false,
        summary: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: 0,
      });
    } finally {
      setTestingTool(false);
    }
  };

  const handleSyncMcpServer = async (id: string) => {
    setSyncingServerId(id);
    try {
      const res = await fetch(`/api/v1/mcp/servers/${id}/sync`, {
        method: "POST",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        setStatusMessage(t("settingsView.syncedSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadData();
      }
    } catch {
      // ignore
    } finally {
      setSyncingServerId(null);
    }
  };

  const handleDeleteMcpServer = async (id: string, name: string) => {
    if (!window.confirm(`Disconnect MCP server "${name}"?`)) return;
    try {
      const res = await fetch(`/api/v1/mcp/servers/${id}`, {
        method: "DELETE",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        await loadData();
      }
    } catch {
      // ignore
    }
  };

  const handleConnectMcpServer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMcpName.trim()) return;
    try {
      setSaving(true);
      const body: Record<string, unknown> = {
        name: newMcpName.trim(),
        transport: newMcpTransport,
      };
      if (newMcpTransport === "stdio") {
        body.command = newMcpCommand.trim();
        body.args = newMcpArgs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        body.url = newMcpUrl.trim();
      }

      const res = await fetch("/api/v1/mcp/servers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const server = await res.json();
        await fetch(`/api/v1/mcp/servers/${server.id}/sync`, {
          method: "POST",
          headers: { "X-Infuture-Locale": locale },
        });
        setIsConnectingMcp(false);
        setNewMcpName("");
        setNewMcpCommand("");
        setNewMcpArgs("");
        setNewMcpUrl("");
        setStatusMessage(t("settingsView.syncedSuccess"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadData();
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const handleCreateCustomTool = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newToolName.trim() || !newToolCode.trim()) return;
    try {
      setSaving(true);
      let parsedParams = {};
      if (newToolParamsJson.trim()) {
        try {
          parsedParams = JSON.parse(newToolParamsJson);
        } catch {
          alert(t("settingsView.invalidParamsJson"));
          setSaving(false);
          return;
        }
      }

      const res = await fetch("/api/v1/tools/custom", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Infuture-Locale": locale,
        },
        body: JSON.stringify({
          name: newToolName.trim(),
          description: newToolDesc.trim() || `Custom sandbox tool ${newToolName.trim()}`,
          parameters: parsedParams,
          code: newToolCode.trim(),
          requiresApproval: newToolApproval,
        }),
      });

      if (res.ok) {
        setIsCreatingCustomTool(false);
        setNewToolName("");
        setNewToolDesc("");
        setNewToolCode("");
        setNewToolParamsJson("{}");
        setNewToolApproval(false);
        setStatusMessage(t("settingsView.customToolCreated"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadData();
      } else {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setStatusMessage(body?.error?.message ?? t("settingsView.customToolFailed"));
        setTimeout(() => setStatusMessage(null), 5000);
      }
    } catch {
      setStatusMessage(t("settingsView.customToolFailed"));
      setTimeout(() => setStatusMessage(null), 5000);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteCustomTool = async (toolName: string) => {
    if (!window.confirm(t("settingsView.confirmDeleteCustomTool", { tool: toolName }))) return;
    try {
      const res = await fetch(`/api/v1/tools/custom/${toolName}`, {
        method: "DELETE",
        headers: { "X-Infuture-Locale": locale },
      });
      if (res.ok) {
        setStatusMessage(t("settingsView.customToolDeleted"));
        setTimeout(() => setStatusMessage(null), 3000);
        await loadData();
      }
    } catch {
      // ignore
    }
  };

  // Collect available models from all active connections
  const availableModels: Array<{ connectionAlias: string; model: string }> = [];
  for (const conn of connections) {
    for (const m of conn.models) {
      availableModels.push({ connectionAlias: conn.alias, model: m });
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-header">
        <div className="settings-title-group">
          <h2>{t("settingsView.title")}</h2>
          <p className="settings-subtitle">{t("settingsView.subtitle")}</p>
        </div>

        <div className="settings-tab-nav" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={currentTab === "roles"}
            className={`settings-tab-btn ${currentTab === "roles" ? "active" : ""}`}
            onClick={() => setCurrentTab("roles")}
          >
            {t("settingsView.tabRoles")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={currentTab === "tools"}
            className={`settings-tab-btn ${currentTab === "tools" ? "active" : ""}`}
            onClick={() => setCurrentTab("tools")}
          >
            {t("settingsView.tabToolsMcp")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={currentTab === "schedules"}
            className={`settings-tab-btn ${currentTab === "schedules" ? "active" : ""}`}
            onClick={() => setCurrentTab("schedules")}
          >
            {t("settingsView.tabSchedules")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={currentTab === "workspace"}
            className={`settings-tab-btn ${currentTab === "workspace" ? "active" : ""}`}
            onClick={() => setCurrentTab("workspace")}
          >
            {t("settingsView.tabWorkspace")}
          </button>
        </div>
      </div>

      {statusMessage && <div className="notice-banner success">{statusMessage}</div>}
      {errorMessage && <div className="notice-banner error">{errorMessage}</div>}

      {loading ? (
        <div className="settings-loading">{t("common.loading")}</div>
      ) : (
        <>
          {/* TAB 1: AGENT ROLES & PERSONAS */}
          {currentTab === "roles" && (
            <div className="roles-editor-layout">
              {/* Left Column: Roles List */}
              <div className="roles-sidebar">
                <div className="roles-sidebar-header">
                  <span className="roles-count-label">
                    {roles.length} {t("settingsView.tabRoles")}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => setIsCreatingRole(true)}
                  >
                    + {t("settingsView.newRole")}
                  </button>
                </div>

                <div className="roles-list-scroll">
                  {roles.map((role) => {
                    const isSelected = role.id === selectedRoleId;
                    const roleColor = role.prefers?.color ?? "#6366f1";
                    return (
                      <button
                        type="button"
                        key={role.id}
                        className={`role-item-card ${isSelected ? "selected" : ""}`}
                        onClick={() => setSelectedRoleId(role.id)}
                      >
                        <div className="role-item-dot" style={{ backgroundColor: roleColor }} />
                        <div className="role-item-info">
                          <div className="role-item-header">
                            <span className="role-item-name">{role.name}</span>
                            <span className={`role-badge ${role.isCustom ? "custom" : "builtin"}`}>
                              {role.isCustom ? t("settingsView.custom") : t("settingsView.builtIn")}
                            </span>
                          </div>
                          <span className="role-item-slug">@{role.id}</span>
                          <p className="role-item-desc">{role.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Right Column: Active Role Editor */}
              {activeRole ? (
                <div className="role-editor-main">
                  <div className="role-editor-header">
                    <div className="role-editor-title-row">
                      <div className="role-editor-avatar" style={{ backgroundColor: editColor }} />
                      <div>
                        <h3 className="role-editor-title">{activeRole.name}</h3>
                        <span className="role-editor-id">@{activeRole.id}</span>
                      </div>
                      <span className={`role-badge ${activeRole.isCustom ? "custom" : "builtin"}`}>
                        {activeRole.isCustom ? t("settingsView.custom") : t("settingsView.builtIn")}
                      </span>
                    </div>

                    <div className="role-editor-actions-top">
                      {!activeRole.isCustom && (
                        <button
                          type="button"
                          className="btn btn-sm btn-secondary"
                          onClick={handleResetRole}
                          disabled={saving}
                        >
                          {t("settingsView.resetDefault")}
                        </button>
                      )}
                      {activeRole.isCustom && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={handleDeleteRole}
                          disabled={saving}
                        >
                          {t("settingsView.deleteRole")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Metadata fields */}
                  <div className="role-fields-grid">
                    <div className="field-group">
                      <label htmlFor="role-name-en">{t("settingsView.roleName")} (EN)</label>
                      <input
                        id="role-name-en"
                        type="text"
                        className="input"
                        value={editNameEn}
                        onChange={(e) => setEditNameEn(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label htmlFor="role-name-es">{t("settingsView.roleName")} (ES)</label>
                      <input
                        id="role-name-es"
                        type="text"
                        className="input"
                        value={editNameEs}
                        onChange={(e) => setEditNameEs(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="role-fields-grid">
                    <div className="field-group">
                      <label htmlFor="role-desc-en">{t("settingsView.roleDescription")} (EN)</label>
                      <input
                        id="role-desc-en"
                        type="text"
                        className="input"
                        value={editDescEn}
                        onChange={(e) => setEditDescEn(e.target.value)}
                      />
                    </div>
                    <div className="field-group">
                      <label htmlFor="role-desc-es">{t("settingsView.roleDescription")} (ES)</label>
                      <input
                        id="role-desc-es"
                        type="text"
                        className="input"
                        value={editDescEs}
                        onChange={(e) => setEditDescEs(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Bilingual System Prompt Editor */}
                  <div className="role-prompt-section">
                    <div className="prompt-header-row">
                      <label className="section-label">
                        {promptLocale === "en"
                          ? t("settingsView.systemPromptEn")
                          : t("settingsView.systemPromptEs")}
                      </label>
                      <div className="prompt-lang-toggle">
                        <button
                          type="button"
                          className={`btn-tag ${promptLocale === "en" ? "active" : ""}`}
                          onClick={() => setPromptLocale("en")}
                        >
                          English (EN)
                        </button>
                        <button
                          type="button"
                          className={`btn-tag ${promptLocale === "es" ? "active" : ""}`}
                          onClick={() => setPromptLocale("es")}
                        >
                          Español (ES)
                        </button>
                        <span className="char-badge">
                          {t("settingsView.charCount", {
                            chars: (promptLocale === "en" ? editPromptEn : editPromptEs).length,
                          })}
                        </span>
                      </div>
                    </div>

                    {promptLocale === "en" ? (
                      <textarea
                        className="prompt-textarea mono"
                        rows={7}
                        value={editPromptEn}
                        onChange={(e) => setEditPromptEn(e.target.value)}
                        placeholder={t("settingsView.promptEnPlaceholder")}
                      />
                    ) : (
                      <textarea
                        className="prompt-textarea mono"
                        rows={7}
                        value={editPromptEs}
                        onChange={(e) => setEditPromptEs(e.target.value)}
                        placeholder={t("settingsView.promptEsPlaceholder")}
                      />
                    )}
                  </div>

                  {/* Allowed Tools */}
                  <div className="role-tools-section">
                    <label className="section-label">{t("settingsView.allowedTools")}</label>
                    <div className="tools-selection-grid">
                      {tools.map((tool) => {
                        const isChecked = editTools.includes(tool.name);
                        return (
                          <label
                            key={tool.name}
                            className={`tool-checkbox-card ${isChecked ? "active" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleTool(tool.name)}
                            />
                            <div className="tool-checkbox-content">
                              <div className="tool-checkbox-top">
                                <span className="tool-name-code">{tool.name}</span>
                                {tool.requiresApproval && (
                                  <span className="approval-pill">{t("settingsView.requiresApproval")}</span>
                                )}
                              </div>
                              <p className="tool-card-desc">{tool.description}</p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {/* Model Binding & Execution Limits */}
                  <div className="role-limits-section">
                    <label className="section-label">{t("settingsView.executionLimits")}</label>
                    <div className="limits-inputs-grid">
                      <div className="field-group">
                        <label htmlFor="role-model-pin">{t("settingsView.pinnedModel")}</label>
                        <select
                          id="role-model-pin"
                          className="input"
                          value={editPinnedModel}
                          onChange={(e) => setEditPinnedModel(e.target.value)}
                        >
                          <option value="">{t("settingsView.autoModel")}</option>
                          {availableModels.map((m, idx) => (
                            <option key={`${m.connectionAlias}-${m.model}-${idx}`} value={m.model}>
                              {m.connectionAlias}: {m.model}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="field-group">
                        <label htmlFor="role-max-tokens">{t("settingsView.maxTokens")}</label>
                        <input
                          id="role-max-tokens"
                          type="number"
                          className="input"
                          value={editMaxTokens}
                          onChange={(e) => setEditMaxTokens(Number(e.target.value))}
                        />
                      </div>

                      <div className="field-group">
                        <label htmlFor="role-max-cost">{t("settingsView.maxCost")}</label>
                        <input
                          id="role-max-cost"
                          type="number"
                          step="0.05"
                          className="input"
                          value={editMaxCost}
                          onChange={(e) => setEditMaxCost(Number(e.target.value))}
                        />
                      </div>

                      <div className="field-group">
                        <label htmlFor="role-max-iter">{t("settingsView.maxIterations")}</label>
                        <input
                          id="role-max-iter"
                          type="number"
                          className="input"
                          value={editMaxIterations}
                          onChange={(e) => setEditMaxIterations(Number(e.target.value))}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Footer Action */}
                  <div className="role-editor-footer">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleSaveRole}
                      disabled={saving}
                    >
                      {saving ? t("settingsView.saving") : t("settingsView.saveChanges")}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="role-editor-empty">{t("common.loading")}</div>
              )}
            </div>
          )}

          {/* TAB 2: TOOLS & CAPABILITIES & MCP HUB */}
          {currentTab === "tools" && (
            <div className="tools-catalog-view">
              <div className="catalog-header flex-header">
                <div>
                  <h3>{t("settingsView.toolsTitle")}</h3>
                  <p>{t("settingsView.toolsSubtitle")}</p>
                </div>
                <div className="header-actions-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => setIsConnectingMcp(true)}
                  >
                    + {t("settingsView.connectMcpServer")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setIsCreatingCustomTool(true)}
                  >
                    + {t("settingsView.newCustomTool")}
                  </button>
                </div>
              </div>

              {/* 1. Interactive Tool Sandbox & Testbed */}
              <div className="tool-testbed-card">
                <div className="testbed-header">
                  <div>
                    <h4>{t("settingsView.toolTestbedTitle")}</h4>
                    <p className="testbed-subtitle">{t("settingsView.toolTestbedSubtitle")}</p>
                  </div>
                  <div className="testbed-select-group">
                    <label htmlFor="test-tool-select">{t("settingsView.selectTool")}:</label>
                    <select
                      id="test-tool-select"
                      className="input"
                      value={selectedTestTool}
                      onChange={(e) => handleSelectToolForTest(e.target.value)}
                    >
                      {tools.map((tl) => (
                        <option key={tl.name} value={tl.name}>
                          {tl.name} (
                          {tl.isMcp
                            ? "MCP"
                            : tl.isCustom
                              ? t("settingsView.toolKindCustom")
                              : t("settingsView.toolKindBuiltin")}
                          )
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="testbed-body">
                  <div className="field-group">
                    <label htmlFor="test-args-json">{t("settingsView.testArguments")}</label>
                    <textarea
                      id="test-args-json"
                      className="input font-mono"
                      rows={4}
                      value={testArgsJson}
                      onChange={(e) => setTestArgsJson(e.target.value)}
                    />
                  </div>

                  <div className="testbed-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleExecuteTestTool}
                      disabled={testingTool}
                    >
                      {testingTool ? t("settingsView.executing") : t("settingsView.executeTest")}
                    </button>
                  </div>

                  {testResult && (
                    <div
                      className={`testbed-result-container ${testResult.ok ? "result-success" : "result-failed"}`}
                    >
                      <div className="result-header">
                        <span className={`status-pill ${testResult.ok ? "pill-done" : "pill-failed"}`}>
                          {testResult.ok
                            ? t("settingsView.testSuccess", { duration: testResult.durationMs ?? 0 })
                            : t("settingsView.testFailed", { duration: testResult.durationMs ?? 0 })}
                        </span>
                        <span className="result-summary">{testResult.summary}</span>
                      </div>
                      {testResult.data !== undefined && (
                        <div className="result-data-box">
                          <span className="data-title">{t("settingsView.testOutput")}:</span>
                          <pre className="result-json">{JSON.stringify(testResult.data, null, 2)}</pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 2. Connected MCP Servers Hub */}
              <div className="mcp-servers-section">
                <div className="section-title-group">
                  <h4>{t("settingsView.mcpServersTitle")}</h4>
                  <p className="section-subtitle">{t("settingsView.mcpServersSubtitle")}</p>
                </div>

                {mcpServers.length === 0 ? (
                  <div className="empty-mcp-box">
                    <p>No MCP servers connected. Connect SQLite, PostgreSQL, or web scraper servers above.</p>
                  </div>
                ) : (
                  <div className="mcp-servers-grid">
                    {mcpServers.map((s) => (
                      <div key={s.id} className="mcp-server-card">
                        <div className="server-header">
                          <div className="server-name-group">
                            <span className="server-name">{s.name}</span>
                            <span className="server-transport-pill">[{s.transport.toUpperCase()}]</span>
                          </div>
                          <div className="server-tools-count">
                            {t("settingsView.connectedToolsCount", {
                              count: s.discoveredTools?.length ?? 0,
                            })}
                          </div>
                        </div>

                        <div className="server-details">
                          {s.command && (
                            <div className="detail-line">
                              <span className="detail-label">Command:</span>
                              <code>
                                {s.command} {(s.args || []).join(" ")}
                              </code>
                            </div>
                          )}
                          {s.url && (
                            <div className="detail-line">
                              <span className="detail-label">URL:</span>
                              <code>{s.url}</code>
                            </div>
                          )}
                        </div>

                        {s.discoveredTools && s.discoveredTools.length > 0 && (
                          <div className="server-tools-chips">
                            {s.discoveredTools.map((dt) => (
                              <span key={dt.name} className="server-tool-chip">
                                ⚡ {dt.name}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="server-card-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleSyncMcpServer(s.id)}
                            disabled={syncingServerId === s.id}
                          >
                            {syncingServerId === s.id
                              ? t("settingsView.syncing")
                              : t("settingsView.syncTools")}
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => handleDeleteMcpServer(s.id, s.name)}
                          >
                            {t("settingsView.disconnectServer")}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 3. Catalog of All Available Tools */}
              <div className="tools-catalog-list-section">
                <div className="section-title-group">
                  <h4>{t("settingsView.toolsTitle")}</h4>
                  <p className="section-subtitle">{t("settingsView.toolsSubtitle")}</p>
                </div>

                <div className="tools-grid-cards">
                  {tools.map((tool) => (
                    <div key={tool.name} className="tool-detail-card">
                      <div className="tool-card-header">
                        <span className="tool-code-badge">{tool.name}</span>
                        <div className="tool-badges-row">
                          {tool.isMcp && <span className="mcp-badge">MCP</span>}
                          {tool.isCustom && <span className="custom-tool-badge">CUSTOM</span>}
                          {tool.requiresApproval ? (
                            <span className="approval-badge">{t("settingsView.requiresApproval")}</span>
                          ) : (
                            <span className="sandbox-badge">{t("settingsView.safeExecution")}</span>
                          )}
                          <span className="params-badge">
                            {t("settingsView.parameterCount", {
                              params: Object.keys(tool.parameters).length,
                            })}
                          </span>
                          {tool.isCustom && (
                            <button
                              type="button"
                              className="btn-delete-chip"
                              title="Delete custom tool"
                              onClick={() => handleDeleteCustomTool(tool.name)}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>

                      <p className="tool-detail-desc">{tool.description}</p>

                      <div className="tool-parameters-list">
                        <span className="params-header">Parameters:</span>
                        {Object.entries(tool.parameters).map(([paramName, param]) => (
                          <div key={paramName} className="param-row">
                            <code className="param-name">{paramName}</code>
                            <span className="param-type">({param.type})</span>
                            {param.required && <span className="param-req">required</span>}
                            <span className="param-desc">{param.description}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: WORKSPACE SETTINGS */}
          {currentTab === "workspace" && (
            <div className="workspace-settings-view">
              <div className="workspace-card">
                <h3>{t("settingsView.workspaceTitle")}</h3>
                <p className="workspace-card-subtitle">{t("settingsView.workspaceSubtitle")}</p>

                <div className="workspace-fields-form">
                  <div className="field-group">
                    <label htmlFor="ws-name">{t("settingsView.workspaceName")}</label>
                    <input
                      id="ws-name"
                      type="text"
                      className="input"
                      value={wsName}
                      onChange={(e) => setWsName(e.target.value)}
                    />
                  </div>

                  <div className="field-group">
                    <label htmlFor="ws-locale">{t("settingsView.defaultLocale")}</label>
                    <select
                      id="ws-locale"
                      className="input"
                      value={wsLocale}
                      onChange={(e) => setWsLocale(e.target.value)}
                    >
                      <option value="en">English (en)</option>
                      <option value="es">Español (es)</option>
                    </select>
                  </div>

                  <div className="field-group">
                    <label htmlFor="ws-budget">{t("settingsView.maxBudget")}</label>
                    <input
                      id="ws-budget"
                      type="number"
                      step="1"
                      className="input"
                      value={wsMaxBudget}
                      onChange={(e) => setWsMaxBudget(Number(e.target.value))}
                    />
                  </div>

                  <div className="field-group">
                    <label htmlFor="ws-watchdog">{t("settingsView.watchdogMode")}</label>
                    <select
                      id="ws-watchdog"
                      className="input"
                      value={wsWatchdogMode}
                      onChange={(e) => setWsWatchdogMode(e.target.value)}
                    >
                      <option value="strict">{t("settingsView.watchdogStrict")}</option>
                      <option value="permissive">{t("settingsView.watchdogPermissive")}</option>
                    </select>
                  </div>

                  <div className="workspace-btn-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleSaveWorkspace}
                      disabled={saving}
                    >
                      {saving ? t("settingsView.saving") : t("settingsView.saveWorkspace")}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: SCHEDULED AUTOMATIONS */}
          {currentTab === "schedules" && (
            <div className="schedules-view card card-wide">
              <div
                className="settings-section-head"
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
              >
                <div>
                  <h3>{t("settingsView.schedulesTitle")}</h3>
                  <p className="small muted">{t("settingsView.schedulesSubtitle")}</p>
                </div>
                <button
                  type="button"
                  className="btn-tiny btn-primary"
                  onClick={() => setIsCreatingSchedule(true)}
                >
                  + {t("settingsView.newSchedule")}
                </button>
              </div>

              <div
                className="schedules-list"
                style={{ marginTop: "16px", display: "flex", flexDirection: "column", gap: "12px" }}
              >
                {schedules.map((s) => (
                  <div
                    key={s.id}
                    className="schedule-card"
                    style={{
                      padding: "14px 16px",
                      background: "var(--surface)",
                      border: "1px solid var(--line)",
                      borderRadius: "8px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "16px",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          marginBottom: "4px",
                        }}
                      >
                        <span className={`pill small mono ${s.enabled ? "pill-ok" : "pill-warn"}`}>
                          {s.enabled ? t("settingsView.statusActive") : t("settingsView.statusDisabled")}
                        </span>
                        <span className="pill small pill-sky mono">
                          {t(INTERVAL_TRANSLATION_KEYS[s.interval] ?? "settingsView.intervalDaily")}
                        </span>
                        <span className="pill small mono pill-accent">{s.role}</span>
                        {s.multiagent && <span className="pill small mono">MULTI-AGENT</span>}
                      </div>
                      <strong style={{ fontSize: "14px", color: "var(--fg)" }}>{s.name}</strong>
                      <p className="small muted" style={{ margin: "4px 0 6px" }}>
                        {s.goal}
                      </p>
                      <span className="small muted mono">
                        {s.nextRunAt
                          ? t("settingsView.nextRun", {
                              time: new Date(s.nextRunAt).toLocaleString(),
                            })
                          : t("settingsView.neverRun")}
                      </span>
                    </div>

                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <button
                        type="button"
                        className="btn-tiny"
                        onClick={() => void handleTriggerSchedule(s)}
                        disabled={triggeringScheduleId === s.id}
                      >
                        {triggeringScheduleId === s.id ? "…" : `⚡ ${t("settingsView.triggerNow")}`}
                      </button>
                      <button type="button" className="btn-tiny" onClick={() => void handleToggleSchedule(s)}>
                        {s.enabled ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        className="btn-tiny"
                        style={{ color: "var(--coral)" }}
                        onClick={() => void handleDeleteSchedule(s)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* CREATE SCHEDULE MODAL */}
      {isCreatingSchedule && (
        <div className="modal-backdrop" onClick={() => setIsCreatingSchedule(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settingsView.createScheduleTitle")}</h3>
              <button type="button" className="btn-icon" onClick={() => setIsCreatingSchedule(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateSchedule} className="modal-form">
              <div className="field-group">
                <label htmlFor="new-sched-name">{t("settingsView.scheduleName")}</label>
                <input
                  id="new-sched-name"
                  type="text"
                  required
                  className="input"
                  value={newSchedName}
                  onChange={(e) => setNewSchedName(e.target.value)}
                  placeholder={t("settingsView.scheduleNamePlaceholder")}
                />
              </div>

              <div className="field-group">
                <label htmlFor="new-sched-goal">{t("settingsView.scheduleGoal")}</label>
                <textarea
                  id="new-sched-goal"
                  rows={3}
                  required
                  className="input textarea"
                  value={newSchedGoal}
                  onChange={(e) => setNewSchedGoal(e.target.value)}
                  placeholder={t("settingsView.scheduleGoalPlaceholder")}
                />
              </div>

              <div className="modal-fields-grid">
                <div className="field-group">
                  <label htmlFor="new-sched-interval">{t("settingsView.scheduleInterval")}</label>
                  <select
                    id="new-sched-interval"
                    className="input"
                    value={newSchedInterval}
                    onChange={(e) =>
                      setNewSchedInterval(e.target.value as "hourly" | "daily" | "weekly" | "custom")
                    }
                  >
                    <option value="hourly">{t("settingsView.intervalHourly")}</option>
                    <option value="daily">{t("settingsView.intervalDaily")}</option>
                    <option value="weekly">{t("settingsView.intervalWeekly")}</option>
                  </select>
                </div>

                <div className="field-group">
                  <label htmlFor="new-sched-role">{t("dashboard.role")}</label>
                  <select
                    id="new-sched-role"
                    className="input"
                    value={newSchedRole}
                    onChange={(e) => setNewSchedRole(e.target.value)}
                  >
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="form-checkbox-group" style={{ margin: "6px 0 16px" }}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={newSchedMultiagent}
                    onChange={(e) => setNewSchedMultiagent(e.target.checked)}
                  />
                  <span>
                    <strong>{t("dashboard.multiagent")}</strong>
                  </span>
                </label>
              </div>

              <div className="modal-actions-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreatingSchedule(false)}
                >
                  {t("settingsView.cancel")}
                </button>
                <button type="submit" className="btn btn-primary">
                  {t("settingsView.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE ROLE MODAL */}
      {isCreatingRole && (
        <div className="modal-backdrop" onClick={() => setIsCreatingRole(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settingsView.createRoleTitle")}</h3>
              <button type="button" className="btn-icon" onClick={() => setIsCreatingRole(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateRole} className="modal-form">
              <div className="modal-fields-grid">
                <div className="field-group">
                  <label htmlFor="new-role-id">{t("settingsView.roleId")}</label>
                  <input
                    id="new-role-id"
                    type="text"
                    required
                    className="input"
                    placeholder={t("settingsView.roleIdPlaceholder")}
                    value={newRoleId}
                    onChange={(e) => setNewRoleId(e.target.value)}
                  />
                </div>

                <div className="field-group">
                  <label htmlFor="new-role-color">{t("settingsView.colorLabel")}</label>
                  <input
                    id="new-role-color"
                    type="color"
                    className="color-input"
                    value={newColor}
                    onChange={(e) => setNewColor(e.target.value)}
                  />
                </div>
              </div>

              <div className="modal-fields-grid">
                <div className="field-group">
                  <label htmlFor="new-name-en">{t("settingsView.roleName")} (EN)</label>
                  <input
                    id="new-name-en"
                    type="text"
                    required
                    className="input"
                    value={newNameEn}
                    onChange={(e) => setNewNameEn(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <label htmlFor="new-name-es">{t("settingsView.roleName")} (ES)</label>
                  <input
                    id="new-name-es"
                    type="text"
                    className="input"
                    value={newNameEs}
                    onChange={(e) => setNewNameEs(e.target.value)}
                  />
                </div>
              </div>

              <div className="modal-fields-grid">
                <div className="field-group">
                  <label htmlFor="new-desc-en">{t("settingsView.roleDescription")} (EN)</label>
                  <input
                    id="new-desc-en"
                    type="text"
                    className="input"
                    value={newDescEn}
                    onChange={(e) => setNewDescEn(e.target.value)}
                  />
                </div>
                <div className="field-group">
                  <label htmlFor="new-desc-es">{t("settingsView.roleDescription")} (ES)</label>
                  <input
                    id="new-desc-es"
                    type="text"
                    className="input"
                    value={newDescEs}
                    onChange={(e) => setNewDescEs(e.target.value)}
                  />
                </div>
              </div>

              <div className="field-group">
                <label htmlFor="new-prompt-en">{t("settingsView.systemPromptEn")}</label>
                <textarea
                  id="new-prompt-en"
                  rows={4}
                  className="prompt-textarea mono"
                  value={newPromptEn}
                  onChange={(e) => setNewPromptEn(e.target.value)}
                  placeholder={t("settingsView.schedulePromptEnPlaceholder")}
                />
              </div>

              <div className="field-group">
                <label htmlFor="new-prompt-es">{t("settingsView.systemPromptEs")}</label>
                <textarea
                  id="new-prompt-es"
                  rows={4}
                  className="prompt-textarea mono"
                  value={newPromptEs}
                  onChange={(e) => setNewPromptEs(e.target.value)}
                  placeholder={t("settingsView.schedulePromptEsPlaceholder")}
                />
              </div>

              <div className="field-group">
                <label className="section-label">{t("settingsView.allowedTools")}</label>
                <div className="modal-tools-chips">
                  {tools.map((tool) => (
                    <button
                      type="button"
                      key={tool.name}
                      className={`tool-chip ${newTools.includes(tool.name) ? "active" : ""}`}
                      onClick={() => toggleNewTool(tool.name)}
                    >
                      {tool.name}
                    </button>
                  ))}
                </div>
              </div>

              <div className="modal-actions-row">
                <button type="button" className="btn btn-secondary" onClick={() => setIsCreatingRole(false)}>
                  {t("settingsView.cancel")}
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {t("settingsView.create")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CONNECT MCP SERVER MODAL */}
      {isConnectingMcp && (
        <div className="modal-backdrop" onClick={() => setIsConnectingMcp(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settingsView.connectMcpServer")}</h3>
              <button type="button" className="btn-icon" onClick={() => setIsConnectingMcp(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleConnectMcpServer} className="modal-form">
              <div className="field-group">
                <label htmlFor="mcp-name">{t("settingsView.mcpServerName")}</label>
                <input
                  id="mcp-name"
                  type="text"
                  required
                  className="input"
                  placeholder="e.g. SQLite DB Explorer"
                  value={newMcpName}
                  onChange={(e) => setNewMcpName(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label>{t("settingsView.mcpTransport")}</label>
                <div className="radio-group-row">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="mcpTransport"
                      value="stdio"
                      checked={newMcpTransport === "stdio"}
                      onChange={() => setNewMcpTransport("stdio")}
                    />
                    <span>stdio (Process executable)</span>
                  </label>
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="mcpTransport"
                      value="sse"
                      checked={newMcpTransport === "sse"}
                      onChange={() => setNewMcpTransport("sse")}
                    />
                    <span>sse (HTTP Server-Sent Events)</span>
                  </label>
                </div>
              </div>

              {newMcpTransport === "stdio" ? (
                <>
                  <div className="field-group">
                    <label htmlFor="mcp-cmd">{t("settingsView.mcpCommand")}</label>
                    <input
                      id="mcp-cmd"
                      type="text"
                      required
                      className="input font-mono"
                      placeholder="npx"
                      value={newMcpCommand}
                      onChange={(e) => setNewMcpCommand(e.target.value)}
                    />
                  </div>
                  <div className="field-group">
                    <label htmlFor="mcp-args">{t("settingsView.mcpArgs")}</label>
                    <input
                      id="mcp-args"
                      type="text"
                      className="input font-mono"
                      placeholder="-y, @modelcontextprotocol/server-sqlite, --db, app.db"
                      value={newMcpArgs}
                      onChange={(e) => setNewMcpArgs(e.target.value)}
                    />
                  </div>
                </>
              ) : (
                <div className="field-group">
                  <label htmlFor="mcp-url">{t("settingsView.mcpUrl")}</label>
                  <input
                    id="mcp-url"
                    type="url"
                    required
                    className="input font-mono"
                    placeholder="http://localhost:8080/events"
                    value={newMcpUrl}
                    onChange={(e) => setNewMcpUrl(e.target.value)}
                  />
                </div>
              )}

              <div className="modal-actions-row">
                <button type="button" className="btn btn-secondary" onClick={() => setIsConnectingMcp(false)}>
                  {t("settingsView.cancel")}
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? t("settingsView.saving") : t("settingsView.connectMcpServer")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE CUSTOM TOOL MODAL */}
      {isCreatingCustomTool && (
        <div className="modal-backdrop" onClick={() => setIsCreatingCustomTool(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("settingsView.newCustomTool")}</h3>
              <button type="button" className="btn-icon" onClick={() => setIsCreatingCustomTool(false)}>
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateCustomTool} className="modal-form">
              <div className="field-group">
                <label htmlFor="tool-custom-name">{t("settingsView.toolName")}</label>
                <input
                  id="tool-custom-name"
                  type="text"
                  required
                  className="input font-mono"
                  placeholder="e.g. currency_converter"
                  value={newToolName}
                  onChange={(e) => setNewToolName(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label htmlFor="tool-custom-desc">{t("settingsView.toolDescription")}</label>
                <input
                  id="tool-custom-desc"
                  type="text"
                  required
                  className="input"
                  placeholder="What this tool does and when agents should invoke it"
                  value={newToolDesc}
                  onChange={(e) => setNewToolDesc(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label htmlFor="tool-custom-params">Parameters Definition (JSON)</label>
                <textarea
                  id="tool-custom-params"
                  rows={3}
                  className="input font-mono"
                  value={newToolParamsJson}
                  onChange={(e) => setNewToolParamsJson(e.target.value)}
                />
              </div>

              <div className="field-group">
                <label htmlFor="tool-custom-code">{t("settingsView.toolCode")}</label>
                <textarea
                  id="tool-custom-code"
                  rows={5}
                  required
                  className="prompt-textarea mono"
                  value={newToolCode}
                  onChange={(e) => setNewToolCode(e.target.value)}
                  placeholder="const f = (Number(args.celsius) * 9) / 5 + 32;\nreturn { fahrenheit: f };"
                />
              </div>

              <div className="field-group checkbox-row">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={newToolApproval}
                    onChange={(e) => setNewToolApproval(e.target.checked)}
                  />
                  <span>{t("settingsView.requiresApproval")}</span>
                </label>
              </div>

              <div className="modal-actions-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setIsCreatingCustomTool(false)}
                >
                  {t("settingsView.cancel")}
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? t("settingsView.saving") : t("settingsView.createCustomTool")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
