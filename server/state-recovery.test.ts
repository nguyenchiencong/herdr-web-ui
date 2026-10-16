import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionTracker } from "./completion.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { HerdrProfileState, herdrMachineId } from "./herdr-profile-state.ts";
import { MachineManager } from "./machines.ts";
import { PreferenceStore } from "./preferences.ts";
import { createPushService, type PushService } from "./push.ts";
import { Telemetry } from "./telemetry.ts";
import { VoiceService } from "./voice.ts";

// Each loader of a state file the server reads at startup, against the damage a crash leaves:
// zero-filled, truncated or of the wrong shape. A damaged file is moved aside, never deleted.

const dirs: string[] = [];
afterEach(() => {
  mock.restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "state-recovery-"));
  dirs.push(dir);
  return dir;
}
/** The copies a damaged state file was moved to. */
const kept = (dir: string, name: string): string[] => readdirSync(dir).filter((entry) => entry.startsWith(`${name}.corrupt-`));
const OFFLINE = async (): Promise<never> => { throw new Error("offline"); };

describe("machines.json and machine-settings.json", () => {
  it("a zero-filled registry and a truncated settings file start the manager empty, and are kept", () => {
    const dir = stateDirectory();
    writeFileSync(join(dir, "machines.json"), Buffer.alloc(2));
    writeFileSync(join(dir, "machine-settings.json"), "{\"auto_update_bridges\":");
    spyOn(console, "warn").mockImplementation(() => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, OFFLINE);
    try {
      expect(manager.list().map((machine) => machine.id)).toEqual(["local"]);
      expect(manager.settings()).toEqual({ auto_update_bridges: true });
    } finally { manager.stop(); }
    expect(kept(dir, "machines.json")).toHaveLength(1);
    expect(kept(dir, "machine-settings.json")).toHaveLength(1);
  });

  it("a registration whose SSH target does not validate is dropped alone: the other PCs load, and the file is kept as a copy", () => {
    const dir = stateDirectory();
    const good = "11111111-2222-3333-4444-555555555555", bad = "66666666-7777-8888-9999-000000000000";
    const original = JSON.stringify([
      { id: good, name: "kept", enabled: false, target: { destination: "buildbox" }, snapshot: null },
      { id: bad, name: "pc", enabled: false, target: { destination: "-oProxyCommand=touch /tmp/x" }, snapshot: null },
    ]);
    writeFileSync(join(dir, "machines.json"), original);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, OFFLINE);
    try {
      expect(manager.list().map((machine) => machine.id)).toEqual(["local", good]);
    } finally { manager.stop(); }
    expect(readFileSync(join(dir, "machines.json"), "utf8")).toBe(original);
    expect(kept(dir, "machines.json")).toHaveLength(1);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(bad);
  });
});

describe("preferences.json", () => {
  it("a damaged shared-preferences document is moved aside, and the store starts empty", () => {
    const dir = stateDirectory();
    const path = join(dir, "preferences.json");
    spyOn(console, "warn").mockImplementation(() => {});
    for (const damage of ["\0".repeat(64), "{\"revision\":3,\"settings\":", "{\"settings\":1}"]) {
      writeFileSync(path, damage);
      expect(new PreferenceStore(dir).get()).toEqual({ revision: 0, settings: {} });
      expect(existsSync(path)).toBe(false);
    }
    expect(kept(dir, "preferences.json")).toHaveLength(3);
  });
});

describe("completions.json", () => {
  it("a zero-filled file is moved aside, and the tracker starts empty and saves over it", () => {
    const dir = stateDirectory();
    const path = join(dir, "completions.json");
    spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(path, "\0".repeat(256));
    const tracker = new CompletionTracker(path, () => "herdr-a");
    tracker.observe("p", "working");
    tracker.observe("p", "idle");
    expect(kept(dir, "completions.json")).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ herdr: "herdr-a" });
  });

  it("a file kept for another herdr is not damaged: it is left alone until this herdr saves", () => {
    const dir = stateDirectory();
    const path = join(dir, "completions.json");
    writeFileSync(path, JSON.stringify({ herdr: "herdr-b", finished: [], finishedAgents: {} }));
    new CompletionTracker(path, () => "herdr-a");
    expect(readFileSync(path, "utf8")).toContain("herdr-b");
    expect(kept(dir, "completions.json")).toEqual([]);
  });
});

describe("telemetry.json", () => {
  it("a damaged file is moved aside, and a new install ID is kept", () => {
    const dir = stateDirectory();
    const path = join(dir, "telemetry.json");
    writeFileSync(path, "\0".repeat(128));
    spyOn(console, "warn").mockImplementation(() => {});
    const telemetry = new Telemetry({ stateDir: dir, version: "9.9.9", env: {}, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch });
    expect(telemetry.status()).toMatchObject({ enabled: true, notice_seen: false });
    expect(JSON.parse(readFileSync(path, "utf8")).install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(kept(dir, "telemetry.json")).toHaveLength(1);
  });
});

describe("voice.json", () => {
  it("a damaged key file is moved aside, the service reads no key, and a new key saves over it", () => {
    const dir = stateDirectory();
    const path = join(dir, "voice.json");
    writeFileSync(path, "{\"api_key\":\"sk-test-damaged");
    spyOn(console, "warn").mockImplementation(() => {});
    const voice = new VoiceService({ stateDir: dir, env: {}, fetch: async () => new Response(null, { status: 204 }) });
    expect(voice.status()).toMatchObject({ configured: false, source: null });
    expect(existsSync(path)).toBe(false);
    expect(kept(dir, "voice.json")).toHaveLength(1);
    voice.update({ api_key: "sk-test-fresh" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ api_key: "sk-test-fresh" });
    expect(voice.status()).toMatchObject({ configured: true, source: "file" });
  });
});

describe("push-subscriptions.json, push-retired.json and vapid.json", () => {
  it("a damaged subscription list and retired list are moved aside, and a device subscribes again", () => {
    const dir = stateDirectory();
    spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(join(dir, "push-subscriptions.json"), "[{\"endpoint\":");
    writeFileSync(join(dir, "push-retired.json"), "\0".repeat(64));
    const push = createPushService({ stateDir: dir, loopbackHttp: true });
    expect(push.retired("https://push.example.test/gone")).toBe(false);
    const subscription = push.parse({ endpoint: "https://push.example.test/live", keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 5).toString("base64url") } });
    push.subscribe(subscription!);
    const saved = JSON.parse(readFileSync(join(dir, "push-subscriptions.json"), "utf8")) as Array<{ endpoint: string }>;
    expect(saved.map((entry) => entry.endpoint)).toEqual(["https://push.example.test/live"]);
    expect(kept(dir, "push-subscriptions.json")).toHaveLength(1);
    expect(kept(dir, "push-retired.json")).toHaveLength(1);
  });

  it("a malformed VAPID key is refused and never replaced, since a new key would orphan every device", () => {
    const dir = stateDirectory();
    writeFileSync(join(dir, "vapid.json"), "{}\n");
    expect(() => createPushService({ stateDir: dir, loopbackHttp: true }).publicKey()).toThrow("malformed");
    expect(readFileSync(join(dir, "vapid.json"), "utf8")).toBe("{}\n");
    expect(kept(dir, "vapid.json")).toEqual([]);
  });
});

describe("devices.json", () => {
  it("a zero-filled device registry stays gated and is kept as it was, not moved aside", () => {
    const dir = stateDirectory();
    const path = join(dir, "devices.json");
    writeFileSync(path, "\0".repeat(64));
    spyOn(console, "error").mockImplementation(() => {});
    const store = new DeviceStore(dir);
    expect(store.gated).toBe(true);
    expect(store.error).not.toBeNull();
    expect(readFileSync(path, "utf8")).toBe("\0".repeat(64));
    expect(kept(dir, "devices.json")).toEqual([]);
  });
});

describe("a state file that cannot be read yet", () => {
  // A directory in the file's place reads as EISDIR: that is not damage, so nothing is moved aside or written over it.
  const blocked = (dir: string, name: string): string => {
    const path = join(dir, name);
    mkdirSync(path);
    return path;
  };
  const untouched = (dir: string, path: string, name: string): void => {
    expect(statSync(path).isDirectory()).toBe(true);
    expect(kept(dir, name)).toEqual([]);
    expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  };

  it("machines.json and machine-settings.json: the manager starts empty, refuses a new PC and a setting, and writes neither", () => {
    const dir = stateDirectory();
    const registry = blocked(dir, "machines.json");
    const settings = blocked(dir, "machine-settings.json");
    spyOn(console, "error").mockImplementation(() => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, OFFLINE);
    try {
      expect(manager.list().map((machine) => machine.id)).toEqual(["local"]);
      expect(() => manager.setup({ destination: "buildbox" })).toThrow("could not be read");
      expect(() => manager.updateSettings({ auto_update_bridges: false })).toThrow("could not be read");
    } finally { manager.stop(); }
    untouched(dir, registry, "machines.json");
    expect(statSync(settings).isDirectory()).toBe(true);
  });

  it("herdr-profile-state.json: no herdr PC appears, and nothing is written over the file", () => {
    const dir = stateDirectory();
    const path = blocked(dir, "herdr-profile-state.json");
    spyOn(console, "error").mockImplementation(() => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, OFFLINE);
    try {
      manager.syncHerdrProfiles([{ id: "profile-1", label: "BuildBox", enabled: true, target: { destination: "buildbox" } }]);
      expect(manager.list().map((machine) => machine.id)).toEqual(["local"]);
    } finally { manager.stop(); }
    untouched(dir, path, "herdr-profile-state.json");
  });

  it("preferences.json: the store starts empty, and a change is refused rather than written over the file", () => {
    const dir = stateDirectory();
    const path = blocked(dir, "preferences.json");
    spyOn(console, "error").mockImplementation(() => {});
    const store = new PreferenceStore(dir);
    expect(store.get()).toEqual({ revision: 0, settings: {} });
    expect(() => store.set({ settings: { showThinking: false } })).toThrow();
    untouched(dir, path, "preferences.json");
  });

  it("completions.json: the tracker starts empty and saves nothing while the file cannot be read", () => {
    const dir = stateDirectory();
    const path = blocked(dir, "completions.json");
    spyOn(console, "error").mockImplementation(() => {});
    const tracker = new CompletionTracker(path, () => "herdr-a");
    tracker.observe("p", "working");
    tracker.observe("p", "idle");
    untouched(dir, path, "completions.json");
  });

  it("telemetry.json: nothing is sent, changed or saved while the file cannot be read", async () => {
    const dir = stateDirectory();
    const path = blocked(dir, "telemetry.json");
    spyOn(console, "error").mockImplementation(() => {});
    let sent = 0;
    const telemetry = new Telemetry({ stateDir: dir, version: "9.9.9", env: {}, fetch: (async () => { sent++; return new Response(null, { status: 204 }); }) as unknown as typeof fetch });
    await telemetry.report();
    expect(sent).toBe(0);
    expect(() => telemetry.change({ enabled: false })).toThrow("could not be read");
    untouched(dir, path, "telemetry.json");
  });

  it("voice.json: the key file is neither read as absent nor replaced", () => {
    const dir = stateDirectory();
    const path = blocked(dir, "voice.json");
    spyOn(console, "error").mockImplementation(() => {});
    const voice = new VoiceService({ stateDir: dir, env: {}, fetch: async () => new Response(null, { status: 204 }) });
    expect(() => voice.status()).toThrow();
    expect(() => voice.update({ api_key: "sk-test-fresh" })).toThrow();
    untouched(dir, path, "voice.json");
  });

  it("push-subscriptions.json: a subscription is refused and the list is not replaced", () => {
    const dir = stateDirectory();
    const path = blocked(dir, "push-subscriptions.json");
    const push = createPushService({ stateDir: dir, loopbackHttp: true });
    const subscription = push.parse({ endpoint: "https://push.example.test/live", keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 5).toString("base64url") } });
    expect(() => push.subscribe(subscription!)).toThrow();
    untouched(dir, path, "push-subscriptions.json");
  });

  it("push-retired.json: a read that fails throws, is not cached as empty, and is read again once it can be", () => {
    const dir = stateDirectory();
    const path = blocked(dir, "push-retired.json");
    const push = createPushService({ stateDir: dir, loopbackHttp: true });
    const gone = "https://push.example.test/gone";
    expect(() => push.retired(gone)).toThrow();
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify([{ hash: createHash("sha256").update(gone).digest("base64url"), at: Date.now() }]));
    expect(push.retired(gone)).toBe(true);
  });
});

describe("a damaged herdr-profile-state.json", () => {
  const keyPath = (dir: string, id: string): string => join(dir, "ssh", id);
  const writeKey = (dir: string, id: string): void => {
    mkdirSync(join(dir, "ssh"), { recursive: true });
    writeFileSync(keyPath(dir, id), "private");
    writeFileSync(`${keyPath(dir, id)}.pub`, "public");
  };
  const hasKey = (dir: string, id: string): boolean => existsSync(keyPath(dir, id)) || existsSync(`${keyPath(dir, id)}.pub`);

  it("removes the keys of saved herdr PCs whose approval was lost, and keeps a manual PC's key", () => {
    const dir = stateDirectory();
    const manual = "11111111-2222-3333-4444-555555555555";
    const herdr = herdrMachineId("profile-1");
    writeFileSync(join(dir, "machines.json"), JSON.stringify([{ id: manual, name: "pc", enabled: false, target: { destination: "pc" }, snapshot: null }]));
    writeKey(dir, manual);
    writeKey(dir, herdr);
    writeFileSync(join(dir, "herdr-profile-state.json"), "\0".repeat(64));
    spyOn(console, "warn").mockImplementation(() => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, OFFLINE);
    manager.stop();
    expect(hasKey(dir, herdr)).toBe(false);
    expect(hasKey(dir, manual)).toBe(true);
    expect(kept(dir, "herdr-profile-state.json")).toHaveLength(1);
  });

  it("keeps the key of a saved PC whose approval survived the damage, and removes the key of an entry that was dropped", () => {
    const dir = stateDirectory();
    const target = { destination: "buildbox" };
    const writer = new HerdrProfileState(dir);
    writer.approve("kept", target);
    writer.approve("damaged", target);
    writer.flush();
    const path = join(dir, "herdr-profile-state.json");
    const saved = JSON.parse(readFileSync(path, "utf8")) as Array<{ profile_id: string; binding: string }>;
    for (const entry of saved) if (entry.profile_id === "damaged") entry.binding = "bad";
    writeFileSync(path, JSON.stringify(saved));
    writeKey(dir, herdrMachineId("kept"));
    writeKey(dir, herdrMachineId("damaged"));
    spyOn(console, "warn").mockImplementation(() => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, OFFLINE);
    manager.stop();
    expect(hasKey(dir, herdrMachineId("kept"))).toBe(true);
    expect(hasKey(dir, herdrMachineId("damaged"))).toBe(false);
  });

  it("waits for machines.json to be read before it removes a key", () => {
    const dir = stateDirectory();
    const herdr = herdrMachineId("profile-1");
    const registry = join(dir, "machines.json");
    mkdirSync(registry);
    writeKey(dir, herdr);
    writeFileSync(join(dir, "herdr-profile-state.json"), "\0".repeat(64));
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    const manager = new MachineManager(dir, {} as PushService, {} as CompletionTracker, OFFLINE);
    try {
      manager.syncHerdrProfiles([]);
      expect(hasKey(dir, herdr)).toBe(true);
      rmSync(registry, { recursive: true });
      manager.syncHerdrProfiles([]);
      expect(hasKey(dir, herdr)).toBe(false);
    } finally { manager.stop(); }
  });
});

describe("startup", () => {
  it("the server starts over a zero-filled herdr-profile-state.json and machines.json, and keeps both", async () => {
    const stateDir = stateDirectory();
    writeFileSync(join(stateDir, "herdr-profile-state.json"), Buffer.alloc(6605));
    writeFileSync(join(stateDir, "machines.json"), Buffer.alloc(2));
    spyOn(console, "warn").mockImplementation(() => {});
    // a socket that does not exist: no herdr answers, the user's session is never reached
    const socket = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = join(stateDir, "no-herdr.sock");
    let server: ReturnType<typeof createServer> | undefined;
    try {
      server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, registerBridge: false });
      // scope=bridge answers without asking herdr, so it shows the server is up with no herdr behind it
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true });
    } finally {
      server?.stop();
      if (socket === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = socket;
    }
    expect(kept(stateDir, "herdr-profile-state.json")).toHaveLength(1);
    expect(kept(stateDir, "machines.json")).toHaveLength(1);
  });
});
