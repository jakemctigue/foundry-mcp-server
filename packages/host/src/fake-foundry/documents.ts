import crypto from "node:crypto";

export interface FakeDocument {
  uuid: string;
  type: string;
  data: Record<string, unknown>;
}

export class FakeDocumentStore {
  private documents = new Map<string, FakeDocument>();

  create(type: string, data: Record<string, unknown>): FakeDocument {
    const uuid = `${type}.${crypto.randomUUID()}`;
    const doc: FakeDocument = { uuid, type, data: { ...data } };
    this.documents.set(uuid, doc);
    return doc;
  }

  read(uuid: string): FakeDocument | undefined {
    const doc = this.documents.get(uuid);
    return doc ? { ...doc, data: { ...doc.data } } : undefined;
  }

  update(uuid: string, patch: Record<string, unknown>): FakeDocument | undefined {
    const doc = this.documents.get(uuid);
    if (!doc) {
      return undefined;
    }
    doc.data = { ...doc.data, ...patch };
    return { ...doc, data: { ...doc.data } };
  }

  list(type?: string): FakeDocument[] {
    const all = Array.from(this.documents.values());
    return (type ? all.filter((d) => d.type === type) : all).map((d) => ({
      ...d,
      data: { ...d.data },
    }));
  }

  /** Mirrors Foundry's global `fromUuid` resolver. */
  fromUuid(uuid: string): FakeDocument | undefined {
    return this.read(uuid);
  }
}
