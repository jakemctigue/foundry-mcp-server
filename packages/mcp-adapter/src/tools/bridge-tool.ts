import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { ErrorEnvelope, makeError } from "@foundry-mcp/protocol";
import type { BridgeConnection } from "../bridge-connection.js";

function errorContent(error: z.infer<typeof ErrorEnvelope>): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text: JSON.stringify(error) }], isError: true };
}

export async function forwardBridgeTool(
  bridge: BridgeConnection,
  method: string,
  args: Record<string, unknown>,
  outputSchema: z.ZodType,
): Promise<
  | { content: Array<{ type: "text"; text: string }>; structuredContent: Record<string, unknown> }
  | { content: Array<{ type: "text"; text: string }>; isError: true }
> {
  try {
    let raw = await bridge.request(method, args);
    if (raw && typeof raw === "object" && "ok" in raw) {
      const result = raw as { ok?: unknown; value?: unknown; error?: unknown };
      if (result.ok === false) {
        const parsedError = ErrorEnvelope.safeParse(result.error);
        return errorContent(
          parsedError.success
            ? parsedError.data
            : makeError("FOUNDRY_ERROR", "Bridge returned a malformed operation error"),
        );
      }
      if (result.ok === true) raw = result.value;
    }
    const parsed = outputSchema.safeParse(raw);
    if (!parsed.success)
      return errorContent(
        makeError("INVALID_DATA", `Bridge returned malformed data for ${method}`, false, {
          issues: parsed.error.issues,
        }),
      );
    return {
      content: [{ type: "text", text: `${method} completed successfully.` }],
      structuredContent: parsed.data as Record<string, unknown>,
    };
  } catch {
    return errorContent(makeError("OFFLINE_BRIDGE", `Bridge request ${method} failed`, true));
  }
}

export type ToolServer = Pick<McpServer, "registerTool">;
