import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrProfileState } from "./herdr-profile-state.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

const dirs: string[] = [];
afterEach(() => { mock.restore(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = mkdtempSync(join(tmpdir(), "herdr-profile-state-")); dirs.push(dir); return dir; }
it("restores target-bound approval and cached panes without copying catalog fields", () => {
  const dir = directory(), target = { destination: "BuildBox", port: 2222, session: "agents" };
  const store = new HerdrProfileState(dir);
  store.approve("id", target);
  store.saveSnapshot("id", { panes: [{ pane_id: "test-pane" }] } as SessionSnapshot);
  store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.approved("id", { session: "agents", port: 2222, destination: "BuildBox" })).toBe(true);
  expect(restored.snapshot("id")?.panes[0]?.pane_id).toBe("test-pane");
  const text = readFileSync(join(dir, "herdr-profile-state.json"), "utf8");
  expect(text).not.toContain("BuildBox");
  expect(text).not.toContain('"enabled"');
  if (process.platform !== "win32") expect(statSync(join(dir, "herdr-profile-state.json")).mode & 0o777).toBe(0o600);
  expect(restored.reconcile("id", { ...target, session: "other" })).toBe(true);
  expect(restored.approved("id", target)).toBe(false);
  expect(restored.snapshot("id")).toBeNull();
  restored.flush();
  expect(new HerdrProfileState(dir).approved("id", target)).toBe(false);
});
it("treats default as the unnamed session but does not merge ports or aliases", () => {
  const store = new HerdrProfileState(directory());
  store.approve("id", { destination: "BuildBox" });
  expect(store.approved("id", { destination: "BuildBox", session: "default" })).toBe(true);
  expect(store.approved("id", { destination: "BuildBox", port: 22 })).toBe(false);
  expect(store.approved("id", { destination: "buildbox" })).toBe(false);
  expect(store.prune(new Set())).toEqual(["id"]);
  expect(store.approved("id", { destination: "BuildBox" })).toBe(false);
});
it("moves a damaged approval file aside, starts with no approvals, and marks the recovery", () => {
  const dir = directory(), path = join(dir, "herdr-profile-state.json");
  spyOn(console, "warn").mockImplementation(() => {});
  for (const data of ['{}', "\0".repeat(6605)]) {
    writeFileSync(path, data);
    const store = new HerdrProfileState(dir);
    expect(store.approved("id", { destination: "BuildBox" })).toBe(false);
    expect(store.recovered).toBe(true);
    expect(existsSync(path)).toBe(false);
  }
  expect(readdirSync(dir).filter((name) => name.startsWith("herdr-profile-state.json.corrupt-"))).toHaveLength(2);
});

it("drops a damaged entry alone: the other approvals survive, and the file is kept as a copy", () => {
  const dir = directory(), path = join(dir, "herdr-profile-state.json"), target = { destination: "BuildBox" };
  const writer = new HerdrProfileState(dir);
  writer.approve("kept", target);
  writer.approve("damaged", target);
  writer.flush();
  const saved = JSON.parse(readFileSync(path, "utf8")) as Array<{ profile_id: string; binding: string }>;
  for (const entry of saved) if (entry.profile_id === "damaged") entry.binding = "bad";
  writeFileSync(path, JSON.stringify(saved));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const restored = new HerdrProfileState(dir);
  expect(restored.approved("kept", target)).toBe(true);
  expect(restored.approved("damaged", target)).toBe(false);
  expect(restored.recovered).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(readdirSync(dir).filter((name) => name.startsWith("herdr-profile-state.json.corrupt-"))).toHaveLength(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("damaged");
});

it("a file that cannot be read is neither moved nor written over, and nothing is saved while it cannot be", () => {
  const dir = directory(), path = join(dir, "herdr-profile-state.json");
  mkdirSync(path);
  spyOn(console, "error").mockImplementation(() => {});
  const store = new HerdrProfileState(dir);
  expect(store.ensureLoaded()).toBe(false);
  store.approve("id", { destination: "BuildBox" });
  store.flush();
  expect(statSync(path).isDirectory()).toBe(true);
  expect(readdirSync(dir)).toEqual(["herdr-profile-state.json"]);
  expect(store.recovered).toBe(false);
});

it("connection consent is separate from installation approval and survives restart", () => {
  const dir = directory(), target = { destination: "BuildBox" };
  const store = new HerdrProfileState(dir);
  store.allowConnection("id", target); store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.connectionApproved("id", target)).toBe(true);
  expect(restored.approved("id", target)).toBe(false);
  expect(() => restored.reconcile("id", { destination: "new" }, () => { throw new Error("cleanup"); })).toThrow("cleanup");
  restored.flush();
  expect(new HerdrProfileState(dir).connectionApproved("id", target)).toBe(false);
});

it("retries a failed key removal when the old target returns, after a restart and after a re-add", () => {
  const dir = directory(), target = { destination: "BuildBox" };
  const failing = () => { throw new Error("cleanup"); };
  let retired = 0;
  const store = new HerdrProfileState(dir);
  store.approve("id", target);
  expect(() => store.reconcile("id", { destination: "new" }, failing)).toThrow("cleanup");
  store.flush();
  const restored = new HerdrProfileState(dir);
  expect(restored.reconcile("id", target, () => { retired++; })).toBe(true);
  expect(retired).toBe(1);
  expect(restored.reconcile("id", target, () => { retired++; })).toBe(false);
  expect(retired).toBe(1);
  restored.approve("id", target);
  expect(() => restored.prune(new Set(), failing)).toThrow("cleanup will retry");
  restored.flush();
  const readded = new HerdrProfileState(dir);
  expect(readded.reconcile("id", target, () => { retired++; })).toBe(true);
  expect(retired).toBe(2);
  expect(readded.approved("id", target)).toBe(false);
  readded.flush();
  expect(readFileSync(join(dir, "herdr-profile-state.json"), "utf8")).not.toContain("retiring");
});
