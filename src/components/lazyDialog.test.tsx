import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { onLazyChunkFailure } from "../lib/lazyChunk.ts";
import { drawNothingForLoadFailure, lazyDialog } from "./lazyDialog.tsx";

/** Lets a lazy import's promise chain run to its end: a few turns of the microtask queue, no timer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

function Greeting({ name }: { name: string }) {
  return <p>{name}</p>;
}

describe("lazyDialog", () => {
  it("draws nothing until its code arrives, then the dialog, and fetches the code once", async () => {
    let loads = 0;
    const Dialog = lazyDialog(async () => {
      loads += 1;
      return Greeting;
    });
    expect(renderToStaticMarkup(createElement(Dialog, { name: "Ada" }))).toBe("");
    await settle();
    expect(renderToStaticMarkup(createElement(Dialog, { name: "Ada" }))).toBe("<p>Ada</p>");
    expect(loads).toBe(1);
  });

  it("starts the fetch on preload without rendering, and tells a failed fetch instead of throwing it", async () => {
    let loads = 0;
    let told = 0;
    const stop = onLazyChunkFailure(() => {
      told += 1;
    });
    try {
      const Dialog = lazyDialog<{ name: string }>(async () => {
        loads += 1;
        throw new TypeError("Failed to fetch dynamically imported module");
      });
      Dialog.preload();
      Dialog.preload();
      await settle();
      expect(loads).toBe(1);
      expect(told).toBe(1);
      expect(renderToStaticMarkup(createElement(Dialog, { name: "Ada" }))).toBe("");
      expect(loads).toBe(1);
    } finally {
      stop();
    }
  });

  it("draws nothing for its own chunk's failure, and rethrows any other render error to the app's crash screen", () => {
    const failure = { error: new TypeError("Failed to fetch dynamically imported module") };
    expect(drawNothingForLoadFailure(failure.error, failure)).toBeNull();
    expect(() => drawNothingForLoadFailure(new Error("a row the dialog cannot draw"), failure)).toThrow("a row the dialog cannot draw");
    expect(() => drawNothingForLoadFailure(new Error("a render error"), null)).toThrow("a render error");
  });
});
