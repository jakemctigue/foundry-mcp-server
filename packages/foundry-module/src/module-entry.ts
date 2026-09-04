import {
  BrowserFoundryAssetRuntime,
  parseAssetSourceCapabilitiesSetting,
  type BrowserFoundryAssetSourceCapabilities,
} from "./asset-runtime.js";
import { FoundryAssetService } from "./assets.js";
import type {
  ActiveFoundryModule,
  FoundryModuleCapability,
  FoundryUserRole,
  JsonValue,
} from "@foundry-mcp/protocol";

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
const ASSET_SOURCE_CAPABILITIES_SETTING = "assetSourceCapabilities";
const MODULE_CAPABILITIES = [
  "documents.read",
  "documents.write",
  "assets.read",
  "assets.write",
  "sessions.read",
  "sessions.write",
  "events.publish",
] as const satisfies readonly FoundryModuleCapability[];
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

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

function activeModuleVersions(value: unknown): ActiveFoundryModule[] {
  const collection = record(value);
  const values = collection.values;
  let modules: unknown[];
  if (typeof values === "function") {
    try {
      modules = Array.from(values.call(value) as Iterable<unknown>);
    } catch {
      modules = [];
    }
  } else {
    modules = Object.values(collection);
  }
  return modules
    .map(record)
    .filter((module) => module.active === true)
    .flatMap((module) => {
      const id = stringValue(module.id, "");
      if (!SAFE_IDENTIFIER.test(id) || id.length > 256) return [];
      const version = stringValue(module.version, "");
      return [
        {
          id,
          ...(version.length > 0 && version.length <= 100 ? { version } : {}),
        },
      ];
    })
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 256);
}

function currentUserIsGameMaster(): boolean {
  return record(record(record(globalThis).game).user).isGM === true;
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
  const visibleToCurrentUser = currentUserIsGameMaster();
  register.call(settings, MODULE_ID, ENDPOINT_SETTING, {
    name: "Foundry MCP bridge endpoint",
    hint: "Exact ws:// or wss:// endpoint shown by the Foundry MCP host. HTTPS Foundry requires wss://.",
    scope: "world",
    config: visibleToCurrentUser,
    type: String,
    default: "",
  });
  register.call(settings, MODULE_ID, PAIRING_SECRET_SETTING, {
    name: "Foundry MCP pairing secret",
    hint: "Paste the one-time Base32 value shown by the local pairing command. It is stored only in this browser and displayed as a password.",
    scope: "client",
    config: visibleToCurrentUser,
    requiresReload: true,
    type: pairingSecretField(),
    input: passwordSettingInput,
    default: "",
  });
  register.call(settings, MODULE_ID, ASSET_SOURCE_CAPABILITIES_SETTING, {
    name: "Foundry MCP non-core asset sources",
    hint: "Strict JSON keyed by FilePicker source ID. Configure writable, optional bucket, writablePathPrefixes, and reason only. Never place credentials, tokens, keys, or endpoint URLs here.",
    scope: "world",
    config: visibleToCurrentUser,
    requiresReload: true,
    type: String,
    default: "{}",
  });
}

function updateSettingsVisibility(): void {
  const settings = record(record(record(globalThis).game).settings);
  const definitions = record(settings.settings);
  const get = definitions.get;
  if (typeof get !== "function") return;
  const visible = currentUserIsGameMaster();
  for (const key of [ENDPOINT_SETTING, PAIRING_SECRET_SETTING, ASSET_SOURCE_CAPABILITIES_SETTING]) {
    const definition = get.call(definitions, `${MODULE_ID}.${key}`);
    if (definition && typeof definition === "object") record(definition).config = visible;
  }
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

export function configuredAssetSourceCapabilities(): BrowserFoundryAssetSourceCapabilities {
  const settings = record(record(record(globalThis).game).settings);
  const get = settings.get;
  const raw =
    typeof get === "function"
      ? get.call(settings, MODULE_ID, ASSET_SOURCE_CAPABILITIES_SETTING)
      : "{}";
  const parsed = parseAssetSourceCapabilitiesSetting(raw);
  if (parsed.ok) return parsed.value;
  notify(
    "error",
    `Foundry MCP ignored the non-core asset-source setting; all non-core sources remain read-only: ${parsed.error}`,
  );
  return {};
}

async function startCompanion(): Promise<void> {
  const globals = globalThis as unknown as UnknownRecord;
  const game = record(globals.game);
  const world = record(game.world);
  const user = record(game.user);
  if (user.isGM !== true) {
    notify("warn", "Foundry MCP only starts for an authenticated Game Master.");
    return;
  }
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
    new BrowserFoundryAssetRuntime({
      global: globals,
      sourceCapabilities: configuredAssetSourceCapabilities(),
    }),
    documents,
    runtime,
  );
  const sessions = new FoundrySessionService(documents);
  const handlers = new FoundryCompanionHandlers({ documents, assets, sessions });
  const worldId = stringValue(world.id, "unknown-world");
  const userId = stringValue(user.id, "unknown-user");
  const userRole = connectedUserRole(user);
  const system = record(game.system);
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
    foundryUserRole: userRole,
    currentUser: {
      id: userId,
      name: stringValue(user.name, userId),
      role: userRole,
    },
    system: {
      id: stringValue(system.id, "unknown-system"),
      version: stringValue(system.version, "unknown"),
    },
    activeModules: activeModuleVersions(game.modules),
    moduleCapabilities: [...MODULE_CAPABILITIES],
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
    // game.user is not resolved at init; refresh only visibility, not stored values.
    updateSettingsVisibility();
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
