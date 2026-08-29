import {
  CompanionAuthChallengeMessageSchema,
  CompanionAuthReadyMessageSchema,
  CompanionRequestCancelMessageSchema,
  CompanionRequestMessageSchema,
  CompanionWireMessageSchema,
  EventEnvelopeSchema,
  EventAckMessageSchema,
  EventResumeMessageSchema,
  companionAuthPayload,
  companionAuthReadyPayload,
  MAX_OPERATION_DURATION_MS,
  MAX_OPERATION_PROGRESS_UPDATES,
  makeError,
  type CompanionAuthProofMessage,
  type CompanionResponseMessage,
  type CompanionRequestProgressMessage,
  type CompanionHelloMessage,
  type EventEnvelope,
  type EventPublishMessage,
  type JsonValue,
  type OperationExecutionOptions,
  type OperationProgress,
} from "@foundry-mcp/protocol";

export interface CompanionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CompanionSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface CompanionClientOptions {
  endpoint: string;
  allowedOrigins: readonly string[];
  pageOrigin: string;
  connectionId: string;
  storage: CompanionStorage;
  createSocket: (endpoint: string) => CompanionSocket;
  handleRequest: (
    method: string,
    params: Record<string, JsonValue>,
    options: OperationExecutionOptions,
  ) => Promise<JsonValue>;
  hello?: CompanionHelloMessage;
  /** Base32 value shown by the pairing command, or the equivalent raw 32 bytes. */
  pairingSecret?: string | Uint8Array;
  storageKey?: string;
  maxPendingEvents?: number;
  maxCachedResponses?: number;
  reconnectDelayMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

interface PersistedState {
  nextSequenceId: number;
  pendingEvents: EventPublishMessage[];
  responses: CompanionResponseMessage[];
  inFlightMutations: Array<{ id: string; method: string }>;
}

interface InFlightRequest {
  controller: AbortController;
  correlationId: string;
  deadline: number;
  promise: Promise<CompanionResponseMessage>;
  timer?: ReturnType<typeof setTimeout> | undefined;
  committed: boolean;
  committedDetails?: string | undefined;
  progressUpdates: number;
  waiters: number;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MUTATION_METHODS = new Set([
  "documents.create",
  "documents.update",
  "assets.images.upload",
  "assets.images.generate",
  "assets.images.attach",
  "sessions.start",
  "sessions.append",
  "sessions.end",
  "sessions.reopen",
]);

interface SubtleCryptoLike {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    keyUsages: readonly ["sign"],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function base32DecodeStrict(encoded: string): Uint8Array {
  const normalized = encoded.trim().toUpperCase();
  if (!/^[A-Z2-7]+$/.test(normalized)) throw new Error("pairing secret is not valid base32");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function pairingSecretBytes(value: string | Uint8Array | undefined): Uint8Array {
  if (value === undefined) {
    throw new Error("companion pairing secret is required before connecting");
  }
  const bytes = typeof value === "string" ? base32DecodeStrict(value) : new Uint8Array(value);
  if (bytes.byteLength !== 32) throw new Error("companion pairing secret must be 32 bytes");
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64URL_ALPHABET[first >>> 2] ?? "";
    output += BASE64URL_ALPHABET[((first & 3) << 4) | ((second ?? 0) >>> 4)] ?? "";
    if (second !== undefined) {
      output += BASE64URL_ALPHABET[((second & 15) << 2) | ((third ?? 0) >>> 6)] ?? "";
    }
    if (third !== undefined) output += BASE64URL_ALPHABET[third & 63] ?? "";
  }
  return output;
}

function fixedStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function signCompanionProof(secret: Uint8Array, payload: string): Promise<string> {
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCryptoLike } }).crypto
    ?.subtle;
  if (!subtle) throw new Error("Web Crypto HMAC is required for companion pairing");
  const key = await subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return base64UrlEncode(
    new Uint8Array(await subtle.sign("HMAC", key, new TextEncoder().encode(payload))),
  );
}

function validateEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("companion endpoint must use ws:// or wss://");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("companion endpoint cannot contain credentials or a fragment");
  }
  return url.href;
}

function validateOrigin(pageOrigin: string, allowedOrigins: readonly string[]): string {
  if (allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    throw new Error("companion allowedOrigins must contain exact origins and no wildcard");
  }
  const origin = new URL(pageOrigin).origin;
  if (origin !== pageOrigin || !allowedOrigins.includes(origin)) {
    throw new Error(`current Foundry Origin is not allowed: ${origin}`);
  }
  return origin;
}

function emptyState(): PersistedState {
  return { nextSequenceId: 1, pendingEvents: [], responses: [], inFlightMutations: [] };
}

function parseState(raw: string | null, connectionId: string): PersistedState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const nextSequenceId = parsed.nextSequenceId;
    if (!Number.isSafeInteger(nextSequenceId) || (nextSequenceId ?? 0) < 1) return emptyState();
    const pendingEvents = (parsed.pendingEvents ?? []).flatMap((message) => {
      const result = CompanionWireMessageSchema.safeParse(message);
      return result.success &&
        result.data.type === "event" &&
        result.data.connectionId === connectionId
        ? [result.data]
        : [];
    });
    const responses = (parsed.responses ?? []).flatMap((message) => {
      const result = CompanionWireMessageSchema.safeParse(message);
      return result.success && result.data.type === "response" ? [result.data] : [];
    });
    const inFlightMutations = (parsed.inFlightMutations ?? []).flatMap((entry) => {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "string" &&
        typeof (entry as { method?: unknown }).method === "string"
      ) {
        return [
          {
            id: (entry as { id: string }).id,
            method: (entry as { method: string }).method,
          },
        ];
      }
      return [];
    });
    return {
      nextSequenceId: nextSequenceId as number,
      pendingEvents,
      responses,
      inFlightMutations,
    };
  } catch {
    return emptyState();
  }
}

/** Reconnecting browser bridge with durable event replay and request response dedupe. */
export class CompanionBridgeClient {
  readonly #endpoint: string;
  readonly #storageKey: string;
  readonly #pageOrigin: string;
  readonly #maxPendingEvents: number;
  readonly #maxCachedResponses: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  readonly #pairingSecret: Uint8Array;
  #state: PersistedState;
  #socket: CompanionSocket | undefined;
  #stopped = true;
  #resumed = false;
  #authenticated = false;
  #challenge: string | undefined;
  #receiveQueue: Promise<void> = Promise.resolve();
  readonly #inFlightRequests = new Map<string, InFlightRequest>();

  constructor(readonly options: CompanionClientOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    this.#pageOrigin = validateOrigin(options.pageOrigin, options.allowedOrigins);
    this.#storageKey = options.storageKey ?? `foundry-mcp:${options.connectionId}:bridge-state`;
    this.#maxPendingEvents = options.maxPendingEvents ?? 500;
    this.#maxCachedResponses = options.maxCachedResponses ?? 500;
    this.#schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    if (!options.hello) throw new Error("companion hello identity is required before connecting");
    this.#pairingSecret = pairingSecretBytes(options.pairingSecret);
    this.#state = parseState(options.storage.getItem(this.#storageKey), options.connectionId);
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#socket?.close(1000, "Foundry MCP companion stopped");
    this.#socket = undefined;
    this.#resumed = false;
    this.#authenticated = false;
    this.#challenge = undefined;
    for (const request of this.#inFlightRequests.values()) request.controller.abort("cancelled");
  }

  publish(event: Omit<EventEnvelope, "sequenceId">): EventEnvelope {
    const envelope: EventEnvelope = { ...event, sequenceId: this.#state.nextSequenceId };
    const message: EventPublishMessage = {
      type: "event",
      connectionId: this.options.connectionId,
      envelope: EventEnvelopeSchema.parse(envelope),
    };
    this.#state.nextSequenceId += 1;
    this.#state.pendingEvents.push(message);
    if (this.#state.pendingEvents.length > this.#maxPendingEvents) {
      throw new Error(
        "event reconciliation window is full; refusing to drop unacknowledged events",
      );
    }
    this.#persist();
    if (this.#resumed) this.#send(message);
    return envelope;
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = this.options.createSocket(this.#endpoint);
    this.#socket = socket;
    this.#resumed = false;
    this.#authenticated = false;
    this.#challenge = undefined;
    socket.addEventListener("open", () => undefined);
    socket.addEventListener("message", (event) => {
      this.#receiveQueue = this.#receiveQueue
        .then(() => this.#receive(socket, event.data))
        .catch(() => {
          if (this.#socket === socket) socket.close(1011, "companion message handling failed");
        });
      return this.#receiveQueue;
    });
    socket.addEventListener("close", () => {
      const wasCurrent = this.#socket === socket;
      if (wasCurrent) {
        this.#socket = undefined;
        this.#authenticated = false;
        this.#resumed = false;
        this.#challenge = undefined;
      }
      if (wasCurrent && !this.#stopped) {
        this.#schedule(() => this.#connect(), this.options.reconnectDelayMs ?? 1_000);
      }
    });
  }

  async #receive(socket: CompanionSocket, raw: unknown): Promise<void> {
    if (this.#socket !== socket) return;
    let decoded: unknown;
    try {
      const text = typeof raw === "string" ? raw : String(raw);
      decoded = JSON.parse(text) as unknown;
    } catch {
      this.#socket?.close(1003, "invalid JSON");
      return;
    }
    const parsed = CompanionWireMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      this.#socket?.close(1003, "invalid bridge message");
      return;
    }
    if (CompanionAuthChallengeMessageSchema.safeParse(parsed.data).success) {
      if (this.#authenticated) {
        socket.close(1008, "duplicate companion authentication challenge");
        return;
      }
      const challenge = CompanionAuthChallengeMessageSchema.parse(parsed.data);
      const hello = this.options.hello;
      if (!hello) {
        socket.close(1008, "companion hello identity is unavailable");
        return;
      }
      if (challenge.origin !== this.#pageOrigin) {
        socket.close(1008, "companion authentication Origin mismatch");
        return;
      }
      let proof: CompanionAuthProofMessage;
      try {
        proof = {
          type: "auth.proof",
          hello,
          proof: await signCompanionProof(
            this.#pairingSecret,
            companionAuthPayload(challenge.challenge, challenge.origin, hello),
          ),
        };
      } catch {
        socket.close(1011, "companion pairing proof is unavailable");
        return;
      }
      this.#challenge = challenge.challenge;
      if (this.#socket === socket && socket.readyState === 1) socket.send(JSON.stringify(proof));
      return;
    }
    if (CompanionAuthReadyMessageSchema.safeParse(parsed.data).success) {
      const ready = CompanionAuthReadyMessageSchema.parse(parsed.data);
      const hello = this.options.hello;
      const challenge = this.#challenge;
      if (
        !hello ||
        !challenge ||
        ready.connectionId !== this.options.connectionId ||
        !fixedStringEqual(
          ready.proof,
          await signCompanionProof(
            this.#pairingSecret,
            companionAuthReadyPayload(challenge, this.#pageOrigin, hello),
          ),
        )
      ) {
        socket.close(1008, "companion host authentication failed");
        return;
      }
      this.#authenticated = true;
      this.#challenge = undefined;
      return;
    }
    if (EventResumeMessageSchema.safeParse(parsed.data).success) {
      const resume = EventResumeMessageSchema.parse(parsed.data);
      if (!this.#authenticated) {
        socket.close(1008, "authenticated companion ready proof required");
        return;
      }
      if (resume.connectionId !== this.options.connectionId) return;
      this.#state.pendingEvents = this.#state.pendingEvents.filter(
        (event) => event.envelope.sequenceId >= resume.nextSequenceId,
      );
      this.#state.nextSequenceId = Math.max(this.#state.nextSequenceId, resume.nextSequenceId);
      this.#persist();
      this.#resumed = true;
      for (const event of this.#state.pendingEvents) {
        if (event.envelope.sequenceId >= resume.nextSequenceId) this.#send(event);
      }
      return;
    }
    if (!this.#authenticated) {
      socket.close(1008, "authenticated companion challenge required");
      return;
    }
    if (EventAckMessageSchema.safeParse(parsed.data).success) {
      const ack = EventAckMessageSchema.parse(parsed.data);
      if (ack.connectionId !== this.options.connectionId) return;
      this.#state.pendingEvents = this.#state.pendingEvents.filter(
        (event) => event.envelope.sequenceId > ack.acknowledgedSequenceId,
      );
      this.#state.nextSequenceId = Math.max(this.#state.nextSequenceId, ack.nextSequenceId);
      this.#persist();
      return;
    }
    if (CompanionRequestCancelMessageSchema.safeParse(parsed.data).success) {
      const cancellation = CompanionRequestCancelMessageSchema.parse(parsed.data);
      const inFlight = this.#inFlightRequests.get(cancellation.id);
      if (inFlight?.correlationId === cancellation.correlationId) {
        inFlight.controller.abort(cancellation.reason);
      }
      return;
    }
    if (!CompanionRequestMessageSchema.safeParse(parsed.data).success) return;
    const request = CompanionRequestMessageSchema.parse(parsed.data);
    this.#beginRequest(request);
  }

  #beginRequest(request: ReturnType<typeof CompanionRequestMessageSchema.parse>): void {
    const cached = this.#state.responses.find((response) => response.id === request.id);
    if (cached) {
      this.#send(cached);
      return;
    }
    const inFlight = this.#inFlightRequests.get(request.id);
    if (inFlight) {
      inFlight.waiters += 1;
      return;
    }
    const recoveredMutation = this.#state.inFlightMutations.find(
      (entry) => entry.id === request.id,
    );
    if (recoveredMutation) {
      const response: CompanionResponseMessage = {
        type: "response",
        id: request.id,
        ok: false,
        error: {
          code: "INDETERMINATE_MUTATION",
          message: `Mutation ${recoveredMutation.method} may have committed before restart; reconcile state before retrying`,
          retryable: false,
          details: { committed: true, indeterminate: true },
        },
      };
      this.#state.inFlightMutations = this.#state.inFlightMutations.filter(
        (entry) => entry.id !== request.id,
      );
      this.#cacheResponse(response);
      this.#persist();
      this.#send(response);
      return;
    }
    const isMutation = MUTATION_METHODS.has(request.method);
    if (isMutation) {
      this.#state.inFlightMutations.push({ id: request.id, method: request.method });
      this.#persist();
    }
    const now = Date.now();
    const deadline = Math.min(
      request.control?.deadline ?? now + MAX_OPERATION_DURATION_MS,
      now + MAX_OPERATION_DURATION_MS,
    );
    const state: InFlightRequest = {
      controller: new AbortController(),
      correlationId: request.control?.correlationId ?? request.id.slice(0, 128),
      deadline,
      promise: Promise.resolve({ type: "response", id: request.id, ok: true, value: null }),
      committed: false,
      progressUpdates: 0,
      waiters: 1,
    };
    if (deadline <= now) state.controller.abort("timeout");
    else {
      state.timer = setTimeout(() => state.controller.abort("timeout"), deadline - now);
    }
    const execution = this.#executeRequest(request, state, isMutation);
    state.promise = execution;
    this.#inFlightRequests.set(request.id, state);
    void execution.then((response) => {
      if (state.timer) clearTimeout(state.timer);
      if (this.#inFlightRequests.get(request.id) === state) {
        this.#inFlightRequests.delete(request.id);
      }
      if (isMutation) {
        this.#state.inFlightMutations = this.#state.inFlightMutations.filter(
          (entry) => entry.id !== request.id,
        );
      }
      this.#cacheResponse(response);
      this.#persist();
      for (let index = 0; index < state.waiters; index += 1) this.#send(response);
    });
  }

  #cacheResponse(response: CompanionResponseMessage): void {
    this.#state.responses.push(response);
    this.#state.responses = this.#state.responses.slice(-this.#maxCachedResponses);
  }

  async #executeRequest(
    request: ReturnType<typeof CompanionRequestMessageSchema.parse>,
    state: InFlightRequest,
    isMutation: boolean,
  ): Promise<CompanionResponseMessage> {
    let response: CompanionResponseMessage;
    const reportProgress = async (progress: OperationProgress): Promise<void> => {
      if (!request.control?.progress || state.progressUpdates >= MAX_OPERATION_PROGRESS_UPDATES)
        return;
      state.progressUpdates += 1;
      this.#send({ type: "request.progress", id: request.id, progress });
    };
    try {
      state.controller.signal.throwIfAborted();
      await reportProgress({
        stage: "start",
        progress: 0,
        total: MAX_OPERATION_PROGRESS_UPDATES,
        message: `${request.method} started`,
      });
      const value = await this.options.handleRequest(request.method, request.params, {
        signal: state.controller.signal,
        deadline: state.deadline,
        correlationId: state.correlationId,
        reportProgress,
        markCommitted: (details) => {
          state.committed = true;
          state.committedDetails = details;
        },
      });
      state.controller.signal.throwIfAborted();
      await reportProgress({
        stage: "complete",
        progress: MAX_OPERATION_PROGRESS_UPDATES,
        total: MAX_OPERATION_PROGRESS_UPDATES,
        message: `${request.method} completed`,
      });
      response = { type: "response", id: request.id, ok: true, value };
    } catch (error) {
      if (state.controller.signal.aborted) {
        const timedOut =
          Date.now() >= state.deadline || state.controller.signal.reason === "timeout";
        const envelope =
          isMutation && state.committed
            ? makeError(
                "INDETERMINATE_MUTATION",
                `Mutation ${request.method} committed before cancellation; reconcile state before retrying`,
                false,
                {
                  committed: true,
                  indeterminate: true,
                  correlationId: state.correlationId,
                  ...(state.committedDetails ? { phase: state.committedDetails } : {}),
                },
              )
            : makeError(
                timedOut ? "TIMEOUT" : "CANCELLED",
                timedOut ? "Operation deadline elapsed" : "Operation was cancelled",
                false,
                { correlationId: state.correlationId },
              );
        return {
          type: "response",
          id: request.id,
          ok: false,
          error: JSON.parse(JSON.stringify(envelope)) as JsonValue,
        };
      }
      response = {
        type: "response",
        id: request.id,
        ok: false,
        error: {
          code: "FOUNDRY_ERROR",
          message: error instanceof Error ? error.message : "companion request failed",
          retryable: false,
        },
      };
    }
    return response;
  }

  #send(
    message: EventPublishMessage | CompanionResponseMessage | CompanionRequestProgressMessage,
  ): void {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(message));
  }

  #persist(): void {
    this.options.storage.setItem(this.#storageKey, JSON.stringify(this.#state));
  }
}

export { validateEndpoint as validateCompanionEndpoint };
