import { describe, expect, it } from "vitest";

import {
  DocumentSourceHash,
  CompendiumDocumentsListOutput,
  CompendiumsListOutput,
  DocumentsCreateInput,
  DocumentsListInput,
  DocumentsSnapshotInput,
  DocumentsUpdateInput,
  MAX_PAGE_SIZE,
} from "../src/document.js";

describe("generic document protocol schemas", () => {
  it("identifies the current versioned SHA-256 document source hash", () => {
    expect(
      DocumentSourceHash.safeParse(
        "fmcp-v2-44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      ).success,
    ).toBe(true);
    expect(DocumentSourceHash.safeParse("fmcp-v1-deadbeef").success).toBe(false);
  });

  it("enforces bounded list pages and supplies deterministic defaults", () => {
    const parsed = DocumentsListInput.parse({ type: "Actor" });
    expect(parsed.pageSize).toBe(50);
    expect(parsed.sort).toEqual({ field: "id", direction: "asc" });
    expect(
      DocumentsListInput.safeParse({ type: "Actor", pageSize: MAX_PAGE_SIZE + 1 }).success,
    ).toBe(false);
  });

  it("accepts a single create or a bounded explicit batch", () => {
    expect(DocumentsCreateInput.safeParse({ type: "Actor", data: { name: "One" } }).success).toBe(
      true,
    );
    expect(
      DocumentsCreateInput.safeParse({
        items: [
          { type: "Actor", data: { name: "One" } },
          { type: "Item", data: { name: "Two" }, parentUuid: "Actor.a" },
        ],
        atomic: true,
      }).success,
    ).toBe(true);
  });

  it("accepts explicit compendium create targets and rejects ambiguous targets", () => {
    const single = DocumentsCreateInput.parse({
      type: "Actor",
      packId: "world.actors",
      data: { name: "Packed Actor", type: "system-actor" },
      dryRun: true,
    });
    expect(single).toMatchObject({ packId: "world.actors", dryRun: true });
    expect(
      DocumentsCreateInput.safeParse({
        type: "Item",
        parentUuid: "Actor.a",
        packId: "world.items",
        data: { name: "Ambiguous" },
      }).success,
    ).toBe(false);
    expect(
      DocumentsCreateInput.safeParse({
        items: [
          {
            type: "Item",
            parentUuid: "Actor.a",
            packId: "world.items",
            data: { name: "Ambiguous" },
          },
        ],
        dryRun: true,
      }).success,
    ).toBe(false);
  });

  it("requires an optimistic precondition unless overwrite is explicitly forced", () => {
    expect(
      DocumentsUpdateInput.safeParse({ uuid: "Actor.a", data: { name: "Changed" } }).success,
    ).toBe(false);
    expect(
      DocumentsUpdateInput.safeParse({
        uuid: "Actor.a",
        data: { name: "Changed" },
        expectedHash: "hash",
      }).success,
    ).toBe(true);
    expect(
      DocumentsUpdateInput.safeParse({
        uuid: "Actor.a",
        data: { name: "Changed" },
        forceOverwrite: true,
      }).success,
    ).toBe(true);
    expect(
      DocumentsUpdateInput.safeParse({
        uuid: "Actor.a",
        data: { name: "Changed" },
        dryRun: true,
      }).success,
    ).toBe(false);
    expect(
      DocumentsUpdateInput.parse({
        uuid: "Actor.a",
        data: { name: "Changed" },
        expectedHash: "hash",
        dryRun: true,
      }).dryRun,
    ).toBe(true);
  });

  it("decodes pre-writable-capability compendium summaries as fail-closed", () => {
    const output = CompendiumsListOutput.parse({
      packs: [
        {
          id: "world.actors",
          label: "Actors",
          type: "Actor",
          documentCount: 1,
          locked: false,
        },
      ],
    });
    expect(output.packs[0]?.writable).toBe(false);
  });

  it("bounds snapshot depth, bytes, and items", () => {
    const parsed = DocumentsSnapshotInput.parse({ uuids: ["Actor.a"] });
    expect(parsed.maxDepth).toBeGreaterThan(0);
    expect(parsed.maxBytes).toBeGreaterThan(0);
    expect(parsed.maxItems).toBeGreaterThan(0);
    expect(
      DocumentsSnapshotInput.safeParse({
        uuids: ["Actor.a"],
        maxDepth: 999,
        maxBytes: 1024,
        maxItems: 10,
      }).success,
    ).toBe(false);
  });

  it("preserves hydrated compendium document fields instead of narrowing them to index entries", () => {
    const output = CompendiumDocumentsListOutput.parse({
      packId: "world.bestiary",
      hydrated: true,
      items: [
        {
          id: "a",
          uuid: "Compendium.world.bestiary.Actor.a",
          type: "Actor",
          name: "Wyrm",
          sourceHash: "hash-a",
          sourceVersion: 1,
          data: { name: "Wyrm" },
          ownershipSummary: { default: 1 },
          schemaVersion: "14",
        },
      ],
    });
    expect(output.items[0]).toMatchObject({
      data: { name: "Wyrm" },
      ownershipSummary: { default: 1 },
      schemaVersion: "14",
    });
  });
});
