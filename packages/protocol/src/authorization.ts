import { z } from "zod";

export const FoundryUserRoleSchema = z.enum(["PLAYER", "TRUSTED", "ASSISTANT", "GAMEMASTER"]);
export type FoundryUserRole = z.infer<typeof FoundryUserRoleSchema>;

export const RequestedCapabilitySchema = z.enum([
  "read",
  "documents:create",
  "documents:update",
  "assets:upload",
  "assets:attach",
  "sessions:start",
  "sessions:append",
  "ai:network",
]);
export type RequestedCapability = z.infer<typeof RequestedCapabilitySchema>;

export const MutationAuthorizationRequestSchema = z
  .object({
    connectionId: z.string().trim().min(1).max(512),
    foundryUserRole: FoundryUserRoleSchema,
    requestedCapability: RequestedCapabilitySchema.exclude(["read"]),
    tool: z.string().trim().min(1).max(512),
    correlationId: z.string().trim().min(1).max(512),
  })
  .strict();
export type MutationAuthorizationRequest = z.infer<typeof MutationAuthorizationRequestSchema>;
