import type { WebSocket } from "ws";
import { clientMessageSchema, type CCEvent, type ClientMessage, type ServerMessage } from "@infuture/events";
import type { RunStore } from "../runs/store";

export type ClientSocket = WebSocket & {
  isAlive?: boolean;
  subscriptions?: Set<string>;
};

export class RealtimeHub {
  private clients = new Set<ClientSocket>();

  constructor(private runStore?: RunStore) {}

  addClient(socket: ClientSocket) {
    socket.isAlive = true;
    socket.subscriptions = new Set(["workspace"]); // Default subscribe to workspace
    this.clients.add(socket);

    socket.on("message", async (raw: Buffer | string) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const parsed = JSON.parse(text);
        const validated = clientMessageSchema.safeParse(parsed);
        if (!validated.success) {
          this.send(socket, { op: "ack", id: "unknown", ok: false, error: "Invalid message payload" });
          return;
        }
        await this.handleClientMessage(socket, validated.data);
      } catch (err: unknown) {
        this.send(socket, { op: "ack", id: "unknown", ok: false, error: (err as Error).message });
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
    });

    socket.on("error", () => {
      this.clients.delete(socket);
    });

    // Send initial snapshot or ack
    this.send(socket, { op: "ack", id: "init", ok: true });
  }

  removeClient(socket: ClientSocket) {
    this.clients.delete(socket);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private async handleClientMessage(socket: ClientSocket, msg: ClientMessage) {
    if (!socket.subscriptions) socket.subscriptions = new Set(["workspace"]);

    switch (msg.op) {
      case "ping":
        this.send(socket, { op: "pong" });
        break;

      case "subscribe": {
        for (const topic of msg.topics) {
          socket.subscriptions.add(topic);
        }
        this.send(socket, { op: "ack", id: "sub", ok: true });

        // If client asked for past events from a sequence
        if (msg.sinceSeq !== undefined && this.runStore) {
          for (const topic of msg.topics) {
            if (topic.startsWith("run:")) {
              const runId = topic.slice(4);
              const pastEvents = await this.runStore.getEventsForRun(runId);
              const filtered = pastEvents.filter((e) => e.seq >= (msg.sinceSeq ?? 0));
              if (filtered.length > 0) {
                this.send(socket, { op: "batch", events: filtered });
              }
            }
          }
        }
        break;
      }

      case "unsubscribe":
        for (const topic of msg.topics) {
          socket.subscriptions.delete(topic);
        }
        this.send(socket, { op: "ack", id: "unsub", ok: true });
        break;

      case "command":
        this.send(socket, { op: "ack", id: msg.id, ok: true });
        break;

      case "approval":
        this.send(socket, { op: "ack", id: msg.approvalId, ok: true });
        break;
    }
  }

  broadcast(event: CCEvent) {
    const topics = new Set<string>(["workspace"]);
    if (event.runId) topics.add(`run:${event.runId}`);
    if (event.workerId) topics.add(`worker:${event.workerId}`);

    const message: ServerMessage = { op: "event", event };
    const payload = JSON.stringify(message);

    for (const client of this.clients) {
      if (client.readyState === 1 /* OPEN */ && client.subscriptions) {
        // Check if client is subscribed to at least one matching topic
        let matches = false;
        for (const t of topics) {
          if (client.subscriptions.has(t)) {
            matches = true;
            break;
          }
        }
        if (matches) {
          try {
            client.send(payload);
          } catch {
            this.clients.delete(client);
          }
        }
      }
    }
  }

  private send(socket: ClientSocket, message: ServerMessage) {
    if (socket.readyState === 1 /* OPEN */) {
      try {
        socket.send(JSON.stringify(message));
      } catch {
        this.clients.delete(socket);
      }
    }
  }
}
