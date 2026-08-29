import {
  IntelligenceChangedSinceOutput,
  IntelligenceContextOutput,
  IntelligenceSearchOutput,
  IntelligenceStatusOutput,
  IntelligenceTimelineOutput,
  type IntelligenceChangedSinceInput,
  type IntelligenceChangedSinceOutput as IntelligenceChangedSinceOutputData,
  type IntelligenceContextInput,
  type IntelligenceContextOutput as IntelligenceContextOutputData,
  type IntelligenceSearchInput,
  type IntelligenceSearchOutput as IntelligenceSearchOutputData,
  type IntelligenceStatusInput,
  type IntelligenceStatusOutput as IntelligenceStatusOutputData,
  type IntelligenceTimelineInput,
  type IntelligenceTimelineOutput as IntelligenceTimelineOutputData,
} from "@foundry-mcp/protocol";

import type { BridgeConnection } from "./bridge-connection.js";
import { requestBridgeValue } from "./tools/bridge-tool.js";

/** One business-logic surface shared by MCP tools and foundry:// resources. */
export class IntelligenceBridgeApi {
  constructor(readonly bridge: BridgeConnection) {}

  search(input: IntelligenceSearchInput): Promise<IntelligenceSearchOutputData> {
    return requestBridgeValue(this.bridge, "intelligence.search", input, IntelligenceSearchOutput);
  }

  status(input: IntelligenceStatusInput): Promise<IntelligenceStatusOutputData> {
    return requestBridgeValue(this.bridge, "intelligence.status", input, IntelligenceStatusOutput);
  }

  timeline(input: IntelligenceTimelineInput): Promise<IntelligenceTimelineOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.timeline",
      input,
      IntelligenceTimelineOutput,
    );
  }

  changedSince(input: IntelligenceChangedSinceInput): Promise<IntelligenceChangedSinceOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.changed-since",
      input,
      IntelligenceChangedSinceOutput,
    );
  }

  context(input: IntelligenceContextInput): Promise<IntelligenceContextOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.context",
      input,
      IntelligenceContextOutput,
    );
  }
}
