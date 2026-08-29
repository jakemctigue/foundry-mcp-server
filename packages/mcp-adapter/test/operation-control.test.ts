import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PipeClient } from "@foundry-mcp/host";
import { MAX_OPERATION_PROGRESS_UPDATES } from "@foundry-mcp/protocol";

import { connectToDaemon, type BridgeConnection } from "../src/bridge-connection.js";
import { bridgeRequestOptions, requestBridgeValue } from "../src/tools/bridge-tool.js";

function fakePipe(): {
  client: PipeClient;
  send: ReturnType<typeof vi.fn>;
  receive(message: unknown): void;
} {
  let onMessage: (message: unknown) => void = () => undefined;
  const send = vi.fn();
  const client = {
    send,
    close: vi.fn(() => Promise.resolve()),
    onMessage: (listener: (message: unknown) => void) => {
      onMessage = listener;
    },
    onError: vi.fn(),
    onClose: vi.fn(),
  } as unknown as PipeClient;
  return { client, send, receive: (message) => onMessage(message) };
}

describe("adapter operation control", () => {
  let bridge: BridgeConnection | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("honors pre-dispatch abort without writing to the pipe", async () => {
    const pipe = fakePipe();
    bridge = await connectToDaemon("test", {
      connectPipeClient: async () => pipe.client,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      bridge.request("documents.snapshot", {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ envelope: { code: "CANCELLED" } });
    expect(pipe.send).not.toHaveBeenCalled();
  });

  it("preserves an expired MCP deadline and ignores progress notification failures", async () => {
    const expired = Date.now() - 1;
    const notify = vi.fn(() => Promise.reject(new Error("progress consumer disconnected")));
    const options = bridgeRequestOptions({
      mcpReq: {
        id: 7,
        signal: new AbortController().signal,
        _meta: { progressToken: 0, "foundryMcp/deadline": expired },
        notify,
      },
    });
    expect(options.deadline).toBe(expired);
    const value = await requestBridgeValue(
      {
        request: vi.fn(() => Promise.resolve({ value: "committed" })),
        close: vi.fn(() => Promise.resolve()),
      },
      "mutation.execute",
      {},
      z.object({ value: z.string() }),
      options,
    );
    expect(value).toEqual({ value: "committed" });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("sends correlated cancellation and preserves the terminal acknowledgement", async () => {
    const pipe = fakePipe();
    bridge = await connectToDaemon("test", {
      connectPipeClient: async () => pipe.client,
    });
    const controller = new AbortController();
    const request = bridge.request(
      "documents.snapshot",
      {},
      {
        signal: controller.signal,
        correlationId: "mcp-cancel-1",
      },
    );
    const sent = pipe.send.mock.calls[0]?.[0] as { id: string };
    controller.abort();
    pipe.receive({
      id: sent.id,
      error: {
        code: "CANCELLED",
        message: "host acknowledged cancellation",
        retryable: false,
      },
    });
    await expect(request).rejects.toMatchObject({
      envelope: { code: "CANCELLED" },
    });
    expect(pipe.send).toHaveBeenLastCalledWith({
      type: "request.cancel",
      id: sent.id,
      correlationId: "mcp-cancel-1",
      reason: "cancelled",
    });
  });

  it("keeps a cancelled mutation pending for a committed result or indeterminate fallback", async () => {
    const pipe = fakePipe();
    bridge = await connectToDaemon("test", {
      connectPipeClient: async () => pipe.client,
    });
    const committedController = new AbortController();
    const committed = bridge.request(
      "mutation.execute",
      {},
      { signal: committedController.signal, correlationId: "committed-mutation" },
    );
    const committedRequest = pipe.send.mock.calls[0]?.[0] as { id: string };
    committedController.abort();
    pipe.receive({
      id: committedRequest.id,
      result: { ok: true, value: { uuid: "Actor.committed" } },
    });
    await expect(committed).resolves.toEqual({
      ok: true,
      value: { uuid: "Actor.committed" },
    });

    vi.useFakeTimers();
    try {
      const unknownController = new AbortController();
      const unknown = bridge.request(
        "mutation.execute",
        {},
        { signal: unknownController.signal, correlationId: "unknown-mutation" },
      );
      unknownController.abort();
      const rejection = expect(unknown).rejects.toMatchObject({
        envelope: {
          code: "INDETERMINATE_MUTATION",
          retryable: false,
          details: { correlationId: "unknown-mutation", indeterminate: true },
        },
      });
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires deadlines and forwards bounded progress", async () => {
    const pipe = fakePipe();
    bridge = await connectToDaemon("test", {
      connectPipeClient: async () => pipe.client,
    });
    const progress = vi.fn();
    const request = bridge.request(
      "assets.images.generate",
      {},
      {
        deadline: Date.now() + 1_000,
        correlationId: "mcp-progress-1",
        onProgress: progress,
      },
    );
    const sent = pipe.send.mock.calls[0]?.[0] as { id: string };
    pipe.receive({
      type: "request.progress",
      id: sent.id,
      progress: {
        stage: "progress",
        progress: 400,
        total: MAX_OPERATION_PROGRESS_UPDATES,
        message: "provider request",
      },
    });
    pipe.receive({ id: sent.id, result: { ok: true } });
    await expect(request).resolves.toEqual({ ok: true });
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ progress: 400, message: "provider request" }),
    );

    vi.useFakeTimers();
    try {
      const expired = bridge.request(
        "documents.snapshot",
        {},
        {
          deadline: Date.now() + 15,
          correlationId: "mcp-timeout-1",
        },
      );
      const rejection = expect(expired).rejects.toMatchObject({
        envelope: { code: "TIMEOUT" },
      });
      await vi.advanceTimersByTimeAsync(1_016);
      await rejection;
      expect(pipe.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: "request.cancel",
          correlationId: "mcp-timeout-1",
          reason: "timeout",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
