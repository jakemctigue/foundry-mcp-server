import { PROTOCOL_VERSION } from "@foundry-mcp/protocol";

export interface HelloMessage {
  type: "hello";
  protocolVersion: string;
  worldId: string;
}

export function createHelloMessage(worldId: string): HelloMessage {
  return { type: "hello", protocolVersion: PROTOCOL_VERSION, worldId };
}

export function isCompatibleHello(message: HelloMessage): boolean {
  return message.protocolVersion === PROTOCOL_VERSION;
}
