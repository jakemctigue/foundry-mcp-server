import {
  BRIDGE_PROTOCOL_VERSION,
  CompanionHelloMessageSchema,
  type CompanionHelloMessage,
} from "@foundry-mcp/protocol";

export interface HelloMessage {
  type: "hello";
  protocolVersion: string;
  worldId: string;
}

export function createHelloMessage(worldId: string): HelloMessage {
  return { type: "hello", protocolVersion: BRIDGE_PROTOCOL_VERSION, worldId };
}

export function isCompatibleHello(message: HelloMessage): boolean {
  return message.protocolVersion === BRIDGE_PROTOCOL_VERSION;
}

export type CompanionHelloOptions = Omit<CompanionHelloMessage, "type" | "protocolVersion">;

export function createCompanionHello(options: CompanionHelloOptions): CompanionHelloMessage {
  return CompanionHelloMessageSchema.parse({
    type: "hello",
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    ...options,
  });
}
