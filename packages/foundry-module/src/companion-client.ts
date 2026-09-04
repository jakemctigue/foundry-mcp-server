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
  companionIdentityAuthPayload,
  companionIdentityConfirmPayload,
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
  responseIdentities: RequestIdentity[];
  inFlightMutations: PersistedMutation[];
  identityCredential?: string;
}

interface RequestIdentity {
  id: string;
  correlationId: string;
  method: string;
  paramsHash: string;
}

interface PersistedMutation {
  id: string;
  method: string;
  correlationId?: string | undefined;
  paramsHash?: string | undefined;
}

interface InFlightRequest {
  controller: AbortController;
  identity: RequestIdentity;
  correlationId: string;
  deadline: number;
  promise: Promise<CompanionResponseMessage>;
  timer?: ReturnType<typeof setTimeout> | undefined;
  committed: boolean;
  committedDetails?: string | undefined;
  dispatched: boolean;
  finished: boolean;
  progressUpdates: number;
  waiters: number;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const MAX_CACHED_READ_RESPONSE_BYTES = 1024 * 1024;
const READ_METHODS = new Set([
  "documents.types",
  "documents.list",
  "documents.get",
  "documents.embedded.list",
  "documents.snapshot",
  "compendiums.list",
  "compendiums.documents.list",
  "assets.images.list",
  "assets.references.find",
  "sessions.list",
  "sessions.get",
]);
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
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
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

function base64UrlDecodeStrict(value: string, expectedBytes: number): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== expectedBytes || base64UrlEncode(bytes) !== value) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

function fixedStringEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, JsonValue>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestIdentity(
  request: ReturnType<typeof CompanionRequestMessageSchema.parse>,
): Promise<RequestIdentity> {
  const subtle = (globalThis as unknown as { crypto?: { subtle?: SubtleCryptoLike } }).crypto
    ?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is required for request identity validation");
  const paramsHash = base64UrlEncode(
    new Uint8Array(
      await subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(request.params))),
    ),
  );
  return {
    id: request.id,
    correlationId: request.control?.correlationId ?? request.id.slice(0, 128),
    method: request.method,
    paramsHash,
  };
}

function sameRequestIdentity(left: RequestIdentity, right: RequestIdentity): boolean {
  return (
    left.id === right.id &&
    left.correlationId === right.correlationId &&
    left.method === right.method &&
    fixedStringEqual(left.paramsHash, right.paramsHash)
  );
}

function requestConflictResponse(
  request: ReturnType<typeof CompanionRequestMessageSchema.parse>,
  existing?: RequestIdentity,
): CompanionResponseMessage {
  return {
    type: "response",
    id: request.id,
    ok: false,
    error: {
      code: "CONFLICT",
      message: `Request id ${request.id} is already bound to a different operation`,
      retryable: false,
      details: {
        requestId: request.id,
        correlationId: request.control?.correlationId ?? request.id.slice(0, 128),
        method: request.method,
        ...(existing
          ? {
              existingCorrelationId: existing.correlationId,
              existingMethod: existing.method,
            }
          : {}),
      },
    },
  };
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

function parseRequestIdentity(value: unknown): RequestIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<RequestIdentity>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.correlationId !== "string" ||
    typeof candidate.method !== "string" ||
    typeof candidate.paramsHash !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.paramsHash)
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    correlationId: candidate.correlationId,
    method: candidate.method,
    paramsHash: candidate.paramsHash,
  };
}

function emptyState(): PersistedState {
  return {
    nextSequenceId: 1,
    pendingEvents: [],
    responses: [],
    responseIdentities: [],
    inFlightMutations: [],
  };
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
    const responseIds = new Set(responses.map((response) => response.id));
    const responseIdentities = (parsed.responseIdentities ?? [])
      .flatMap((entry) => {
        const identity = parseRequestIdentity(entry);
        return identity ? [identity] : [];
      })
      .filter((identity) => responseIds.has(identity.id));
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
            ...(typeof (entry as { correlationId?: unknown }).correlationId === "string"
              ? { correlationId: (entry as { correlationId: string }).correlationId }
              : {}),
            ...(typeof (entry as { paramsHash?: unknown }).paramsHash === "string" &&
            /^[A-Za-z0-9_-]{43}$/.test((entry as { paramsHash: string }).paramsHash)
              ? { paramsHash: (entry as { paramsHash: string }).paramsHash }
              : {}),
          },
        ];
      }
      return [];
    });
    return {
      nextSequenceId: nextSequenceId as number,
      pendingEvents,
      responses,
      responseIdentities,
      inFlightMutations,
      ...(typeof parsed.identityCredential === "string" &&
      base64UrlDecodeStrict(parsed.identityCredential, 32)
        ? { identityCredential: parsed.identityCredential }
        : {}),
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
        const payload = companionAuthPayload(challenge.challenge, challenge.origin, hello);
        const identityCredential = this.#state.identityCredential
          ? base64UrlDecodeStrict(this.#state.identityCredential, 32)
          : undefined;
        proof = {
          type: "auth.proof",
          hello,
          proof: await signCompanionProof(this.#pairingSecret, payload),
          ...(identityCredential
            ? {
                identityProof: await signCompanionProof(
                  identityCredential,
                  companionIdentityAuthPayload(challenge.challenge, challenge.origin, hello),
                ),
              }
            : {}),
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
      if (ready.identityCredential) {
        const identityCredential = base64UrlDecodeStrict(ready.identityCredential, 32);
        if (!identityCredential) {
          socket.close(1008, "companion host returned an invalid identity credential");
          return;
        }
        this.#state.identityCredential = ready.identityCredential;
        this.#persist();
        const confirmation = {
          type: "auth.confirm" as const,
          connectionId: this.options.connectionId,
          proof: await signCompanionProof(
            identityCredential,
            companionIdentityConfirmPayload(challenge, this.#pageOrigin, hello),
          ),
        };
        if (this.#socket !== socket || socket.readyState !== 1) return;
        socket.send(JSON.stringify(confirmation));
      } else if (!this.#state.identityCredential) {
        socket.close(1008, "companion host did not complete identity enrollment");
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
    await this.#beginRequest(request);
  }

  async #beginRequest(
    request: ReturnType<typeof CompanionRequestMessageSchema.parse>,
  ): Promise<void> {
    const identity = await requestIdentity(request);
    const cached = this.#state.responses.find((response) => response.id === request.id);
    if (cached) {
      const cachedIdentity = this.#state.responseIdentities.find(
        (entry) => entry.id === request.id,
      );
      this.#send(
        cachedIdentity && sameRequestIdentity(cachedIdentity, identity)
          ? cached
          : requestConflictResponse(request, cachedIdentity),
      );
      return;
    }
    const inFlight = this.#inFlightRequests.get(request.id);
    if (inFlight) {
      if (sameRequestIdentity(inFlight.identity, identity)) inFlight.waiters += 1;
      else this.#send(requestConflictResponse(request, inFlight.identity));
      return;
    }
    const recoveredMutation = this.#state.inFlightMutations.find(
      (entry) => entry.id === request.id,
    );
    if (recoveredMutation) {
      const recoveredIdentity =
        recoveredMutation.correlationId && recoveredMutation.paramsHash
          ? {
              id: recoveredMutation.id,
              correlationId: recoveredMutation.correlationId,
              method: recoveredMutation.method,
              paramsHash: recoveredMutation.paramsHash,
            }
          : undefined;
      if (
        (recoveredIdentity && !sameRequestIdentity(recoveredIdentity, identity)) ||
        (!recoveredIdentity && recoveredMutation.method !== request.method)
      ) {
        this.#send(requestConflictResponse(request, recoveredIdentity));
        return;
      }
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
      this.#cacheResponse(response, identity);
      try {
        this.#persist();
      } catch {
        // The older durable guard still prevents replay after a reload.
        this.#state.inFlightMutations.push(recoveredMutation);
      }
      this.#send(response);
      return;
    }
    const isMutation = MUTATION_METHODS.has(request.method);
    if (isMutation) {
      this.#state.inFlightMutations.push(identity);
      try {
        this.#persist();
      } catch {
        this.#state.inFlightMutations = this.#state.inFlightMutations.filter(
          (entry) => entry.id !== request.id,
        );
        this.#send({
          type: "response",
          id: request.id,
          ok: false,
          error: {
            code: "FOUNDRY_ERROR",
            message:
              "Companion storage could not record the mutation guard; no mutation was dispatched",
            retryable: false,
            details: { notDispatched: true },
          },
        });
        return;
      }
    }
    const now = Date.now();
    const deadline = Math.min(
      request.control?.deadline ?? now + MAX_OPERATION_DURATION_MS,
      now + MAX_OPERATION_DURATION_MS,
    );
    const state: InFlightRequest = {
      controller: new AbortController(),
      identity,
      correlationId: request.control?.correlationId ?? request.id.slice(0, 128),
      deadline,
      promise: Promise.resolve({ type: "response", id: request.id, ok: true, value: null }),
      committed: false,
      dispatched: false,
      finished: false,
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
      this.#cacheResponse(response, identity);
      let delivered = response;
      try {
        this.#persist();
      } catch {
        // Read responses need not be durable. A dispatched mutation must retain
        // its older durable guard and cannot be reported as safely replayable.
        if (isMutation) {
          this.#state.inFlightMutations.push(identity);
          delivered = {
            type: "response",
            id: request.id,
            ok: false,
            error: {
              code: "INDETERMINATE_MUTATION",
              message:
                "Mutation completion could not be persisted; reconcile state before retrying",
              retryable: false,
              details: { indeterminate: true, reconciliationRequired: true },
            },
          };
          this.#cacheResponse(delivered, identity);
        }
      }
      for (let index = 0; index < state.waiters; index += 1) this.#send(delivered);
    });
  }

  #cacheResponse(response: CompanionResponseMessage, identity: RequestIdentity): void {
    this.#state.responses = [
      ...this.#state.responses.filter((entry) => entry.id !== response.id),
      response,
    ];
    const retainedIds = new Set(this.#state.responses.map((entry) => entry.id));
    this.#state.responseIdentities = [
      ...this.#state.responseIdentities.filter((entry) => entry.id !== identity.id),
      identity,
    ].filter((entry) => retainedIds.has(entry.id));
  }

  async #executeRequest(
    request: ReturnType<typeof CompanionRequestMessageSchema.parse>,
    state: InFlightRequest,
    isMutation: boolean,
  ): Promise<CompanionResponseMessage> {
    let response: CompanionResponseMessage;
    let removeAbortListener = (): void => undefined;
    const reportProgress = async (progress: OperationProgress): Promise<void> => {
      if (
        state.finished ||
        !request.control?.progress ||
        state.progressUpdates >= MAX_OPERATION_PROGRESS_UPDATES
      )
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
      state.controller.signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new Error("Operation execution was aborted"));
        state.controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => state.controller.signal.removeEventListener("abort", onAbort);
      });
      state.dispatched = true;
      const execution = this.options.handleRequest(request.method, request.params, {
        signal: state.controller.signal,
        deadline: state.deadline,
        correlationId: state.correlationId,
        reportProgress,
        markCommitted: (details) => {
          state.committed = true;
          state.committedDetails = details;
        },
      });
      const value = await Promise.race([execution, cancelled]);
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
        const indeterminateMutation = isMutation && state.dispatched;
        const envelope = indeterminateMutation
          ? makeError(
              "INDETERMINATE_MUTATION",
              state.committed
                ? `Mutation ${request.method} committed before cancellation; reconcile state before retrying`
                : `Mutation ${request.method} may have continued after cancellation; reconcile state before retrying`,
              false,
              {
                committed: state.committed,
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
        response = {
          type: "response",
          id: request.id,
          ok: false,
          error: JSON.parse(JSON.stringify(envelope)) as JsonValue,
        };
      } else {
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
    } finally {
      state.finished = true;
      removeAbortListener();
    }
    return response;
  }

  #send(
    message: EventPublishMessage | CompanionResponseMessage | CompanionRequestProgressMessage,
  ): void {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(message));
  }

  #persist(): void {
    const reads = this.#cachedReadResponses().map((response) => ({
      id: response.id,
      bytes: new TextEncoder().encode(JSON.stringify(response)).length,
    }));
    let readBytes = reads.reduce((total, response) => total + response.bytes, 0);
    while (
      reads.length > 0 &&
      (readBytes > MAX_CACHED_READ_RESPONSE_BYTES ||
        this.#state.responses.length > this.#maxCachedResponses)
    ) {
      const oldest = reads.shift();
      if (!oldest) break;
      this.#removeCachedReadResponse(oldest.id);
      readBytes -= oldest.bytes;
    }
    for (;;) {
      try {
        this.options.storage.setItem(this.#storageKey, JSON.stringify(this.#state));
        return;
      } catch (error) {
        const oldest = this.#cachedReadResponses()[0];
        if ((error as { name?: unknown } | null)?.name !== "QuotaExceededError" || !oldest) {
          throw error;
        }
        this.#removeCachedReadResponse(oldest.id);
      }
    }
  }

  #cachedReadResponses(): CompanionResponseMessage[] {
    const readIds = new Set(
      this.#state.responseIdentities
        .filter((identity) => READ_METHODS.has(identity.method))
        .map((identity) => identity.id),
    );
    // Missing/unknown identities may be legacy mutation receipts. Never evict
    // them, mutation responses, or in-flight guards to make room for reads.
    return this.#state.responses.filter((response) => readIds.has(response.id));
  }

  #removeCachedReadResponse(id: string): void {
    this.#state.responses = this.#state.responses.filter((response) => response.id !== id);
    this.#state.responseIdentities = this.#state.responseIdentities.filter(
      (identity) => identity.id !== id,
    );
  }
}

export { validateEndpoint as validateCompanionEndpoint };
