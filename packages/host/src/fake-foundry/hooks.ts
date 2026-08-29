export type HookCallback = (...args: unknown[]) => void;

/** Mirrors Foundry's global `Hooks.on` / `Hooks.callAll`. */
export class FakeHooks {
  private listeners = new Map<string, HookCallback[]>();

  on(event: string, callback: HookCallback): void {
    const existing = this.listeners.get(event) ?? [];
    existing.push(callback);
    this.listeners.set(event, existing);
  }

  off(event: string, callback: HookCallback): void {
    const existing = this.listeners.get(event);
    if (!existing) {
      return;
    }
    this.listeners.set(
      event,
      existing.filter((cb) => cb !== callback),
    );
  }

  callAll(event: string, ...args: unknown[]): void {
    const existing = this.listeners.get(event) ?? [];
    for (const callback of existing) {
      callback(...args);
    }
  }
}
