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

import type { BridgeConnection, BridgeRequestOptions } from "./bridge-connection.js";
import { requestBridgeValue } from "./tools/bridge-tool.js";

/** One business-logic surface shared by MCP tools and foundry:// resources. */
export class IntelligenceBridgeApi {
  constructor(readonly bridge: BridgeConnection) {}

  search(
    input: IntelligenceSearchInput,
    options?: BridgeRequestOptions,
  ): Promise<IntelligenceSearchOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.search",
      input,
      IntelligenceSearchOutput,
      options,
    );
  }

  status(
    input: IntelligenceStatusInput,
    options?: BridgeRequestOptions,
  ): Promise<IntelligenceStatusOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.status",
      input,
      IntelligenceStatusOutput,
      options,
    );
  }

  timeline(
    input: IntelligenceTimelineInput,
    options?: BridgeRequestOptions,
  ): Promise<IntelligenceTimelineOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.timeline",
      input,
      IntelligenceTimelineOutput,
      options,
    );
  }

  changedSince(
    input: IntelligenceChangedSinceInput,
    options?: BridgeRequestOptions,
  ): Promise<IntelligenceChangedSinceOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.changed-since",
      input,
      IntelligenceChangedSinceOutput,
      options,
    );
  }

  context(
    input: IntelligenceContextInput,
    options?: BridgeRequestOptions,
  ): Promise<IntelligenceContextOutputData> {
    return requestBridgeValue(
      this.bridge,
      "intelligence.context",
      input,
      IntelligenceContextOutput,
      options,
    );
  }
}
