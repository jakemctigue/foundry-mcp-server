import {
  CompanionRequestMessageSchema,
  CompanionWireMessageSchema,
  EventEnvelopeSchema,
  EventAckMessageSchema,
  EventResumeMessageSchema,
  type CompanionResponseMessage,
  type CompanionHelloMessage,
  type EventEnvelope,
  type EventPublishMessage,
  type JsonValue,
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
  handleRequest: (method: string, params: Record<string, JsonValue>) => Promise<JsonValue>;
  hello?: CompanionHelloMessage;
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
  return { nextSequenceId: 1, pendingEvents: [], responses: [] };
}

function parseState(raw: string | null, connectionId: string): PersistedState {
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const nextSequenceId = parsed.nextSequenceId;
    if (!Number.isSafeInteger(nextSequenceId) || (nextSequenceId ?? 0) < 1) return emptyState();
    const pendingEvents = (parsed.pendingEvents ?? []).flatMap((message) => {
      const result = CompanionWireMessageSchema.safeParse(message);
      return result.success && result.data.type === "event" && result.data.connectionId === connectionId
        ? [result.data]
        : [];
    });
    const responses = (parsed.responses ?? []).flatMap((message) => {
      const result = CompanionWireMessageSchema.safeParse(message);
      return result.success && result.data.type === "response" ? [result.data] : [];
    });
    return { nextSequenceId: nextSequenceId as number, pendingEvents, responses };
  } catch {
    return emptyState();
  }
}

/** Reconnecting browser bridge with durable event replay and request response dedupe. */
export class CompanionBridgeClient {
  readonly #endpoint: string;
  readonly #storageKey: string;
  readonly #maxPendingEvents: number;
  readonly #maxCachedResponses: number;
  readonly #schedule: (callback: () => void, delayMs: number) => unknown;
  #state: PersistedState;
  #socket: CompanionSocket | undefined;
  #stopped = true;
  #resumed = false;
  readonly #inFlightRequests = new Map<string, Promise<CompanionResponseMessage>>();

  constructor(readonly options: CompanionClientOptions) {
    this.#endpoint = validateEndpoint(options.endpoint);
    validateOrigin(options.pageOrigin, options.allowedOrigins);
    this.#storageKey = options.storageKey ?? `foundry-mcp:${options.connectionId}:bridge-state`;
    this.#maxPendingEvents = options.maxPendingEvents ?? 500;
    this.#maxCachedResponses = options.maxCachedResponses ?? 500;
    this.#schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
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
      throw new Error("event reconciliation window is full; refusing to drop unacknowledged events");
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
    socket.addEventListener("open", () => {
      // The host sends its durable resume point. Pending events are not sent
      // until that point is received, preventing reconnect races.
      if (this.options.hello) socket.send(JSON.stringify(this.options.hello));
    });
    socket.addEventListener("message", (event) => void this.#receive(event.data));
    socket.addEventListener("close", () => {
      if (this.#socket === socket) this.#socket = undefined;
      if (!this.#stopped) {
        this.#schedule(() => this.#connect(), this.options.reconnectDelayMs ?? 1_000);
      }
    });
  }

  async #receive(raw: unknown): Promise<void> {
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
    if (EventResumeMessageSchema.safeParse(parsed.data).success) {
      const resume = EventResumeMessageSchema.parse(parsed.data);
      if (resume.connectionId !== this.options.connectionId) return;
      this.#resumed = true;
      for (const event of this.#state.pendingEvents) {
        if (event.envelope.sequenceId >= resume.nextSequenceId) this.#send(event);
      }
      return;
    }
    if (EventAckMessageSchema.safeParse(parsed.data).success) {
      const ack = EventAckMessageSchema.parse(parsed.data);
      if (ack.connectionId !== this.options.connectionId) return;
      this.#state.pendingEvents = this.#state.pendingEvents.filter(
        (event) => event.envelope.sequenceId > ack.acknowledgedSequenceId,
      );
      this.#persist();
      return;
    }
    if (!CompanionRequestMessageSchema.safeParse(parsed.data).success) return;
    const request = CompanionRequestMessageSchema.parse(parsed.data);
    const cached = this.#state.responses.find((response) => response.id === request.id);
    if (cached) {
      this.#send(cached);
      return;
    }
    const inFlight = this.#inFlightRequests.get(request.id);
    if (inFlight) {
      this.#send(await inFlight);
      return;
    }
    const execution = this.#executeRequest(request);
    this.#inFlightRequests.set(request.id, execution);
    let response: CompanionResponseMessage;
    try {
      response = await execution;
    } finally {
      this.#inFlightRequests.delete(request.id);
    }
    this.#state.responses.push(response);
    this.#state.responses = this.#state.responses.slice(-this.#maxCachedResponses);
    this.#persist();
    this.#send(response);
  }

  async #executeRequest(
    request: ReturnType<typeof CompanionRequestMessageSchema.parse>,
  ): Promise<CompanionResponseMessage> {
    let response: CompanionResponseMessage;
    try {
      const value = await this.options.handleRequest(request.method, request.params);
      response = { type: "response", id: request.id, ok: true, value };
    } catch (error) {
      response = {
        type: "response",
        id: request.id,
        ok: false,
        error: {
          code: "FOUNDRY_ERROR",
          message: error instanceof Error ? error.message : "companion request failed",
        },
      };
    }
    return response;
  }

  #send(message: EventPublishMessage | CompanionResponseMessage): void {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(message));
  }

  #persist(): void {
    this.options.storage.setItem(this.#storageKey, JSON.stringify(this.#state));
  }
}

export { validateEndpoint as validateCompanionEndpoint };
