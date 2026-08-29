import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDatabase, runMigrations } from "../src/db/index.js";
import {
  PermissionDeniedError,
  evaluatePolicy,
  runAuthorizedOperation,
  setCapabilityGrant,
  type PolicyRequest,
} from "../src/security/policy.js";
import { isSecretField, redactSecretText, redactSecrets } from "../src/security/redaction.js";

function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    connectionId: "connection-1",
    foundryUserRole: "GAMEMASTER",
    requestedCapability: "documents:update",
    ...overrides,
  };
}

describe("permission policy and mutation audit", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it("is read-only by default and applies role ceilings plus explicit grants", () => {
    const playerRead = request({ foundryUserRole: "PLAYER", requestedCapability: "read" });
    expect(evaluatePolicy(db, playerRead)).toMatchObject({
      allowed: true,
      source: "read-default",
    });

    const playerCreate = request({
      foundryUserRole: "PLAYER",
      requestedCapability: "documents:create",
    });
    setCapabilityGrant(db, playerCreate, true);
    expect(evaluatePolicy(db, playerCreate)).toMatchObject({
      allowed: false,
      reason: "role-restricted",
    });

    const trustedAppend = request({
      foundryUserRole: "TRUSTED",
      requestedCapability: "sessions:append",
    });
    expect(evaluatePolicy(db, trustedAppend)).toMatchObject({
      allowed: false,
      reason: "missing-grant",
    });
    setCapabilityGrant(db, trustedAppend, true, new Date("2026-01-01T00:00:00.000Z"));
    expect(evaluatePolicy(db, trustedAppend)).toMatchObject({
      allowed: true,
      source: "explicit-grant",
    });

    const assistantCreate = request({
      foundryUserRole: "ASSISTANT",
      requestedCapability: "documents:create",
    });
    setCapabilityGrant(db, assistantCreate, true);
    expect(evaluatePolicy(db, assistantCreate).allowed).toBe(true);
    const assistantNetwork = request({
      foundryUserRole: "ASSISTANT",
      requestedCapability: "ai:network",
    });
    setCapabilityGrant(db, assistantNetwork, true);
    expect(evaluatePolicy(db, assistantNetwork)).toMatchObject({
      allowed: false,
      reason: "role-restricted",
    });

    const gmNetwork = request({ requestedCapability: "ai:network" });
    expect(evaluatePolicy(db, gmNetwork).allowed).toBe(false);
    setCapabilityGrant(db, gmNetwork, true);
    expect(evaluatePolicy(db, gmNetwork).allowed).toBe(true);
    setCapabilityGrant(db, gmNetwork, false);
    expect(evaluatePolicy(db, gmNetwork)).toMatchObject({
      allowed: false,
      reason: "missing-grant",
    });
  });

  it("returns structured permission errors and audits denied and successful calls exactly once", async () => {
    const operation = vi.fn(() => "changed");
    const mutation = request({
      foundryUserRole: "ASSISTANT",
      requestedCapability: "documents:update",
    });

    let denial: unknown;
    try {
      await runAuthorizedOperation(
        db,
        {
          ...mutation,
          tool: "foundry.documents.update",
          correlationId: "denied-1",
          auditDetails: {
            uuid: "Actor.1",
            apiKey: "do-not-log",
            nested: { pairingSecret: "also-secret" },
          },
        },
        operation,
      );
    } catch (error) {
      denial = error;
    }
    expect(operation).not.toHaveBeenCalled();
    expect(denial).toBeInstanceOf(PermissionDeniedError);
    expect((denial as PermissionDeniedError).toJSON()).toMatchObject({
      code: "PERMISSION_DENIED",
      missingCapability: "documents:update",
      connectionId: "connection-1",
    });

    setCapabilityGrant(db, mutation, true);
    await expect(
      runAuthorizedOperation(
        db,
        {
          ...mutation,
          tool: "foundry.documents.update",
          correlationId: "success-1",
          auditDetails: { uuid: "Actor.1", authorization: "Bearer raw-value" },
          now: () => new Date("2026-02-01T00:00:00.000Z"),
        },
        operation,
      ),
    ).resolves.toBe("changed");
    expect(operation).toHaveBeenCalledOnce();

    const auditRows = db
      .prepare(
        `SELECT timestamp, connection_id, tool, outcome, correlation_id, details_json
         FROM audit_log ORDER BY id ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row["outcome"])).toEqual(["denied", "success"]);
    expect(auditRows.map((row) => row["correlation_id"])).toEqual(["denied-1", "success-1"]);
    expect(JSON.stringify(auditRows)).not.toContain("do-not-log");
    expect(JSON.stringify(auditRows)).not.toContain("also-secret");
    expect(JSON.stringify(auditRows)).not.toContain("raw-value");
  });

  it("audits an operation error exactly once and redacts its message", async () => {
    const mutation = request({ requestedCapability: "assets:upload" });
    setCapabilityGrant(db, mutation, true);
    await expect(
      runAuthorizedOperation(
        db,
        {
          ...mutation,
          tool: "foundry.assets.upload",
          correlationId: "error-1",
          auditDetails: { password: "request-secret" },
        },
        () => {
          throw new Error("Bearer provider-secret failed");
        },
      ),
    ).rejects.toThrow("provider-secret");

    const rows = db
      .prepare("SELECT outcome, details_json FROM audit_log WHERE correlation_id = ?")
      .all("error-1") as Array<{ outcome: string; details_json: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
    expect(rows[0]?.details_json).not.toContain("request-secret");
    expect(rows[0]?.details_json).not.toContain("provider-secret");
  });

  it("requires every capability in a compound mutation and still audits exactly once", async () => {
    const attach = request({ requestedCapability: "assets:attach" });
    const upload = request({ requestedCapability: "assets:upload" });
    setCapabilityGrant(db, attach, true);
    const operation = vi.fn(() => "attached");
    await expect(
      runAuthorizedOperation(
        db,
        {
          ...attach,
          additionalCapabilities: ["assets:upload"],
          tool: "foundry.assets.images.attach",
          correlationId: "compound-denied",
        },
        operation,
      ),
    ).rejects.toMatchObject({ missingCapability: "assets:upload" });
    expect(operation).not.toHaveBeenCalled();
    expect(
      db.prepare("SELECT outcome FROM audit_log WHERE correlation_id = ?").all("compound-denied"),
    ).toEqual([{ outcome: "denied" }]);

    setCapabilityGrant(db, upload, true);
    await expect(
      runAuthorizedOperation(
        db,
        {
          ...attach,
          additionalCapabilities: ["assets:upload"],
          tool: "foundry.assets.images.attach",
          correlationId: "compound-success",
        },
        operation,
      ),
    ).resolves.toBe("attached");
    expect(operation).toHaveBeenCalledOnce();
    expect(
      db.prepare("SELECT outcome FROM audit_log WHERE correlation_id = ?").all("compound-success"),
    ).toEqual([{ outcome: "success" }]);
  });

  it("returns a committed side effect when the subsequent success audit degrades", async () => {
    const mutation = request({ requestedCapability: "assets:upload" });
    setCapabilityGrant(db, mutation, true);
    db.exec(`
      CREATE TRIGGER fail_success_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.outcome = 'success'
      BEGIN
        SELECT RAISE(FAIL, 'simulated audit storage failure');
      END;
    `);
    const operation = vi.fn(() => ({ committed: true }));
    const onAuditFailure = vi.fn();
    await expect(
      runAuthorizedOperation(
        db,
        {
          ...mutation,
          tool: "foundry.assets.images.upload",
          correlationId: "committed-audit-degraded",
          onAuditFailure,
        },
        operation,
      ),
    ).resolves.toEqual({ committed: true });
    expect(operation).toHaveBeenCalledOnce();
    expect(onAuditFailure).toHaveBeenCalledWith(expect.any(Error), true);
    expect(
      db
        .prepare("SELECT count(*) AS count FROM audit_log WHERE correlation_id = ?")
        .get("committed-audit-degraded"),
    ).toEqual({ count: 0 });
  });

  it("fails closed for runtime-unknown roles and capabilities", () => {
    expect(
      evaluatePolicy(db, request({ foundryUserRole: "OWNER" as PolicyRequest["foundryUserRole"] })),
    ).toMatchObject({ allowed: false, reason: "unknown-role" });
    expect(
      evaluatePolicy(
        db,
        request({ requestedCapability: "shell:execute" as PolicyRequest["requestedCapability"] }),
      ),
    ).toMatchObject({ allowed: false, reason: "unknown-capability" });
  });

  it("audits and fails closed when policy storage cannot be read", async () => {
    db.exec("DROP TABLE capability_grants");
    const operation = vi.fn();
    await expect(
      runAuthorizedOperation(
        db,
        {
          ...request(),
          tool: "foundry.documents.update",
          correlationId: "policy-error-1",
        },
        operation,
      ),
    ).rejects.toThrow("no such table");
    expect(operation).not.toHaveBeenCalled();
    expect(
      db.prepare("SELECT outcome FROM audit_log WHERE correlation_id = ?").get("policy-error-1"),
    ).toEqual({ outcome: "error" });
  });
});

describe("secret redaction", () => {
  it("redacts nested fields, inline credentials, cycles, and oversized collections", () => {
    const cyclic: Record<string, unknown> = {
      tokenCount: 3,
      access_token: "hidden",
      note: "password=hunter2 and sk-abcdefghijk",
      values: [1, 2, 3],
    };
    cyclic["self"] = cyclic;
    const redacted = redactSecrets(cyclic);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("hidden");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("abcdefghijk");
    expect(serialized).toContain("[REDACTED]");
    expect(isSecretField("tokenCount")).toBe(false);
    expect(isSecretField("client_password")).toBe(true);
    expect(redactSecretText("Authorization Bearer abc123")).not.toContain("abc123");
    expect(serialized).toContain("[CIRCULAR]");

    expect(redactSecrets({ values: [1, 2, 3] }, { maxCollectionItems: 2 })).toEqual({
      values: [1, 2, "[TRUNCATED]"],
    });
    expect(redactSecrets({ nested: { value: "deep" } }, { maxDepth: 1 })).toEqual({
      nested: "[TRUNCATED]",
    });
    expect(
      redactSecrets({ date: new Date("2026-01-01T00:00:00.000Z"), big: 10n, missing: undefined }),
    ).toEqual({ date: "2026-01-01T00:00:00.000Z", big: "10", missing: null });
  });
});
