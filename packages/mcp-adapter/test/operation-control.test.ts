import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipeClient } from "@foundry-mcp/host";
import { MAX_OPERATION_PROGRESS_UPDATES } from "@foundry-mcp/protocol";

import { connectToDaemon, type BridgeConnection } from "../src/bridge-connection.js";

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

  it("sends correlated cancellation, ignores a late reply, and clears pending work", async () => {
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
    await expect(request).rejects.toMatchObject({
      envelope: { code: "CANCELLED" },
    });
    expect(pipe.send).toHaveBeenLastCalledWith({
      type: "request.cancel",
      id: sent.id,
      correlationId: "mcp-cancel-1",
      reason: "cancelled",
    });
    expect(() => pipe.receive({ id: sent.id, result: { ignored: true } })).not.toThrow();
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

    const expired = bridge.request(
      "documents.snapshot",
      {},
      {
        deadline: Date.now() + 15,
        correlationId: "mcp-timeout-1",
      },
    );
    await expect(expired).rejects.toMatchObject({
      envelope: { code: "TIMEOUT" },
    });
    expect(pipe.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "request.cancel",
        correlationId: "mcp-timeout-1",
        reason: "timeout",
      }),
    );
  });
});
