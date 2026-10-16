import { describe, expect, it } from "bun:test";
import type { HealthAuth } from "../../shared/protocol.ts";
import { keepIfSame, sameData } from "./sameData.ts";

const auth = (overrides: Partial<HealthAuth> = {}): HealthAuth => ({ required: true, authenticated: true, via: "token", ...overrides });

describe("sameData", () => {
  it("matches equal data that arrives as new objects, and not data that differs", () => {
    expect(sameData({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(sameData({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameData(null, undefined)).toBe(false);
  });
});

describe("keepIfSame (the auth answer's guard)", () => {
  it("keeps the previous auth object when a poll answers the same, so the app does not re-render", () => {
    const previous = auth();
    expect(keepIfSame<HealthAuth>(previous, auth())).toBe(previous);
  });

  it("takes the new auth object when any field the app reads changed", () => {
    const previous = auth();
    const signedOut = auth({ authenticated: false, reason: "token_required" });
    expect(keepIfSame<HealthAuth>(previous, signedOut)).toBe(signedOut);
    const otherRole = auth({ role: "watch" });
    expect(keepIfSame<HealthAuth>(previous, otherRole)).toBe(otherRole);
  });

  it("takes the first answer", () => {
    const first = auth();
    expect(keepIfSame<HealthAuth>(null, first)).toBe(first);
  });
});
