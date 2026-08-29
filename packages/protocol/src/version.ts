// docs/PRD.md originally targeted a "2026-07-28" MCP wire version; a
// child-process test against the installed @modelcontextprotocol/sdk
// (packages/mcp-adapter/test-e2e/protocol-negotiation.test.ts) proved that
// version doesn't exist in the SDK. This constant now tracks the SDK's own
// LATEST_PROTOCOL_VERSION and governs the private host<->adapter bridge
// protocol (see bridge-connection.ts negotiateProtocolVersion); it also
// doubles as the value foundry.capabilities.get reports so that tool never
// advertises a version the toolchain can't actually negotiate.
export const PROTOCOL_VERSION = "2025-11-25";
export const LEGACY_PROTOCOL_VERSIONS = ["2025-06-18"] as const;
