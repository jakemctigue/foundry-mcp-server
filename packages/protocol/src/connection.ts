import { z } from "zod";

import { FoundryUserRoleSchema } from "./authorization.js";

const SafeIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

const SafeDisplayTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !containsControlCharacter(value), {
    message: "display text cannot contain control characters",
  });

const SafeVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !containsControlCharacter(value), {
    message: "version cannot contain control characters",
  });

export const FoundryCurrentUserSchema = z
  .object({
    id: SafeIdentifierSchema,
    name: SafeDisplayTextSchema,
    role: FoundryUserRoleSchema,
  })
  .strict();
export type FoundryCurrentUser = z.infer<typeof FoundryCurrentUserSchema>;

export const FoundrySystemSchema = z
  .object({
    id: SafeIdentifierSchema,
    version: SafeVersionSchema.optional(),
  })
  .strict();
export type FoundrySystem = z.infer<typeof FoundrySystemSchema>;

export const ActiveFoundryModuleSchema = z
  .object({
    id: SafeIdentifierSchema,
    version: SafeVersionSchema.optional(),
  })
  .strict();
export type ActiveFoundryModule = z.infer<typeof ActiveFoundryModuleSchema>;

export const FoundryModuleCapabilitySchema = z.enum([
  "documents.read",
  "documents.write",
  "assets.read",
  "assets.write",
  "sessions.read",
  "sessions.write",
  "events.publish",
]);
export type FoundryModuleCapability = z.infer<typeof FoundryModuleCapabilitySchema>;

const ActiveFoundryModulesSchema = z
  .array(ActiveFoundryModuleSchema)
  .max(256)
  .refine((modules) => new Set(modules.map(({ id }) => id)).size === modules.length, {
    message: "active Foundry module ids must be unique",
  });

const FoundryModuleCapabilitiesSchema = z
  .array(FoundryModuleCapabilitySchema)
  .min(1)
  .max(32)
  .refine((capabilities) => new Set(capabilities).size === capabilities.length, {
    message: "Foundry module capabilities must be unique",
  });

export const ConnectionStatus = z.enum(["connected", "disconnected", "pairing", "error"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

export const FoundryDiscoveryMetadataSchema = z
  .object({
    currentUser: FoundryCurrentUserSchema,
    system: FoundrySystemSchema,
    activeModules: ActiveFoundryModulesSchema,
    moduleCapabilities: FoundryModuleCapabilitiesSchema,
  })
  .strict();
export type FoundryDiscoveryMetadata = z.infer<typeof FoundryDiscoveryMetadataSchema>;

export const Connection = z
  .object({
    connectionId: z.string().trim().min(1).max(512),
    worldId: z.string().trim().min(1).max(512),
    worldTitle: SafeDisplayTextSchema,
    status: ConnectionStatus,
    foundryVersion: SafeVersionSchema.optional(),
    ...FoundryDiscoveryMetadataSchema.shape,
    lastSeenAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type Connection = z.infer<typeof Connection>;

export const ConnectionsListInput = z.object({}).strict();
export type ConnectionsListInput = z.infer<typeof ConnectionsListInput>;

export const ConnectionsListOutput = z
  .object({
    connections: z.array(Connection).max(256),
  })
  .strict();
export type ConnectionsListOutput = z.infer<typeof ConnectionsListOutput>;
