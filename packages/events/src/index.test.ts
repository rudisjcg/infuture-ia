import { describe, expect, it } from "vitest";
import { hasKey, SUPPORTED_LOCALES } from "@infuture/i18n";
import {
  clientMessageSchema,
  createEvent,
  EVENT_TYPES,
  eventLabelKey,
  isPersisted,
  safeParseEvent,
  uuidv7,
} from "./index";

const base = { workspaceId: "ws_1", seq: 1 };

describe("createEvent", () => {
  it("builds a valid, typed event", () => {
    const event = createEvent({
      ...base,
      type: "llm.message.completed",
      runId: "run_1",
      payload: {
        providerId: "anthropic",
        model: "model-x",
        text: "hola",
        tokensIn: 120,
        tokensOut: 40,
        costUsd: 0.0021,
        latencyMs: 900,
      },
    });
    expect(event.type).toBe("llm.message.completed");
    expect(event.payload.tokensOut).toBe(40);
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => new Date(event.ts).toISOString()).not.toThrow();
  });

  it("applies payload defaults", () => {
    const event = createEvent({ ...base, type: "task.created", payload: { title: "Investigar" } });
    expect(event.payload.dependsOn).toEqual([]);
  });

  it("rejects a payload that does not match its type", () => {
    expect(() =>
      createEvent({ ...base, type: "worker.status_changed", payload: { status: "sleeping" as never } }),
    ).toThrow();
  });
});

describe("safeParseEvent", () => {
  it("reports payload errors under the payload path", () => {
    const result = safeParseEvent({
      ...base,
      id: "e1",
      ts: new Date().toISOString(),
      type: "usage.updated",
      payload: { tokensIn: -1, tokensOut: 0, costUsd: 0 },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["payload", "tokensIn"]);
  });

  it("rejects unknown event types", () => {
    const result = safeParseEvent({
      ...base,
      id: "e1",
      ts: new Date().toISOString(),
      type: "nope",
      payload: {},
    });
    expect(result.success).toBe(false);
  });
});

describe("catalog", () => {
  it("does not persist streaming tokens", () => {
    expect(isPersisted("llm.token")).toBe(false);
    expect(isPersisted("llm.message.completed")).toBe(true);
  });

  it.each(SUPPORTED_LOCALES)("every event type has a %s label", (locale) => {
    for (const type of EVENT_TYPES) expect(hasKey(locale, eventLabelKey(type)), type).toBe(true);
  });
});

describe("uuidv7", () => {
  it("sorts by creation time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(a[14]).toBe("7");
  });
});

describe("socket protocol", () => {
  it("accepts valid client messages", () => {
    expect(clientMessageSchema.parse({ op: "subscribe", topics: ["run:abc", "workspace"] }).op).toBe(
      "subscribe",
    );
  });

  it("rejects unknown topics", () => {
    expect(clientMessageSchema.safeParse({ op: "subscribe", topics: ["everything"] }).success).toBe(false);
  });
});
