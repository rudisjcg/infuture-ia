export type WatchdogConfig = {
  maxCostUsd?: number;
  maxTokens?: number;
  maxIterations?: number;
  maxIdenticalActions?: number;
};

export type WatchdogAlert = {
  rule: string;
  severity: "info" | "warning" | "critical";
  message: string;
  evidence?: string[];
};

export type WatchdogIntervention = {
  action: "notice" | "pause" | "reassign";
  reason: string;
};

export class WatchdogSupervisor {
  private config: Required<WatchdogConfig>;
  private totalCost = 0;
  private totalTokens = 0;
  private iterations = 0;
  private recentThoughts: string[] = [];
  private recentToolCalls: string[] = [];

  constructor(config: WatchdogConfig = {}) {
    this.config = {
      maxCostUsd: config.maxCostUsd ?? 0.5,
      maxTokens: config.maxTokens ?? 100_000,
      maxIterations: config.maxIterations ?? 15,
      maxIdenticalActions: config.maxIdenticalActions ?? 3,
    };
  }

  recordIteration(): { alert?: WatchdogAlert; intervention?: WatchdogIntervention } | null {
    this.iterations++;
    if (this.iterations > this.config.maxIterations) {
      return {
        alert: {
          rule: "excessive_iterations",
          severity: "warning",
          message: `Run reached ${this.iterations} iterations (limit: ${this.config.maxIterations}).`,
          evidence: [],
        },
        intervention: {
          action: "notice",
          reason: "Max iteration threshold reached.",
        },
      };
    }
    return null;
  }

  inspectThought(thought: string): { alert?: WatchdogAlert; intervention?: WatchdogIntervention } | null {
    const trimmed = thought.trim();
    this.recentThoughts.push(trimmed);
    if (this.recentThoughts.length > 5) {
      this.recentThoughts.shift();
    }

    const matches = this.recentThoughts.filter((t) => t === trimmed).length;
    if (matches >= this.config.maxIdenticalActions) {
      return {
        alert: {
          rule: "repetition_loop",
          severity: "warning",
          message: `Agent repeated identical thought ${matches} times: "${trimmed.slice(0, 60)}..."`,
          evidence: [],
        },
        intervention: {
          action: "notice",
          reason: "Repetition loop detected in agent thoughts.",
        },
      };
    }
    return null;
  }

  inspectToolCall(
    tool: string,
    args: Record<string, unknown>,
  ): { alert?: WatchdogAlert; intervention?: WatchdogIntervention } | null {
    const key = `${tool}:${JSON.stringify(args)}`;
    this.recentToolCalls.push(key);
    if (this.recentToolCalls.length > 5) {
      this.recentToolCalls.shift();
    }

    const count = this.recentToolCalls.filter((c) => c === key).length;
    if (count >= this.config.maxIdenticalActions) {
      return {
        alert: {
          rule: "tool_loop",
          severity: "warning",
          message: `Tool "${tool}" called with identical parameters ${count} times in succession.`,
          evidence: [],
        },
        intervention: {
          action: "notice",
          reason: "Tool call loop detected.",
        },
      };
    }
    return null;
  }

  inspectUsage(
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
  ): { alert?: WatchdogAlert; intervention?: WatchdogIntervention } | null {
    this.totalTokens = tokensIn + tokensOut;
    this.totalCost = costUsd;

    if (this.totalCost > this.config.maxCostUsd) {
      return {
        alert: {
          rule: "budget_exceeded",
          severity: "critical",
          message: `Run cost ($${this.totalCost.toFixed(4)}) exceeded budget limit of $${this.config.maxCostUsd.toFixed(2)}.`,
          evidence: [],
        },
        intervention: {
          action: "pause",
          reason: "Run cost exceeded configured budget limit.",
        },
      };
    }

    if (this.totalTokens > this.config.maxTokens) {
      return {
        alert: {
          rule: "token_limit_exceeded",
          severity: "warning",
          message: `Total token consumption (${this.totalTokens}) crossed safety threshold of ${this.config.maxTokens}.`,
          evidence: [],
        },
      };
    }

    return null;
  }
}
