import { describe, expect, it, vi } from "vitest";
import { createEvent, type CCEvent } from "@infuture/events";
import { RealtimeHub, type ClientSocket } from "./realtime/hub";
import { MemoryRunStore } from "./runs/store";

function createMockSocket(): ClientSocket & {
  sent: string[];
  handlers: Record<string, ((...args: unknown[]) => void)[]>;
} {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const sent: string[] = [];

  const socket = {
    readyState: 1, // OPEN
    subscriptions: new Set(["workspace"]),
    sent,
    handlers,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] || [];
      handlers[event]?.push(cb);
      return socket as unknown as ClientSocket;
    }),
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
  } as unknown as ClientSocket & {
    sent: string[];
    handlers: Record<string, ((...args: unknown[]) => void)[]>;
  };

  return socket;
}

describe("RealtimeHub", () => {
  it("subscribes clients to topics and broadcasts matching events", async () => {
    const runStore = new MemoryRunStore();
    const hub = new RealtimeHub(runStore);
    const client = createMockSocket();

    hub.addClient(client);
    expect(hub.clientCount).toBe(1);

    // Initial ack message sent
    expect(client.sent).toHaveLength(1);
    expect(JSON.parse(client.sent[0] ?? "{}")).toMatchObject({ op: "ack", id: "init", ok: true });

    // Client subscribes to a specific run
    const messageHandler = client.handlers["message"]?.[0];
    expect(messageHandler).toBeDefined();

    messageHandler?.(
      JSON.stringify({ op: "subscribe", topics: ["run:00000000-0000-4000-8000-000000000099"] }),
    );
    expect(client.subscriptions?.has("run:00000000-0000-4000-8000-000000000099")).toBe(true);

    // Broadcast an event
    const event: CCEvent = createEvent({
      type: "agent.thought",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000099",
      seq: 1,
      payload: { text: "Thinking about testing" },
    });

    hub.broadcast(event);

    const lastMessage = JSON.parse(client.sent[client.sent.length - 1] ?? "{}");
    expect(lastMessage).toMatchObject({
      op: "event",
      event: {
        type: "agent.thought",
        payload: { text: "Thinking about testing" },
      },
    });

    // Client responds to ping
    messageHandler?.(JSON.stringify({ op: "ping" }));
    const pingResponse = JSON.parse(client.sent[client.sent.length - 1] ?? "{}");
    expect(pingResponse).toEqual({ op: "pong" });
  });
});
