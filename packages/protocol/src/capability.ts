import { z } from "zod";

export const Capability = z.object({
  name: z.string(),
  version: z.string(),
  readOnly: z.boolean(),
});
export type Capability = z.infer<typeof Capability>;

export const CapabilitiesGetInput = z.object({}).strict();
export type CapabilitiesGetInput = z.infer<typeof CapabilitiesGetInput>;

export const CapabilitiesGetOutput = z.object({
  mcpProtocolVersion: z.string(),
  legacyMcpProtocolVersions: z.array(z.string()),
  bridgeProtocolVersion: z.string(),
  capabilities: z.array(Capability),
});
export type CapabilitiesGetOutput = z.infer<typeof CapabilitiesGetOutput>;
