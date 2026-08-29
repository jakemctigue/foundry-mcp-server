import { BrowserFoundryAssetRuntime } from "./asset-runtime.js";
import { FoundryAssetService } from "./assets.js";
import type { FoundryUserRole, JsonValue } from "@foundry-mcp/protocol";

import {
  CompanionBridgeClient,
  type CompanionSocket,
  type CompanionStorage,
} from "./companion-client.js";
import { FoundryCompanionHandlers } from "./companion-handlers.js";
import { FoundryDocumentService } from "./documents.js";
import { FoundryEventHooks, type FoundryHooksApi } from "./event-hooks.js";
import { createCompanionHello } from "./handshake.js";
import { BrowserFoundryRuntime } from "./runtime.js";
import { FoundrySessionService } from "./sessions.js";

const MODULE_ID = "foundry-mcp";
const ENDPOINT_SETTING = "bridgeEndpoint";
const PAIRING_SECRET_SETTING = "pairingSecret";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? (value as UnknownRecord)
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function connectedUserRole(user: UnknownRecord): FoundryUserRole {
  if (user.isGM === true) return "GAMEMASTER";
  const role = typeof user.role === "number" ? user.role : 1;
  if (role >= 3) return "ASSISTANT";
  if (role >= 2) return "TRUSTED";
  return "PLAYER";
}

function notify(level: "error" | "warn", message: string): void {
  const notifications = record(record(record(globalThis).ui).notifications);
  const handler = notifications[level];
  if (typeof handler === "function") handler.call(notifications, message);
}

function pairingSecretField(): unknown {
  const globals = record(globalThis);
  const StringField = record(record(record(globals.foundry).data).fields).StringField;
  return typeof StringField === "function"
    ? Reflect.construct(StringField, [{ blank: true, nullable: false }])
    : String;
}

function passwordSettingInput(_field: unknown, config: unknown): unknown {
  const documentValue = record(record(globalThis).document);
  const createElement = documentValue.createElement;
  if (typeof createElement !== "function") {
    throw new Error("Foundry MCP cannot render its local pairing-secret input");
  }
  const input = record(createElement.call(documentValue, "input"));
  input.type = "password";
  input.name = stringValue(record(config).name, `${MODULE_ID}.${PAIRING_SECRET_SETTING}`);
  input.value = typeof record(config).value === "string" ? record(config).value : "";
  const setAttribute = input.setAttribute;
  if (typeof setAttribute === "function") {
    setAttribute.call(input, "autocomplete", "new-password");
    setAttribute.call(input, "spellcheck", "false");
    setAttribute.call(input, "aria-label", "Foundry MCP pairing secret");
  }
  return input;
}

function registerSettings(): void {
  const settings = record(record(record(globalThis).game).settings);
  const register = settings.register;
  if (typeof register !== "function") return;
  register.call(settings, MODULE_ID, ENDPOINT_SETTING, {
    name: "Foundry MCP bridge endpoint",
    hint: "Exact ws:// or wss:// endpoint shown by the Foundry MCP host. HTTPS Foundry requires wss://.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  register.call(settings, MODULE_ID, PAIRING_SECRET_SETTING, {
    name: "Foundry MCP pairing secret",
    hint: "Paste the one-time Base32 value shown by the local pairing command. It is stored only in this browser and displayed as a password.",
    scope: "client",
    config: true,
    requiresReload: true,
    type: pairingSecretField(),
    input: passwordSettingInput,
    default: "",
  });
}

function configuredEndpoint(): string {
  const settings = record(record(record(globalThis).game).settings);
  const get = settings.get;
  return typeof get === "function"
    ? stringValue(get.call(settings, MODULE_ID, ENDPOINT_SETTING), "")
    : "";
}

function configuredPairingSecret(): string {
  const settings = record(record(record(globalThis).game).settings);
  const get = settings.get;
  return typeof get === "function"
    ? stringValue(get.call(settings, MODULE_ID, PAIRING_SECRET_SETTING), "")
    : "";
}

async function startCompanion(): Promise<void> {
  const globals = globalThis as unknown as UnknownRecord;
  const game = record(globals.game);
  const world = record(game.world);
  const user = record(game.user);
  const endpoint = configuredEndpoint();
  if (!endpoint) {
    notify("warn", "Foundry MCP is enabled but its exact bridge endpoint is not configured.");
    return;
  }
  const pairingSecret = configuredPairingSecret();
  if (!pairingSecret) {
    notify("warn", "Foundry MCP is enabled but this browser has not been paired with the host.");
    return;
  }

  const runtime = new BrowserFoundryRuntime(globals);
  const documents = new FoundryDocumentService(runtime);
  const assets = new FoundryAssetService(
    new BrowserFoundryAssetRuntime(globals),
    documents,
    runtime,
  );
  const sessions = new FoundrySessionService(documents);
  const handlers = new FoundryCompanionHandlers({ documents, assets, sessions });
  const worldId = stringValue(world.id, "unknown-world");
  const userId = stringValue(user.id, "unknown-user");
  const pageOrigin = stringValue(record(globals.location).origin, "");
  if (!pageOrigin) {
    throw new Error("Foundry MCP requires a browser page origin");
  }
  const storage = globals.localStorage as CompanionStorage;
  const Socket = globals.WebSocket as {
    new (url: string): CompanionSocket;
  };
  const hello = createCompanionHello({
    connectionId: `${worldId}:${userId}`,
    worldId,
    worldTitle: stringValue(world.title, worldId),
    foundryVersion: stringValue(record(game.release).version, "14"),
    foundryUserRole: connectedUserRole(user),
  });
  const client = new CompanionBridgeClient({
    endpoint,
    allowedOrigins: [pageOrigin],
    pageOrigin,
    connectionId: hello.connectionId,
    storage,
    createSocket: (url) => new Socket(url),
    handleRequest: async (method, params) =>
      JSON.parse(JSON.stringify(await handlers.handle(method, params))) as JsonValue,
    hello,
    pairingSecret,
  });
  const registrations = await runtime.listDocumentRegistrations();
  new FoundryEventHooks(globals.Hooks as FoundryHooksApi, {
    documentTypes: registrations.map((registration) => registration.type),
    worldId,
    publish: (event) => {
      client.publish(event);
    },
  });
  client.start();
}

const hooks = record(record(globalThis).Hooks);
const once = hooks.once;
if (typeof once === "function") {
  once.call(hooks, "init", registerSettings);
  once.call(hooks, "ready", () => {
    void startCompanion().catch((error: unknown) => {
      notify(
        "error",
        `Foundry MCP companion failed to start: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    });
  });
}
