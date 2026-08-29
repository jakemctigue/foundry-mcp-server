import { afterEach, describe, expect, it, vi } from "vitest";

describe("MOCKED FOUNDRY v14 module entry settings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("stores the pairing value client-side and renders it as a password input", async () => {
    const callbacks = new Map<string, () => void>();
    const register = vi.fn();
    class MockStringField {
      constructor(readonly options: unknown) {}
    }
    vi.stubGlobal("Hooks", {
      once: (event: string, callback: () => void) => callbacks.set(event, callback),
    });
    vi.stubGlobal("game", { settings: { register } });
    vi.stubGlobal("foundry", { data: { fields: { StringField: MockStringField } } });
    vi.stubGlobal("document", {
      createElement: () => ({
        attributes: new Map<string, string>(),
        setAttribute(name: string, value: string) {
          this.attributes.set(name, value);
        },
      }),
    });

    await import("../src/module-entry.js");
    callbacks.get("init")?.();

    expect(register).toHaveBeenCalledTimes(2);
    const pairing = register.mock.calls.find((call) => call[1] === "pairingSecret")?.[2] as {
      scope: string;
      config: boolean;
      type: unknown;
      input(field: unknown, config: unknown): Record<string, unknown>;
    };
    expect(pairing).toMatchObject({ scope: "client", config: true });
    expect(pairing.type).toBeInstanceOf(MockStringField);
    const input = pairing.input({}, { name: "foundry-mcp.pairingSecret", value: "LOCAL-ONLY" });
    expect(input).toMatchObject({
      type: "password",
      name: "foundry-mcp.pairingSecret",
      value: "LOCAL-ONLY",
    });
    expect(input.attributes).toEqual(
      new Map([
        ["autocomplete", "new-password"],
        ["spellcheck", "false"],
        ["aria-label", "Foundry MCP pairing secret"],
      ]),
    );
  });
});
