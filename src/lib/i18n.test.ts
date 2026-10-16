import { describe, expect, it } from "bun:test";
import { t, useT } from "./i18n.ts";

describe("t", () => {
  it("gives the English string back, with its placeholders filled", () => {
    expect(t("Settings")).toBe("Settings");
    expect(t("Worked for {duration}", { duration: "7s" })).toBe("Worked for 7s");
    expect(t("{a} and {b}", { a: 1 })).toBe("1 and {b}");
    expect(t("A {brace", {})).toBe("A {brace");
  });
});

describe("useT", () => {
  it("is t itself, so memoized work keeps its identity", () => {
    expect(useT()).toBe(t);
  });
});
