import type { FastifyInstance } from "fastify";
import type { RealtimeHub } from "../realtime/hub";

export async function realtimeRoutes(app: FastifyInstance, opts: { hub: RealtimeHub }) {
  app.get("/api/v1/realtime", { websocket: true }, (socket, _req) => {
    opts.hub.addClient(socket);
  });
}
