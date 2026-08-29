import { describe, expect, it } from "vitest";

import {
  DocumentsCreateInput,
  DocumentsListInput,
  DocumentsSnapshotInput,
  DocumentsUpdateInput,
  MAX_PAGE_SIZE,
} from "../src/document.js";

describe("generic document protocol schemas", () => {
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
});
