import fs from "node:fs";
import path from "node:path";
import {
  FOUNDRY_USER_ROLES,
  REQUESTED_CAPABILITIES,
  evaluatePolicy,
  openDatabase,
  runMigrations,
  setCapabilityGrant,
  type EnvSource,
  type FoundryUserRole,
  type RequestedCapability,
} from "@foundry-mcp/host";
import type { CapabilityCommandOptions } from "./command-line.js";
import { resolveHostLaunch } from "./host-command.js";

export const MUTATION_CAPABILITIES = REQUESTED_CAPABILITIES.filter(
  (capability): capability is Exclude<RequestedCapability, "read"> => capability !== "read",
);

export interface CapabilityGrantView {
  role: FoundryUserRole;
  capability: Exclude<RequestedCapability, "read">;
  allowed: boolean;
  updatedAt: string;
}

export interface CapabilityCommandResult {
  action: "list" | "grant" | "revoke";
  connectionId: string;
  supportedCapabilities: readonly Exclude<RequestedCapability, "read">[];
  grants: CapabilityGrantView[];
  changed?: CapabilityGrantView;
}

function validateConnectionId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/iu.test(value)) {
    throw new Error(
      "--connection-id must be 1-256 letters, digits, dots, underscores, colons, or hyphens",
    );
  }
  return value;
}

function validateRole(value: string | undefined): FoundryUserRole {
  const normalized = value?.toUpperCase();
  if (!normalized || !FOUNDRY_USER_ROLES.includes(normalized as FoundryUserRole)) {
    throw new Error(`--role must be one of ${FOUNDRY_USER_ROLES.join(", ")}`);
  }
  return normalized as FoundryUserRole;
}

function validateCapability(value: string | undefined): Exclude<RequestedCapability, "read"> {
  if (!value || !MUTATION_CAPABILITIES.includes(value as Exclude<RequestedCapability, "read">)) {
    throw new Error(`--capability must be one of ${MUTATION_CAPABILITIES.join(", ")}`);
  }
  return value as Exclude<RequestedCapability, "read">;
}

function listGrants(
  rows: Array<{
    foundry_user_role: string;
    capability: string;
    allowed: number;
    updated_at: string;
  }>,
): CapabilityGrantView[] {
  return rows.flatMap((row) => {
    if (
      !FOUNDRY_USER_ROLES.includes(row.foundry_user_role as FoundryUserRole) ||
      !MUTATION_CAPABILITIES.includes(row.capability as Exclude<RequestedCapability, "read">)
    ) {
      return [];
    }
    return [
      {
        role: row.foundry_user_role as FoundryUserRole,
        capability: row.capability as Exclude<RequestedCapability, "read">,
        allowed: row.allowed === 1,
        updatedAt: row.updated_at,
      },
    ];
  });
}

export function runCapabilityCommand(
  options: CapabilityCommandOptions,
  env: EnvSource = process.env,
  now: Date = new Date(),
): CapabilityCommandResult {
  const connectionId = validateConnectionId(options.connectionId);
  const launch = resolveHostLaunch(
    {
      allowedOrigins: [],
      ...(options.appDataDir ? { appDataDir: options.appDataDir } : {}),
      ...(options.configPath ? { configPath: options.configPath } : {}),
    },
    env,
  );
  const databasePath = path.isAbsolute(launch.config.dbPath)
    ? launch.config.dbPath
    : path.join(launch.appDataDir, launch.config.dbPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = openDatabase(databasePath);
  try {
    runMigrations(db);
    let changed: CapabilityGrantView | undefined;
    if (options.action !== "list") {
      const role = validateRole(options.role);
      const capability = validateCapability(options.capability);
      const request = { connectionId, foundryUserRole: role, requestedCapability: capability };
      if (options.action === "grant") {
        const decision = evaluatePolicy(db, request);
        if (!decision.allowed && decision.reason === "role-restricted") {
          throw new Error(`capability ${capability} is not supported for role ${role}`);
        }
      }
      const allowed = options.action === "grant";
      setCapabilityGrant(db, request, allowed, now);
      changed = { role, capability, allowed, updatedAt: now.toISOString() };
    }
    const rows = db
      .prepare(
        `SELECT foundry_user_role, capability, allowed, updated_at
         FROM capability_grants
         WHERE connection_id = ?
         ORDER BY foundry_user_role, capability`,
      )
      .all(connectionId) as Array<{
      foundry_user_role: string;
      capability: string;
      allowed: number;
      updated_at: string;
    }>;
    return {
      action: options.action,
      connectionId,
      supportedCapabilities: MUTATION_CAPABILITIES,
      grants: listGrants(rows),
      ...(changed ? { changed } : {}),
    };
  } finally {
    db.close();
  }
}

export function formatCapabilityCommandText(result: CapabilityCommandResult): string {
  if (result.changed) {
    return `${result.action === "grant" ? "Granted" : "Revoked"} ${result.changed.capability} for ${result.connectionId} as ${result.changed.role}`;
  }
  const rows = result.grants.map(
    (grant) =>
      `${grant.role}\t${grant.capability}\t${grant.allowed ? "granted" : "revoked"}\t${grant.updatedAt}`,
  );
  return [
    `Connection: ${result.connectionId}`,
    `Supported mutation capabilities: ${result.supportedCapabilities.join(", ")}`,
    ...(rows.length > 0 ? rows : ["No explicit mutation capability grants."]),
  ].join("\n");
}
