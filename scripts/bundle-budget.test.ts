import { expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The entry chunk, Brotli-compressed: what a first visit downloads before the app can draw.
const ENTRY_BUDGET_BYTES = 320_000;
const assets = join(import.meta.dir, "..", "dist", "assets");

// `bun run check fast` builds before its unit tests (scripts/check.ts), so this reads that build.
// A bare `bun run test:unit` reads whatever dist/ holds; with no build there is nothing to measure.
test.skipIf(!existsSync(assets))("the entry chunk's Brotli sidecar is within the bundle budget", () => {
  const entries = readdirSync(assets).filter((name) => /^index-[\w-]+\.js\.br$/.test(name));
  expect(entries).toHaveLength(1);
  expect(statSync(join(assets, entries[0]!)).size).toBeLessThanOrEqual(ENTRY_BUDGET_BYTES);
});
