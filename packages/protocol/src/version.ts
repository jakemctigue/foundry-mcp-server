/** MCP wire revision served by the adapter's modern stdio path. */
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

/**
 * Legacy MCP revisions deliberately covered by built child-process tests.
 * Keep this list synchronized with protocol-legacy.test.ts.
 */
export const LEGACY_MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

/** Private Foundry module/host/adapter bridge revision; this is not MCP. */
export const BRIDGE_PROTOCOL_VERSION = "3" as const;
