import net from "node:net";
import fs from "node:fs";
import type { Logger } from "../logger.js";
import { defaultAclCheck, enforceAcl, type AclCheck } from "./acl.js";

const LENGTH_PREFIX_BYTES = 4;

export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];
    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) {
        break;
      }
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < LENGTH_PREFIX_BYTES + length) {
        break;
      }
      const body = this.buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
      this.buffer = this.buffer.subarray(LENGTH_PREFIX_BYTES + length);
      messages.push(JSON.parse(body.toString("utf8")));
    }
    return messages;
  }
}

export interface PipeServerOptions {
  pipePath: string;
  logger: Logger;
  aclCheck?: AclCheck;
  onMessage: (message: unknown, respond: (response: unknown) => void) => void;
}

export interface PipeServerHandle {
  ready: boolean;
  close: () => Promise<void>;
}

export async function startPipeServer(options: PipeServerOptions): Promise<PipeServerHandle> {
  const { pipePath, logger, onMessage } = options;
  const aclCheck = options.aclCheck ?? defaultAclCheck;

  const aclOk = await enforceAcl(pipePath, aclCheck, logger);
  if (!aclOk) {
    return {
      ready: false,
      close: () => Promise.resolve(),
    };
  }

  if (process.platform !== "win32" && fs.existsSync(pipePath)) {
    fs.unlinkSync(pipePath);
  }

  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      const messages = decoder.push(chunk);
      for (const message of messages) {
        onMessage(message, (response) => {
          socket.write(encodeFrame(response));
        });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => {
      server.removeAllListeners("error");
      resolve();
    });
  });

  logger.info("bridge pipe server listening", { pipePath });

  return {
    ready: true,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
