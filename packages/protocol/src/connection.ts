import { z } from "zod";

export const ConnectionStatus = z.enum(["connected", "disconnected", "pairing", "error"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const Connection = z.object({
  connectionId: z.string(),
  worldId: z.string(),
  worldTitle: z.string(),
  status: ConnectionStatus,
  foundryVersion: z.string().optional(),
  lastSeenAt: z.string().optional(),
});
export type Connection = z.infer<typeof Connection>;

export const ConnectionsListInput = z.object({}).strict();
export type ConnectionsListInput = z.infer<typeof ConnectionsListInput>;

export const ConnectionsListOutput = z.object({
  connections: z.array(Connection),
});
export type ConnectionsListOutput = z.infer<typeof ConnectionsListOutput>;
